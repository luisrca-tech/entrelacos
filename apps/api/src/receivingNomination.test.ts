import { createHash } from "node:crypto";
import type { SiteAccess } from "@entrelacos/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  assertRecipientFinancialAction,
  type FinancialActor,
  type FinancialRecipientBinding,
  type RecentFinancialAuthenticationEvidence,
} from "./financialAuthorization";
import {
  createReceivingNominationService,
  deriveReceivingNominationRequestId,
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
  const recentAuth: RecentFinancialAuthenticationEvidence = {
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
    ) => {
      await authorize(locked);
      return snapshot;
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
        recentAuth: values.recentAuth,
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
