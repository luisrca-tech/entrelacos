import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SiteAccess } from "@entrelacos/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  databaseTimestampEpochMicroseconds,
  readDatabaseTimestamp,
} from "./databaseTimestamp";
import {
  assertRecipientFinancialAction,
  type FinancialActor,
  type FinancialRecipientBinding,
  type RecentFinancialAuthenticationEvidence,
} from "./financialAuthorization";
import type { ReceivingAuthenticationEvidence } from "./receivingNomination";
import {
  createReceivingNominationService,
  deriveReceivingNominationRequestId,
  type ReceivingNominationAdmissionAuthority,
  type ReceivingNominationAdmissionContext,
  type ReceivingNominationAdmissionFrame,
  type ReceivingNominationCurrentAuthorization,
  type ReceivingNominationLockedState,
  type ReceivingNominationOptions,
  ReceivingNominationServiceError,
  type ReceivingNominationSnapshot,
  readReceivingNominationSnapshot,
} from "./receivingNomination";

const now = new Date("2026-10-12T12:00:00.000Z");

describe("canonical nomination first request identity", () => {
  const scope = {
    siteId: "site-1",
    operatorUserId: "operator-1",
    environment: "sandbox" as const,
  };
  it("uses the entire non-secret SHA256 tuple digest independent of session and policy", () => {
    expect(deriveReceivingNominationRequestId(scope)).toBe(
      "nr1_rtG0OLUHajcG65fiQAt5LgqONiV-A0x7X4AWQFDTOyQ",
    );
    expect(deriveReceivingNominationRequestId({ ...scope })).toBe(
      deriveReceivingNominationRequestId(scope),
    );
  });
  it.each([
    { siteId: "other" },
    { operatorUserId: "other" },
    { environment: "live" },
  ])("separates immutable scope %j", (change) => {
    expect(
      deriveReceivingNominationRequestId({
        ...scope,
        ...change,
      } as typeof scope),
    ).not.toBe(deriveReceivingNominationRequestId(scope));
  });
});

describe("private provisioning snapshot projection", () => {
  async function wrapper() {
    const original = await nominate(fixture());
    return {
      version: "receiving.account-provisioning.v1",
      nomination: original,
      provision: {
        provider: "ASAAS",
        siteId: original.siteId,
        accountId: original.accountId,
        operationId: original.operationId,
        requestId: original.requestId,
        operatorUserId: original.operatorUserId,
        environment: original.environment,
        policyVersion: original.policyVersion,
        parentAccountReference: "fictional-parent",
        fingerprintVersion: "hkdf-hmac-sha256-v1",
        fingerprintKeyId: "fingerprint-v1",
        inputFingerprint: "a".repeat(64),
        dispatch: {
          leaseOwner: "owner-one",
          leaseToken: "token-one",
          leaseExpiresAtMicroseconds: (
            BigInt(now.getTime()) * 1000n +
            60000000n
          ).toString(),
          possibleDispatch: false,
        },
      },
      sealedResult: null as unknown,
    };
  }
  it("projects only unchanged nomination, hash and audit from the strict private record", async () => {
    const record = await wrapper();
    expect(readReceivingNominationSnapshot(record)).toEqual(record.nomination);
    expect(JSON.stringify(readReceivingNominationSnapshot(record))).not.toMatch(
      /parent|fingerprint|sealedResult|leaseToken/,
    );
    expect(readReceivingNominationSnapshot(record.nomination)).toEqual(
      record.nomination,
    );
  });
  it("projects the original nomination after private encrypted result custody", async () => {
    const record = await wrapper();
    record.provision.dispatch.possibleDispatch = true;
    record.sealedResult = {
      accountReference: "fictional-child",
      recipientReference: "fictional-wallet",
      credential: {
        version: 1,
        keyId: "credential-v1",
        nonce: Buffer.alloc(12, 1).toString("base64url"),
        ciphertext: Buffer.alloc(32, 2).toString("base64url"),
        tag: Buffer.alloc(16, 3).toString("base64url"),
      },
    };
    expect(readReceivingNominationSnapshot(record)).toEqual(record.nomination);
  });
  it.each([
    "siteId",
    "accountId",
    "operationId",
    "requestId",
    "operatorUserId",
    "environment",
    "policyVersion",
  ])("rejects conflicting private %s", async (field) => {
    const record = await wrapper();
    Object.assign(record.provision, { [field]: "foreign" });
    expect(() => readReceivingNominationSnapshot(record)).toThrow(
      ReceivingNominationServiceError,
    );
  });
  it.each(["version", "provision", "dispatch", "secret", "recursive"])(
    "rejects malformed, extra or nested private %s",
    async (caseName) => {
      const record = await wrapper();
      if (caseName === "version") record.version = "unknown-v2";
      if (caseName === "provision")
        Object.assign(record.provision, { rawCpf: "fictional" });
      if (caseName === "dispatch")
        record.provision.dispatch.leaseExpiresAtMicroseconds = "1.000";
      if (caseName === "secret")
        Object.assign(record, { apiKey: "fictional-secret" });
      if (caseName === "recursive")
        Object.assign(record, { nomination: { ...record } });
      expect(() => readReceivingNominationSnapshot(record)).toThrow(
        ReceivingNominationServiceError,
      );
    },
  );
});

const admissionPolicy = Object.freeze({
  issuerId: "fixture-issuer",
  issuerVersion: "issuer-v1",
  disclosureId: "fixture-disclosure",
  disclosureVersion: "disclosure-v1",
});
// These independently pinned fixture records exist before any adapter receives an actor.
function independentCustody() {
  const records: ReceivingNominationAdmissionAuthority[] = [];
  for (const identity of [
    { userId: "operator-1", sessionId: "session-1" },
    { userId: "operator.one:1", sessionId: "session.one:1" },
  ])
    for (const environment of ["sandbox", "live"] as const)
      for (const proofKind of [
        "PASSWORD_REAUTHENTICATION",
        "MFA_REAUTHENTICATION",
      ] as const) {
        const requestId = deriveReceivingNominationRequestId({
          siteId: "site-1",
          operatorUserId: identity.userId,
          environment,
        });
        const actor = { siteId: "site-1", ...identity };
        const draft: ReceivingNominationSnapshot = {
          state: "AWAITING_PROVIDER_VERIFICATION",
          siteId: "site-1",
          requestId,
          operatorUserId: identity.userId,
          environment,
          policyVersion: "receiving-intent-v1",
          accountId: "account-1",
          operationId: "operation-1",
          createdAt: now.toISOString(),
          requestHash: createHash("sha256")
            .update(
              JSON.stringify([
                "receiving.self-nomination.v1",
                "site-1",
                requestId,
                identity.userId,
                environment,
                "receiving-intent-v1",
                true,
              ]),
            )
            .digest("hex"),
          authentication: {
            ...actor,
            proofKind,
            authenticatedAt: "2026-10-12T11:59:30.000Z",
            expiresAt: "2026-10-12T12:04:30.000Z",
          },
        };
        records.push({
          version: "receiving.new-admission.v1",
          ...admissionPolicy,
          holderUserId: identity.userId,
          authorityId: "fixture-authority",
          authorityVersion: "authority-v1",
          consentId: "fixture-consent",
          consentVersion: "consent-v1",
          custodyId: "fixture-custody",
          custodyVersion: "custody-v1",
          issuedAt: "2026-10-12T11:59:30.000Z",
          expiresAt: "2026-10-12T12:04:30.000Z",
          context: {
            draft,
            actor,
            input: {
              requestId,
              confirmSelfAsRecipient: true,
              policyVersion: "receiving-intent-v1",
            },
            applicationEnvironment:
              environment === "live" ? "production" : "test",
          },
        });
      }
  return records;
}

function fixture() {
  const actor: FinancialActor = {
    userId: "operator-1",
    siteId: "site-1",
    sessionId: "session-1",
  };
  const access: SiteAccess = {
    siteId: "site-1",
    userId: "operator-1",
    membershipId: "membership-1",
    membershipRole: "SITE_ADMIN",
    capabilities: {
      manageInvitations: true,
      manageMessages: true,
      manageCatalog: true,
      manageTeam: true,
      readFinance: true,
      configureReceiving: true,
      requestWithdrawal: false,
    },
  };
  const recentAuth: ReceivingAuthenticationEvidence = {
    ...actor,
    proofKind: "PASSWORD_REAUTHENTICATION",
    verification: "verified",
    provenance: "backend",
    authenticatedAt: new Date("2026-10-12T11:59:30.000Z"),
    expiresAt: new Date("2026-10-12T12:04:30.000Z"),
  };
  const input = {
    requestId: "nr1_rtG0OLUHajcG65fiQAt5LgqONiV-A0x7X4AWQFDTOyQ",
    confirmSelfAsRecipient: true,
    policyVersion: "receiving-intent-v1",
  };
  const locked: ReceivingNominationLockedState = {
    access: structuredClone(access),
    currentSession: { ...actor },
    designatedOperatorUserId: null,
    hasProviderBinding: false,
  };
  const loadSite = vi
    .fn()
    .mockResolvedValue({ siteId: "site-1", isDemo: true });
  const findByRequest = vi.fn().mockResolvedValue(null);
  const readNominationScope = vi.fn().mockResolvedValue(null);
  const reserveNomination = vi.fn(
    async (
      snapshot: ReceivingNominationSnapshot,
      authorize: (state: ReceivingNominationLockedState) => Promise<void>,
      _authorization: ReceivingNominationCurrentAuthorization,
      admission?: ReceivingNominationAdmissionFrame,
    ) => {
      await authorize(locked);
      if (locked.designatedOperatorUserId === null && admission === undefined)
        throw new ReceivingNominationServiceError(
          503,
          "RECEIVING_NOMINATION_UNAVAILABLE",
        );
      return snapshot;
    },
  );
  const custody = independentCustody();
  const readAuthority = vi.fn(
    async (context: ReceivingNominationAdmissionContext): Promise<unknown> => {
      const record = custody.find((stored) =>
        isDeepStrictEqual(stored.context, context),
      );
      return record === undefined ? null : structuredClone(record);
    },
  );
  const generateId = vi.fn((kind: "account" | "operation") => `${kind}-1`);
  const options: ReceivingNominationOptions = {
    mode: "sandbox",
    applicationEnvironment: "test",
    policyVersion: "receiving-intent-v1",
    maxAuthAgeMs: 300_000,
    now: () => new Date(now),
    generateId,
    loadSite,
    repository: { findByRequest, readNominationScope, reserveNomination },
    admission: { ...admissionPolicy, readAuthority },
  };
  return {
    options,
    actor,
    access,
    recentAuth,
    input,
    locked,
    loadSite,
    findByRequest,
    readNominationScope,
    reserveNomination,
    generateId,
    custody,
    readAuthority,
  };
}

async function nominate(values: ReturnType<typeof fixture>) {
  return createReceivingNominationService(values.options).nominate({
    actor: values.actor,
    access: values.access,
    recentAuth: values.recentAuth,
    input: values.input,
  });
}

async function denied(
  action: Promise<unknown>,
  code: ReceivingNominationServiceError["code"],
  status: number,
) {
  const error = await action.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ReceivingNominationServiceError);
  expect(error).toMatchObject({
    code,
    status,
    message: "Receiving nomination cannot be recorded",
  });
  expect(error).not.toHaveProperty("cause");
  return error;
}

describe("explicit initial receiving nomination", () => {
  it("keeps real session authentication and SQL timestamp precision without claiming password confirmation", async () => {
    const values = fixture();
    Object.assign(values.recentAuth, {
      proofKind: "SESSION_AUTHENTICATION",
      authenticatedAt: readDatabaseTimestamp("2026-10-12T11:00:00.123456Z"),
      expiresAt: readDatabaseTimestamp("2026-10-19T11:00:00.123456Z"),
    });
    const record = values.custody.find(
      (entry) =>
        entry.context.draft.environment === "sandbox" &&
        entry.context.actor.userId === values.actor.userId,
    );
    if (!record) throw new Error("Missing independent fixture authority");
    Object.assign(record.context.draft.authentication, {
      proofKind: "SESSION_AUTHENTICATION",
      authenticatedAt: "2026-10-12T11:00:00.123456Z",
      expiresAt: "2026-10-19T11:00:00.123456Z",
    });
    const result = await nominate(values);
    expect(result.authentication).toMatchObject({
      proofKind: "SESSION_AUTHENTICATION",
      authenticatedAt: "2026-10-12T11:00:00.123456Z",
      expiresAt: "2026-10-19T11:00:00.123456Z",
    });
    const authorization = values.reserveNomination.mock.calls[0][2];
    expect(
      databaseTimestampEpochMicroseconds(
        authorization.recentAuth.authenticatedAt,
      ),
    ).toBe(
      databaseTimestampEpochMicroseconds(values.recentAuth.authenticatedAt),
    );
  });
  it("rejects a non-canonical request in a proven empty scope before ID generation or reservation", async () => {
    const v = fixture();
    v.input.requestId = "random-first-request";
    await denied(nominate(v), "REQUEST_CONFLICT", 409);
    expect(v.readNominationScope).toHaveBeenCalledExactlyOnceWith({
      siteId: "site-1",
      operatorUserId: "operator-1",
      environment: "sandbox",
    });
    expect(v.generateId).not.toHaveBeenCalled();
    expect(v.reserveNomination).not.toHaveBeenCalled();
  });
  it("never treats a failed scope reader as empty", async () => {
    const v = fixture();
    v.readNominationScope.mockRejectedValue(new Error("private SQL"));
    await denied(nominate(v), "RECEIVING_NOMINATION_UNAVAILABLE", 503);
    expect(v.generateId).not.toHaveBeenCalled();
    expect(v.reserveNomination).not.toHaveBeenCalled();
  });
  it("keeps a stored legacy ID and audit during exact replay", async () => {
    const v = fixture();
    const original = await nominate(v);
    const legacy = {
      ...original,
      requestId: "legacy-request",
      requestHash: createHash("sha256")
        .update(
          JSON.stringify([
            "receiving.self-nomination.v1",
            original.siteId,
            "legacy-request",
            original.operatorUserId,
            original.environment,
            original.policyVersion,
            true,
          ]),
        )
        .digest("hex"),
    };
    v.input.requestId = legacy.requestId;
    v.findByRequest.mockResolvedValue(legacy);
    v.locked.designatedOperatorUserId = v.actor.userId;
    v.generateId.mockClear();
    v.readNominationScope.mockClear();
    expect(await nominate(v)).toEqual(legacy);
    expect(v.generateId).not.toHaveBeenCalled();
    expect(v.readNominationScope).not.toHaveBeenCalled();
  });
  it("exports one canonical immutable snapshot reader for the durable adapter", async () => {
    const values = fixture();
    const snapshot = await createReceivingNominationService(
      values.options,
    ).nominate({
      actor: values.actor,
      access: values.access,
      recentAuth: values.recentAuth,
      input: values.input,
    });
    const read = readReceivingNominationSnapshot(structuredClone(snapshot));
    expect(read).toEqual(snapshot);
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(read.authentication)).toBe(true);
    for (const corrupt of [
      { ...snapshot, requestHash: "0".repeat(64) },
      { ...snapshot, state: "READY" },
      { ...snapshot, accountReference: null },
      {
        ...snapshot,
        authentication: {
          ...snapshot.authentication,
          expiresAt: "2026-10-12T12:04:30.001Z",
        },
      },
    ]) {
      expect(() => readReceivingNominationSnapshot(corrupt)).toThrow(
        ReceivingNominationServiceError,
      );
    }
  });

  it("records only a self-nomination after locked current membership/session authorization", async () => {
    const values = fixture();
    const result = await createReceivingNominationService(
      values.options,
    ).nominate({
      actor: values.actor,
      access: values.access,
      recentAuth: values.recentAuth,
      input: values.input,
    });
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify([
          "receiving.self-nomination.v1",
          "site-1",
          values.input.requestId,
          "operator-1",
          "sandbox",
          "receiving-intent-v1",
          true,
        ]),
        "utf8",
      )
      .digest("hex");
    expect(result).toEqual({
      state: "AWAITING_PROVIDER_VERIFICATION",
      siteId: "site-1",
      requestId: values.input.requestId,
      operatorUserId: "operator-1",
      environment: "sandbox",
      policyVersion: "receiving-intent-v1",
      accountId: "account-1",
      operationId: "operation-1",
      createdAt: now.toISOString(),
      requestHash,
      authentication: {
        ...values.actor,
        proofKind: "PASSWORD_REAUTHENTICATION",
        authenticatedAt: "2026-10-12T11:59:30.000Z",
        expiresAt: "2026-10-12T12:04:30.000Z",
      },
    });
    expect(values.loadSite).toHaveBeenCalledExactlyOnceWith("site-1");
    expect(values.findByRequest).toHaveBeenCalledExactlyOnceWith(
      "site-1",
      values.input.requestId,
    );
    expect(values.reserveNomination).toHaveBeenCalledTimes(1);
    expect(values.generateId.mock.calls).toEqual([["account"], ["operation"]]);
    expect(JSON.stringify(result)).not.toMatch(
      /accountReference|recipientReference|bank|credential|password|https:|READY/,
    );
  });

  it("uses generic C1 user/session IDs while retaining strict actual site identity", async () => {
    const values = fixture();
    values.actor.userId = "operator.one:1";
    values.actor.sessionId = "session.one:1";
    values.access.userId = values.actor.userId;
    Object.assign(values.recentAuth, values.actor);
    values.locked.access = structuredClone(values.access);
    values.locked.currentSession = { ...values.actor };
    values.input.requestId = deriveReceivingNominationRequestId({
      siteId: values.actor.siteId,
      operatorUserId: values.actor.userId,
      environment: values.options.mode,
    });
    const result = await nominate(values);
    expect(result.operatorUserId).toBe("operator.one:1");
    expect(result.authentication.sessionId).toBe("session.one:1");
    expect(readReceivingNominationSnapshot(result)).toEqual(result);
  });

  it("allows a selected configureReceiving admin with no readFinance or withdrawal role grant", async () => {
    const values = fixture();
    values.access.capabilities.readFinance = false;
    values.locked.access = structuredClone(values.access);
    expect((await nominate(values)).state).toBe(
      "AWAITING_PROVIDER_VERIFICATION",
    );
  });

  it("accepts backend verified recent MFA without creating provider approval", async () => {
    const values = fixture();
    values.recentAuth.proofKind = "MFA_REAUTHENTICATION";
    expect((await nominate(values)).authentication.proofKind).toBe(
      "MFA_REAUTHENTICATION",
    );
  });

  it("does not turn nomination into a designated verified financial recipient", async () => {
    const values = fixture();
    const snapshot = await nominate(values);
    expect(() =>
      assertRecipientFinancialAction({
        action: "CONFIGURE_RECEIVING",
        siteId: "site-1",
        environment: "sandbox",
        actor: values.actor,
        access: values.access,
        recentAuth: values.recentAuth as RecentFinancialAuthenticationEvidence,
        recipientBinding: snapshot as unknown as FinancialRecipientBinding,
        now,
        maxAuthAgeMs: 300_000,
      }),
    ).toThrow(expect.objectContaining({ code: "RECIPIENT_REQUIRED" }));
  });

  it.each([
    { confirmSelfAsRecipient: false },
    { confirmSelfAsRecipient: undefined },
    { requestId: "" },
    { policyVersion: "another-version" },
    { actor: { userId: "other" } },
    { operatorUserId: "other" },
    { siteId: "other" },
    { accountId: "other" },
    { accountReference: "remote" },
    { provider: "ASAAS" },
    { approval: true },
    { credentials: "private" },
    { reauthenticationToken: "private" },
    { acceptedTerms: true },
  ])(
    "rejects missing confirmation, policy mismatch and client authority claims: %j",
    async (overrides) => {
      const values = fixture();
      Object.assign(values.input, overrides);
      await denied(nominate(values), "NOMINATION_INVALID", 400);
      expect(values.loadSite).not.toHaveBeenCalled();
      expect(values.reserveNomination).not.toHaveBeenCalled();
    },
  );

  it.each([
    { membershipRole: "SITE_ASSISTANT" },
    { membershipRole: "OWNER" },
    { membershipId: null },
    { siteId: "foreign" },
    { userId: "foreign" },
    {
      capabilities: {
        manageInvitations: true,
        manageMessages: true,
        manageCatalog: true,
        manageTeam: true,
        readFinance: true,
        configureReceiving: false,
        requestWithdrawal: true,
      },
    },
  ])(
    "denies missing selected admin authority before looking up stored requests: %j",
    async (overrides) => {
      const values = fixture();
      Object.assign(values.access, overrides);
      await denied(nominate(values), "MEMBERSHIP_DENIED", 403);
      expect(values.findByRequest).not.toHaveBeenCalled();
      expect(values.reserveNomination).not.toHaveBeenCalled();
    },
  );

  it.each([
    { userId: "foreign" },
    { siteId: "foreign" },
    { sessionId: "foreign" },
    { verification: "unverified" },
    { provenance: "browser" },
    { proofKind: "SESSION_CREATION" },
    { authenticatedAt: null },
    { expiresAt: null },
    { authenticatedAt: new Date("invalid") },
    { authenticatedAt: now.toISOString() },
    { authenticatedAt: new Date(now.getTime() + 1) },
    { expiresAt: new Date(now) },
    { expiresAt: new Date("2026-10-12T12:04:30.001Z") },
    { authenticatedAt: new Date(now.getTime() - 300_001) },
    { approved: true },
  ])(
    "rejects spoofed, stale, future, overlong or different-session proof: %j",
    async (overrides) => {
      const values = fixture();
      Object.assign(values.recentAuth, overrides);
      await denied(nominate(values), "RECENT_AUTH_REQUIRED", 403);
      expect(values.loadSite).not.toHaveBeenCalled();
      expect(values.reserveNomination).not.toHaveBeenCalled();
    },
  );

  it.each(["site", "request", "locked", "commit"])(
    "rechecks proof expiry after %s await",
    async (stage) => {
      const values = fixture();
      let current = new Date(now);
      values.options.now = () => new Date(current);
      const expire = () => {
        current = new Date("2026-10-12T12:04:30.000Z");
      };
      if (stage === "site")
        values.loadSite.mockImplementationOnce(async () => {
          expire();
          return { siteId: "site-1", isDemo: true };
        });
      if (stage === "request")
        values.findByRequest.mockImplementationOnce(async () => {
          expire();
          return null;
        });
      if (stage === "locked")
        values.reserveNomination.mockImplementationOnce(
          async (snapshot, authorize) => {
            expire();
            await authorize(values.locked);
            return snapshot;
          },
        );
      if (stage === "commit")
        values.reserveNomination.mockImplementationOnce(
          async (snapshot, authorize) => {
            await authorize(values.locked);
            expire();
            return snapshot;
          },
        );
      await denied(nominate(values), "RECENT_AUTH_REQUIRED", 403);
    },
  );

  it.each(["membership", "capability", "session", "crosssite"])(
    "rejects asynchronous current %s revocation under the repository lock",
    async (stage) => {
      const values = fixture();
      values.reserveNomination.mockImplementationOnce(
        async (snapshot, authorize) => {
          if (stage === "membership")
            (values.locked.access as SiteAccess).membershipId = null;
          if (stage === "capability")
            (
              values.locked.access as SiteAccess
            ).capabilities.configureReceiving = false;
          if (stage === "session") values.locked.currentSession = null;
          if (stage === "crosssite")
            values.locked.currentSession = {
              ...values.actor,
              siteId: "foreign",
            };
          await authorize(values.locked);
          return snapshot;
        },
      );
      await denied(nominate(values), "MEMBERSHIP_DENIED", 403);
    },
  );

  it.each(["other", "operator-1"])(
    "refuses a new request that would substitute an existing active nominee %s",
    async (operator) => {
      const values = fixture();
      values.locked.designatedOperatorUserId = operator;
      await denied(nominate(values), "RECIPIENT_CONFLICT", 409);
    },
  );

  it("refuses existing provider binding even for the same selected administrator", async () => {
    const values = fixture();
    values.locked.designatedOperatorUserId = values.actor.userId;
    values.locked.hasProviderBinding = true;
    await denied(nominate(values), "RECEIVING_BINDING_EXISTS", 409);
  });

  it("replays the exact intent under fresh same-user/new-session authorization with original immutable audit", async () => {
    const values = fixture();
    const original = await nominate(values);
    values.findByRequest.mockResolvedValueOnce(original);
    values.generateId.mockClear();
    values.actor.sessionId = "session-2";
    values.locked.currentSession = { ...values.actor };
    values.locked.designatedOperatorUserId = values.actor.userId;
    values.recentAuth.sessionId = "session-2";
    values.recentAuth.authenticatedAt = new Date("2026-10-12T12:00:30.000Z");
    values.recentAuth.expiresAt = new Date("2026-10-12T12:05:30.000Z");
    values.options.now = () => new Date("2026-10-12T12:01:00.000Z");
    const replay = await nominate(values);
    expect(replay).toEqual(original);
    expect(replay.authentication.sessionId).toBe("session-1");
    expect(values.generateId).not.toHaveBeenCalled();
    const currentAuthorization = values.reserveNomination.mock.calls[1][2];
    expect(currentAuthorization.actor).toEqual(values.actor);
    expect(currentAuthorization.recentAuth).toEqual(values.recentAuth);
    expect(currentAuthorization.actor).not.toBe(values.actor);
    expect(currentAuthorization.recentAuth.authenticatedAt).not.toBe(
      values.recentAuth.authenticatedAt,
    );
  });

  it("cannot use the original replay audit session in place of the currently active session", async () => {
    const values = fixture();
    const original = await nominate(values);
    values.findByRequest.mockResolvedValueOnce(original);
    values.locked.designatedOperatorUserId = values.actor.userId;
    values.actor.sessionId = "session-2";
    values.recentAuth.sessionId = "session-2";
    await denied(nominate(values), "MEMBERSHIP_DENIED", 403);
  });

  it.each(["operator", "environment", "policy"])(
    "rejects a valid stored request collision from another %s",
    async (scenario) => {
      const values = fixture();
      const original = await nominate(values);
      values.findByRequest.mockResolvedValueOnce(original);
      values.reserveNomination.mockClear();
      if (scenario === "operator") {
        values.actor.userId = "other-user";
        values.access.userId = "other-user";
        values.recentAuth.userId = "other-user";
      }
      if (scenario === "environment") {
        values.options.mode = "live";
        values.options.applicationEnvironment = "production";
        values.loadSite.mockResolvedValue({ siteId: "site-1", isDemo: false });
      }
      if (scenario === "policy") {
        values.options.policyVersion = "receiving-intent-v2";
        values.input.policyVersion = "receiving-intent-v2";
      }
      await denied(nominate(values), "REQUEST_CONFLICT", 409);
      expect(values.reserveNomination).not.toHaveBeenCalled();
    },
  );

  it("sanitizes a lost commit acknowledgment and later recovers only through exact replay", async () => {
    const values = fixture();
    let committed: ReceivingNominationSnapshot | null = null;
    values.reserveNomination.mockImplementationOnce(
      async (snapshot, authorize) => {
        await authorize(values.locked);
        committed = snapshot;
        throw new Error("commit ACK lost; provider-key=private");
      },
    );
    const error = await denied(
      nominate(values),
      "RECEIVING_NOMINATION_UNAVAILABLE",
      503,
    );
    expect(String(error)).not.toMatch(/ACK|provider-key|private/);
    values.findByRequest.mockResolvedValueOnce(committed);
    values.locked.designatedOperatorUserId = values.actor.userId;
    values.generateId.mockClear();
    expect(await nominate(values)).toEqual(committed);
    expect(values.generateId).not.toHaveBeenCalled();
  });

  it("does not acknowledge a reserve port that omitted locked authorization", async () => {
    const values = fixture();
    values.reserveNomination.mockImplementationOnce(
      async (snapshot) => snapshot,
    );
    await denied(nominate(values), "RECEIVING_NOMINATION_UNAVAILABLE", 503);
  });

  it("does not acknowledge a repository that changed the original audit after locked authorization", async () => {
    const values = fixture();
    values.reserveNomination.mockImplementationOnce(
      async (snapshot, authorize) => {
        await authorize(values.locked);
        return {
          ...snapshot,
          authentication: {
            ...snapshot.authentication,
            sessionId: "foreign-session",
          },
        };
      },
    );
    await denied(nominate(values), "RECEIVING_NOMINATION_UNAVAILABLE", 503);
  });

  it.each(["site", "lookup", "reserve"])(
    "sanitizes %s storage failures without manufacturing a nomination",
    async (stage) => {
      const values = fixture();
      const error = new Error(
        "postgresql://user:secret@private; token=private",
      );
      if (stage === "site") values.loadSite.mockRejectedValueOnce(error);
      if (stage === "lookup") values.findByRequest.mockRejectedValueOnce(error);
      if (stage === "reserve")
        values.reserveNomination.mockRejectedValueOnce(error);
      const result = await denied(
        nominate(values),
        "RECEIVING_NOMINATION_UNAVAILABLE",
        503,
      );
      expect(JSON.stringify(result)).not.toMatch(/postgresql|secret|private/);
    },
  );

  it.each([
    null,
    { siteId: "foreign", isDemo: true },
    { siteId: "site-1", isDemo: "false" },
    { siteId: "site-1", isDemo: true, providerApproved: true },
  ])("requires a strictly scoped server-loaded site: %j", async (site) => {
    const values = fixture();
    values.loadSite.mockResolvedValueOnce(site);
    await denied(nominate(values), "RECEIVING_NOMINATION_UNAVAILABLE", 503);
    expect(values.findByRequest).not.toHaveBeenCalled();
  });

  it.each(["test", "development"])(
    "denies live nomination outside production: %s",
    async (environment) => {
      const values = fixture();
      values.options.mode = "live";
      values.options.applicationEnvironment = environment as
        | "test"
        | "development";
      await denied(nominate(values), "PROVIDER_MODE_UNAVAILABLE", 409);
      expect(values.reserveNomination).not.toHaveBeenCalled();
    },
  );

  it("denies a demo site in live mode even under production", async () => {
    const values = fixture();
    values.options.mode = "live";
    values.options.applicationEnvironment = "production";
    await denied(nominate(values), "PROVIDER_MODE_UNAVAILABLE", 409);
    expect(values.reserveNomination).not.toHaveBeenCalled();
  });

  it("permits only an initial awaiting-verification live intent for a non-demo production site", async () => {
    const values = fixture();
    values.options.mode = "live";
    values.options.applicationEnvironment = "production";
    values.loadSite.mockResolvedValueOnce({ siteId: "site-1", isDemo: false });
    values.input.requestId = deriveReceivingNominationRequestId({
      siteId: values.actor.siteId,
      operatorUserId: values.actor.userId,
      environment: "live",
    });
    expect(await nominate(values)).toMatchObject({
      environment: "live",
      state: "AWAITING_PROVIDER_VERIFICATION",
    });
  });

  it.each([
    [
      "disabled",
      (o: ReceivingNominationOptions) => {
        Object.assign(o, { mode: "disabled" });
      },
      "PROVIDER_MODE_UNAVAILABLE",
      409,
    ],
    [
      "long auth window",
      (o: ReceivingNominationOptions) => {
        o.maxAuthAgeMs = 300_001;
      },
      "RECEIVING_NOMINATION_UNAVAILABLE",
      503,
    ],
    [
      "zero auth window",
      (o: ReceivingNominationOptions) => {
        o.maxAuthAgeMs = 0;
      },
      "RECEIVING_NOMINATION_UNAVAILABLE",
      503,
    ],
    [
      "missing policy",
      (o: ReceivingNominationOptions) => {
        o.policyVersion = "";
      },
      "RECEIVING_NOMINATION_UNAVAILABLE",
      503,
    ],
    [
      "unknown app environment",
      (o: ReceivingNominationOptions) => {
        Object.assign(o, { applicationEnvironment: "browser" });
      },
      "RECEIVING_NOMINATION_UNAVAILABLE",
      503,
    ],
  ] as const)(
    "fails closed for invalid server options %s",
    async (_name, change, code, status) => {
      const values = fixture();
      change(values.options);
      await denied(nominate(values), code, status);
      expect(values.loadSite).not.toHaveBeenCalled();
    },
  );

  it("captures policy, actor and proof without mutating or trusting later caller changes", async () => {
    const values = fixture();
    const originalProof = structuredClone(values.recentAuth);
    const service = createReceivingNominationService(values.options);
    values.loadSite.mockImplementationOnce(async () => {
      values.actor.userId = "foreign";
      values.recentAuth.authenticatedAt?.setTime(0);
      values.options.mode = "live";
      return { siteId: "site-1", isDemo: true };
    });
    const result = await service.nominate({
      actor: values.actor,
      access: values.access,
      recentAuth: values.recentAuth,
      input: values.input,
    });
    expect(result.operatorUserId).toBe("operator-1");
    expect(result.environment).toBe("sandbox");
    expect(result.authentication.authenticatedAt).toBe(
      originalProof.authenticatedAt?.toISOString(),
    );
  });

  it("does not mutate caller objects on successful nomination", async () => {
    const values = fixture();
    const original = structuredClone({
      actor: values.actor,
      access: values.access,
      recentAuth: values.recentAuth,
      input: values.input,
    });
    await nominate(values);
    expect({
      actor: values.actor,
      access: values.access,
      recentAuth: values.recentAuth,
      input: values.input,
    }).toEqual(original);
  });

  it("fails closed when the injected clock rewinds after site await", async () => {
    const values = fixture();
    let current = new Date(now);
    values.options.now = () => new Date(current);
    values.loadSite.mockImplementationOnce(async () => {
      current = new Date(now.getTime() - 1);
      return { siteId: "site-1", isDemo: true };
    });
    await denied(nominate(values), "RECEIVING_NOMINATION_UNAVAILABLE", 503);
  });
});

function pendingValue<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
async function nominationTick() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("independent NEW nomination admission", () => {
  it("denies a valid administrator with current proof when independent custody ports are absent", async () => {
    const values = fixture();
    delete values.options.admission;
    await denied(nominate(values), "RECEIVING_NOMINATION_UNAVAILABLE", 503);
    expect(values.reserveNomination).toHaveBeenCalledOnce();
    expect(values.reserveNomination.mock.calls[0][3]).toBeUndefined();
  });
});

describe("independent original holder evidence", () => {
  it.each(["missing", "planner", "foreign-holder"])(
    "refuses administrative self confirmation with %s holder evidence",
    async (variant) => {
      const values = fixture();
      if (variant === "missing") values.readAuthority.mockResolvedValue(null);
      else
        values.custody.forEach((record) => {
          Object.assign(record, {
            holderUserId:
              variant === "planner" ? "actual-bride" : "foreign-holder",
          });
        });
      await denied(nominate(values), "RECEIVING_NOMINATION_UNAVAILABLE", 503);
      expect(values.reserveNomination).not.toHaveBeenCalled();
    },
  );
  it.each([
    "site",
    "account",
    "operation",
    "request",
    "hash",
    "environment",
    "policy",
    "session",
    "input",
    "server-environment",
    "issuer",
    "issuer-version",
    "disclosure",
    "disclosure-version",
    "future",
    "expired",
    "unbounded",
    "missing-consent",
    "missing-custody",
  ])(
    "refuses independent authority with foreign or invalid %s",
    async (variant) => {
      const values = fixture();
      const record = structuredClone(values.custody[0]);
      if (variant === "site")
        Object.assign(record.context.draft, { siteId: "foreign" });
      if (variant === "account")
        Object.assign(record.context.draft, { accountId: "foreign" });
      if (variant === "operation")
        Object.assign(record.context.draft, { operationId: "foreign" });
      if (variant === "request")
        Object.assign(record.context.draft, { requestId: "foreign" });
      if (variant === "hash")
        Object.assign(record.context.draft, { requestHash: "0".repeat(64) });
      if (variant === "environment")
        Object.assign(record.context.draft, { environment: "live" });
      if (variant === "policy")
        Object.assign(record.context.draft, { policyVersion: "foreign" });
      if (variant === "session")
        Object.assign(record.context.actor, { sessionId: "foreign" });
      if (variant === "input")
        Object.assign(record.context.input, { confirmSelfAsRecipient: false });
      if (variant === "server-environment")
        Object.assign(record.context, { applicationEnvironment: "production" });
      if (variant === "issuer") Object.assign(record, { issuerId: "foreign" });
      if (variant === "issuer-version")
        Object.assign(record, { issuerVersion: "foreign" });
      if (variant === "disclosure")
        Object.assign(record, { disclosureId: "foreign" });
      if (variant === "disclosure-version")
        Object.assign(record, { disclosureVersion: "foreign" });
      if (variant === "future")
        Object.assign(record, { issuedAt: "2026-10-12T12:00:00.001Z" });
      if (variant === "expired")
        Object.assign(record, { expiresAt: now.toISOString() });
      if (variant === "unbounded")
        Object.assign(record, { expiresAt: "2026-10-13T12:00:00.000Z" });
      if (variant === "missing-consent")
        Object.assign(record, { consentId: "" });
      if (variant === "missing-custody")
        Object.assign(record, { custodyId: "" });
      values.readAuthority.mockResolvedValue(record);
      await denied(nominate(values), "RECEIVING_NOMINATION_UNAVAILABLE", 503);
      expect(values.reserveNomination).not.toHaveBeenCalled();
    },
  );
  it.each(["actor-proof", "holder-proof", "clock-rewind"])(
    "checks %s again after genuinely pending authority read",
    async (variant) => {
      const values = fixture();
      const pending = pendingValue<unknown>();
      let current = new Date(now);
      values.options.now = () => new Date(current);
      values.readAuthority.mockImplementation(() => pending.promise);
      const action = nominate(values);
      await nominationTick();
      const record = structuredClone(values.custody[0]);
      if (variant === "actor-proof")
        current = new Date("2026-10-12T12:04:30.000Z");
      if (variant === "holder-proof")
        Object.assign(record, { expiresAt: now.toISOString() });
      if (variant === "clock-rewind") current = new Date(now.getTime() - 1);
      pending.resolve(record);
      await denied(
        action,
        variant === "actor-proof"
          ? "RECENT_AUTH_REQUIRED"
          : "RECEIVING_NOMINATION_UNAVAILABLE",
        variant === "actor-proof" ? 403 : 503,
      );
      expect(values.reserveNomination).not.toHaveBeenCalled();
    },
  );
  it("captures ports and original values before awaits despite caller and configuration mutation", async () => {
    const values = fixture();
    const foreignRead = vi.fn().mockResolvedValue(null);
    values.loadSite.mockImplementationOnce(async () => {
      Object.assign(values.actor, { userId: "foreign", sessionId: "foreign" });
      Object.assign(values.input, {
        policyVersion: "foreign",
        requestId: "foreign",
      });
      values.recentAuth.authenticatedAt!.setTime(0);
      Object.assign(values.options, {
        policyVersion: "foreign",
        now: () => new Date(0),
      });
      Object.assign(values.options.admission!, {
        issuerId: "foreign",
        readAuthority: foreignRead,
      });
      return { siteId: "site-1", isDemo: true };
    });
    const result = await nominate(values);
    expect(result).toEqual(values.custody[0].context.draft);
    expect(values.readAuthority).toHaveBeenCalledOnce();
    expect(foreignRead).not.toHaveBeenCalled();
  });
  it.each(["options", "authority", "input"])(
    "rejects %s accessors without executing callback code",
    async (variant) => {
      const values = fixture();
      const getter = vi.fn(() =>
        variant === "options" ? "sandbox" : "operator-1",
      );
      if (variant === "options")
        Object.defineProperty(values.options, "mode", { get: getter });
      if (variant === "input")
        Object.defineProperty(values.input, "requestId", { get: getter });
      if (variant === "authority") {
        const record = structuredClone(values.custody[0]);
        Object.defineProperty(record, "holderUserId", { get: getter });
        values.readAuthority.mockResolvedValue(record);
      }
      await denied(
        nominate(values),
        variant === "input"
          ? "NOMINATION_INVALID"
          : "RECEIVING_NOMINATION_UNAVAILABLE",
        variant === "input" ? 400 : 503,
      );
      expect(getter).not.toHaveBeenCalled();
      expect(values.reserveNomination).not.toHaveBeenCalled();
    },
  );
  it("retains pending ownership despite reentrant mutations and hostile promise metadata", async () => {
    const values = fixture();
    const pending = pendingValue<unknown>();
    const metadata = vi.fn(() => {
      throw new Error("metadata is not settlement");
    });
    Object.defineProperty(pending.promise, "status", { get: metadata });
    let mutationRejected = false;
    values.readAuthority.mockImplementation((context) => {
      try {
        Object.assign(context.draft, { accountId: "foreign" });
      } catch {
        mutationRejected = true;
      }
      Object.assign(values.options.admission!, {
        readAuthority: () => Promise.resolve(null),
      });
      return pending.promise;
    });
    let settled = false;
    const action = nominate(values).finally(() => {
      settled = true;
    });
    await nominationTick();
    try {
      expect(values.readAuthority).toHaveBeenCalledOnce();
      expect(mutationRejected).toBe(true);
      expect(settled).toBe(false);
      expect(values.reserveNomination).not.toHaveBeenCalled();
      expect(metadata).not.toHaveBeenCalled();
    } finally {
      pending.resolve(structuredClone(values.custody[0]));
      await action.catch(() => {});
    }
    expect(await action).toEqual(values.custody[0].context.draft);
  });
  it("keeps original expired audit replay with fresh actor proof and no NEW reader", async () => {
    const values = fixture();
    const original = await nominate(values);
    delete values.options.admission;
    values.findByRequest.mockResolvedValue(original);
    values.locked.designatedOperatorUserId = "operator-1";
    values.options.now = () => new Date("2026-10-12T12:10:00.000Z");
    values.recentAuth.authenticatedAt = new Date("2026-10-12T12:09:30.000Z");
    values.recentAuth.expiresAt = new Date("2026-10-12T12:14:30.000Z");
    values.readAuthority.mockClear();
    expect(await nominate(values)).toEqual(original);
    expect(values.readAuthority).not.toHaveBeenCalled();
  });
});

describe("original native authentication capture", () => {
  it("captures original authentication before the first reentrant clock callable", async () => {
    const values = fixture();
    let invoked = false;
    values.options.now = () => {
      if (!invoked) {
        invoked = true;
        values.recentAuth.authenticatedAt!.setTime(0);
        Object.assign(values.recentAuth, { sessionId: "foreign" });
      }
      return new Date(now);
    };
    expect(await nominate(values)).toEqual(values.custody[0].context.draft);
  });
  it("uses native Date values instead of a shadowed authentication getTime", async () => {
    const values = fixture();
    const shadow = vi.fn(() => 0);
    Object.defineProperty(values.recentAuth.authenticatedAt!, "getTime", {
      value: shadow,
    });
    expect(await nominate(values)).toEqual(values.custody[0].context.draft);
    expect(shadow).not.toHaveBeenCalled();
  });
});

describe("authoritative NEW and callable capture", () => {
  it("lets the locked repository decide a raced original winner conflict even without a NEW read port", async () => {
    const values = fixture();
    delete values.options.admission;
    values.reserveNomination.mockImplementationOnce(
      async (_snapshot, authorize) => {
        await authorize(values.locked);
        throw new ReceivingNominationServiceError(409, "REQUEST_CONFLICT");
      },
    );
    await denied(nominate(values), "REQUEST_CONFLICT", 409);
    expect(values.reserveNomination).toHaveBeenCalledOnce();
    expect(values.reserveNomination.mock.calls[0][3]).toBeUndefined();
  });
  it("captures a callable without invoking its shadowed bind accessor", async () => {
    const values = fixture();
    const getter = vi.fn(() => {
      throw new Error("shadowed bind");
    });
    Object.defineProperty(values.loadSite, "bind", { get: getter });
    expect(await nominate(values)).toEqual(values.custody[0].context.draft);
    expect(getter).not.toHaveBeenCalled();
  });
});

describe("admission acknowledgment validity", () => {
  it("does not acknowledge expired authority after awaited repository settlement", async () => {
    const values = fixture();
    let current = new Date(now);
    values.options.now = () => new Date(current);
    values.custody.forEach((record) => {
      Object.assign(record, { expiresAt: "2026-10-12T12:00:01.000Z" });
    });
    values.reserveNomination.mockImplementationOnce(
      async (snapshot, authorize) => {
        await authorize(values.locked);
        current = new Date("2026-10-12T12:00:01.000Z");
        return snapshot;
      },
    );
    await denied(nominate(values), "RECEIVING_NOMINATION_UNAVAILABLE", 503);
    expect(values.reserveNomination).toHaveBeenCalledOnce();
  });
});

describe("optional private ports preserve known replay", () => {
  it.each(["missing-callable", "missing-policy", "accessor-policy"])(
    "keeps exact known replay when private NEW configuration has %s",
    async (variant) => {
      const values = fixture();
      const original = await nominate(values);
      values.findByRequest.mockResolvedValue(original);
      values.locked.designatedOperatorUserId = "operator-1";
      const configuration: Record<string, unknown> =
        variant === "missing-policy"
          ? { readAuthority: values.readAuthority }
          : { ...admissionPolicy };
      const getter = vi.fn(() => "fixture-issuer");
      if (variant === "accessor-policy")
        Object.defineProperty(configuration, "issuerId", { get: getter });
      Object.assign(values.options, { admission: configuration });
      expect(await nominate(values)).toEqual(original);
      expect(getter).not.toHaveBeenCalled();
    },
  );
});

// These ports return the exact native promise; no async/mock wrapper assimilates it.
const settlementTestThen = Promise.prototype.then;
function nativeSettlementGate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  const state = { settled: false, fulfilled: false };
  const observed = Reflect.apply(settlementTestThen, promise, [
    () => {
      state.settled = true;
      state.fulfilled = true;
    },
    () => {
      state.settled = true;
    },
  ]) as Promise<void>;
  return { promise, resolve, reject, state, observed };
}
function poisonSettlementMetadata(
  promise: Promise<unknown>,
  kind: "constructor" | "species" | "then",
) {
  let accesses = 0;
  const trap = () => {
    accesses++;
    throw new Error("private pending promise metadata");
  };
  if (kind === "constructor")
    Object.defineProperty(promise, "constructor", { get: trap });
  if (kind === "species")
    Object.defineProperty(promise, "constructor", {
      value: Object.defineProperty({}, Symbol.species, { get: trap }),
    });
  if (kind === "then") {
    Object.defineProperty(promise, "constructor", { value: undefined });
    // biome-ignore lint/suspicious/noThenProperty: The own then getter is the exact hostile native promise fixture under test.
    Object.defineProperty(promise, "then", { get: trap });
  }
  return {
    accesses: () => accesses,
    descriptor: Object.getOwnPropertyDescriptor(
      promise,
      kind === "then" ? "then" : "constructor",
    ),
  };
}
function observeNominationOutcome(action: Promise<unknown>) {
  const state = { settled: false, fulfilled: false, error: null as unknown };
  Reflect.apply(settlementTestThen, action, [
    () => {
      state.settled = true;
      state.fulfilled = true;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    },
  ]);
  return state;
}

describe("genuine nomination settlement metadata", () => {
  it.each(["authority", "reservation"] as const)(
    "retains %s ownership when its exact pending native promise has a throwing constructor",
    async (stage) => {
      const values = fixture();
      const gate = nativeSettlementGate<unknown>();
      const decoration = poisonSettlementMetadata(gate.promise, "constructor");
      let delivered: Promise<unknown> | null = null;
      let calls = 0;
      let originalReservation: ReceivingNominationSnapshot | null = null;
      if (stage === "authority")
        Object.assign(values.options.admission!, {
          readAuthority: () => {
            calls++;
            delivered = gate.promise;
            return gate.promise;
          },
        });
      else
        Object.assign(values.options.repository, {
          reserveNomination: (
            snapshot: ReceivingNominationSnapshot,
            authorize: (state: ReceivingNominationLockedState) => Promise<void>,
          ) => {
            calls++;
            delivered = gate.promise;
            originalReservation = snapshot;
            Reflect.apply(settlementTestThen, authorize(values.locked), [
              () => {},
              () => {},
            ]);
            return gate.promise;
          },
        });
      const action = nominate(values);
      const outcome = observeNominationOutcome(action);
      await nominationTick();
      try {
        expect(calls).toBe(1);
        expect(delivered).toBe(gate.promise);
        expect(gate.state.settled).toBe(false);
        expect(decoration.accesses()).toBeGreaterThan(0);
        expect(outcome.settled).toBe(false);
      } finally {
        gate.resolve(
          stage === "authority"
            ? structuredClone(values.custody[0])
            : originalReservation,
        );
        await gate.observed;
      }
      await nominationTick();
      expect(gate.state.settled).toBe(true);
      expect(outcome.settled).toBe(false);
      expect(
        Object.getOwnPropertyDescriptor(gate.promise, "constructor"),
      ).toEqual(decoration.descriptor);
      // Failed attachment remains explicitly unresolved, without native work/timers.
    },
  );
  it.each(["species", "then"] as const)(
    "retains the native producer until genuine fulfillment despite %s metadata",
    async (kind) => {
      const values = fixture();
      const gate = nativeSettlementGate<unknown>();
      const decoration = poisonSettlementMetadata(gate.promise, kind);
      let delivered: Promise<unknown> | null = null;
      let calls = 0;
      Object.assign(values.options.admission!, {
        readAuthority: () => {
          calls++;
          delivered = gate.promise;
          return gate.promise;
        },
      });
      const action = nominate(values);
      const outcome = observeNominationOutcome(action);
      await nominationTick();
      try {
        expect(delivered).toBe(gate.promise);
        expect(calls).toBe(1);
        expect(gate.state.settled).toBe(false);
        expect(outcome.settled).toBe(false);
      } finally {
        gate.resolve(structuredClone(values.custody[0]));
        await gate.observed;
      }
      await nominationTick();
      expect(gate.state.fulfilled).toBe(true);
      if (kind === "then") {
        expect(await action).toEqual(values.custody[0].context.draft);
        expect(decoration.accesses()).toBe(0);
      } else expect(outcome.settled).toBe(false);
      expect(
        Object.getOwnPropertyDescriptor(
          gate.promise,
          kind === "then" ? "then" : "constructor",
        ),
      ).toEqual(decoration.descriptor);
    },
  );
  it.each(["fulfill", "reject"] as const)(
    "observes normal native %s only after the original authority producer settles",
    async (result) => {
      const values = fixture();
      const gate = nativeSettlementGate<unknown>();
      let delivered: Promise<unknown> | null = null;
      Object.assign(values.options.admission!, {
        readAuthority: () => {
          delivered = gate.promise;
          return gate.promise;
        },
      });
      const action = nominate(values);
      const outcome = observeNominationOutcome(action);
      await nominationTick();
      expect(delivered).toBe(gate.promise);
      expect(outcome.settled).toBe(false);
      if (result === "fulfill")
        gate.resolve(structuredClone(values.custody[0]));
      else gate.reject(new Error("private original authority rejection"));
      await gate.observed;
      if (result === "fulfill")
        expect(await action).toEqual(values.custody[0].context.draft);
      else await denied(action, "RECEIVING_NOMINATION_UNAVAILABLE", 503);
      expect(gate.state.settled).toBe(true);
      expect(outcome.settled).toBe(true);
    },
  );
});

describe("freshness after observable native settlement", () => {
  it.each(["authority", "reservation"] as const)(
    "checks current proof only after genuine %s completion with a poisoned then getter",
    async (stage) => {
      const values = fixture();
      const gate = nativeSettlementGate<unknown>();
      const decoration = poisonSettlementMetadata(gate.promise, "then");
      let current = new Date(now);
      values.options.now = () => new Date(current);
      let delivered: Promise<unknown> | null = null;
      let original: ReceivingNominationSnapshot | null = null;
      if (stage === "authority")
        Object.assign(values.options.admission!, {
          readAuthority: () => {
            delivered = gate.promise;
            return gate.promise;
          },
        });
      else
        Object.assign(values.options.repository, {
          reserveNomination: (
            snapshot: ReceivingNominationSnapshot,
            authorize: (state: ReceivingNominationLockedState) => Promise<void>,
          ) => {
            delivered = gate.promise;
            original = snapshot;
            Reflect.apply(settlementTestThen, authorize(values.locked), [
              () => {},
              () => {},
            ]);
            return gate.promise;
          },
        });
      const action = nominate(values);
      const outcome = observeNominationOutcome(action);
      await nominationTick();
      current = new Date("2026-10-12T12:04:30.000Z");
      expect(delivered).toBe(gate.promise);
      expect(gate.state.settled).toBe(false);
      expect(outcome.settled).toBe(false);
      gate.resolve(
        stage === "authority" ? structuredClone(values.custody[0]) : original,
      );
      await gate.observed;
      await denied(action, "RECENT_AUTH_REQUIRED", 403);
      expect(gate.state.settled).toBe(true);
      expect(decoration.accesses()).toBe(0);
    },
  );
});
