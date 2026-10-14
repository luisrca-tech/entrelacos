import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ReceivingNominationConfiguration,
  ReceivingNominationSnapshot,
} from "./receivingNomination";
import { createReceivingNominationContext } from "./receivingNominationContext";

function fixture() {
  const configuration: ReceivingNominationConfiguration = {
    mode: "sandbox",
    applicationEnvironment: "test",
    policyVersion: "intent-v1",
    requestIdentityVersion: "nr1",
  };
  const actor = {
    siteId: "site-one",
    userId: "user-one",
    sessionId: "session-one",
  };
  const access = {
    siteId: "site-one",
    userId: "user-one",
    membershipId: "membership-one",
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
  const snapshot: ReceivingNominationSnapshot = {
    state: "AWAITING_PROVIDER_VERIFICATION",
    siteId: "site-one",
    requestId: "legacy-request",
    operatorUserId: "user-one",
    environment: "sandbox",
    policyVersion: "intent-v1",
    accountId: "private-account",
    operationId: "private-operation",
    createdAt: "2026-10-12T12:00:00.000Z",
    requestHash: createHash("sha256")
      .update(
        JSON.stringify([
          "receiving.self-nomination.v1",
          "site-one",
          "legacy-request",
          "user-one",
          "sandbox",
          "intent-v1",
          true,
        ]),
      )
      .digest("hex"),
    authentication: {
      ...actor,
      proofKind: "PASSWORD_REAUTHENTICATION",
      authenticatedAt: "2026-10-12T11:59:30.000Z",
      expiresAt: "2026-10-12T12:04:30.000Z",
    },
  };
  const readNominationScope = vi
    .fn<() => Promise<ReceivingNominationSnapshot | null>>()
    .mockResolvedValue(null);
  const options = {
    configuration,
    repository: { readNominationScope },
    loadSite: vi.fn(async () => ({ siteId: "site-one", isDemo: false })),
    now: vi.fn(() => new Date("2026-10-12T12:01:00.000Z")),
  };
  return { options, actor, access, snapshot, readNominationScope };
}

describe("read-only canonical receiving nomination context", () => {
  it("derives the same empty-scope ID across tabs, sessions and policy changes without a write port", async () => {
    const v = fixture();
    const service = createReceivingNominationContext(v.options);
    const first = await service.readContext({
      actor: v.actor,
      access: v.access,
    });
    const expected = `nr1_${createHash("sha256")
      .update(
        JSON.stringify([
          "receiving.self-nomination.request.v1",
          "site-one",
          "user-one",
          "ASAAS",
          "sandbox",
        ]),
      )
      .digest("base64url")}`;
    expect(first).toEqual({
      siteId: "site-one",
      mode: "sandbox",
      state: "AVAILABLE",
      requestId: expected,
      policyVersion: "intent-v1",
    });
    expect(
      await service.readContext({
        actor: { ...v.actor, sessionId: "new-session" },
        access: v.access,
      }),
    ).toEqual(first);
    v.options.configuration.policyVersion = "intent-v2";
    const next = await createReceivingNominationContext(v.options).readContext({
      actor: v.actor,
      access: v.access,
    });
    expect(next.requestId).toBe(first.requestId);
    expect(next.policyVersion).toBe("intent-v2");
    expect(service.configuration.policyVersion).toBe("intent-v1");
    expect(v.readNominationScope).toHaveBeenCalledWith({
      siteId: "site-one",
      operatorUserId: "user-one",
      environment: "sandbox",
    });
    expect(Object.keys(v.options.repository)).toEqual(["readNominationScope"]);
  });
  it.each(["intent-v1", "intent-v2"])(
    "preserves the entire original legacy identity and projects pending safely under %s",
    async (policyVersion) => {
      const v = fixture();
      v.options.configuration.policyVersion = policyVersion;
      v.readNominationScope.mockResolvedValue(v.snapshot);
      const result = await createReceivingNominationContext(
        v.options,
      ).readContext({ actor: v.actor, access: v.access });
      expect(result).toEqual({
        siteId: "site-one",
        mode: "sandbox",
        state: "PENDING",
        requestId: "legacy-request",
        policyVersion: "intent-v1",
        currentPolicyVersion: policyVersion,
        postAllowed: policyVersion === "intent-v1",
        nomination: {
          siteId: "site-one",
          requestId: "legacy-request",
          state: "AWAITING_PROVIDER_VERIFICATION",
          createdAt: v.snapshot.createdAt,
          mode: "sandbox",
        },
      });
      expect(JSON.stringify(result)).not.toMatch(
        /private|authentication|session|requestHash|operatorUserId|aact_|READY/,
      );
    },
  );
  it.each([
    null,
    { membershipRole: "OWNER" },
    { membershipRole: "SITE_ASSISTANT" },
    { siteId: "other" },
    { userId: "other" },
    { membershipId: null },
    { capabilities: { configureReceiving: false } },
  ])("denies unsuitable current selected access %j", async (change) => {
    const v = fixture();
    const access =
      change === null
        ? null
        : {
            ...v.access,
            ...change,
            capabilities: { ...v.access.capabilities, ...change.capabilities },
          };
    await expect(
      createReceivingNominationContext(v.options).readContext({
        actor: v.actor,
        access,
      }),
    ).rejects.toMatchObject({ status: 403, code: "MEMBERSHIP_DENIED" });
    expect(v.readNominationScope).not.toHaveBeenCalled();
  });
  it.each([
    "siteId",
    "operatorUserId",
    "environment",
    "requestHash",
    "createdAt",
  ])(
    "refuses contradictory private snapshot %s rather than deriving a new ID",
    async (field) => {
      const v = fixture();
      v.readNominationScope.mockResolvedValue({
        ...v.snapshot,
        [field]: field === "createdAt" ? "2026-10-12T12:01:00.001Z" : "other",
      });
      await expect(
        createReceivingNominationContext(v.options).readContext({
          actor: v.actor,
          access: v.access,
        }),
      ).rejects.toMatchObject({
        status: 503,
        code: "RECEIVING_NOMINATION_UNAVAILABLE",
      });
    },
  );
  it("propagates scope conflicts without returning AVAILABLE and sanitizes unknown storage errors", async () => {
    const v = fixture();
    v.readNominationScope.mockRejectedValue(new Error("private token SQL"));
    const error = await createReceivingNominationContext(v.options)
      .readContext({ actor: v.actor, access: v.access })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      status: 503,
      code: "RECEIVING_NOMINATION_UNAVAILABLE",
    });
    expect(String(error)).not.toMatch(/private|SQL|token/);
  });
  it.each([
    { mode: "disabled" },
    { policyVersion: "" },
    { requestIdentityVersion: "nr2" },
    { mode: "live", applicationEnvironment: "test" },
  ])("rejects unsupported injected configuration %j", (change) => {
    const v = fixture();
    Object.assign(v.options.configuration, change);
    expect(() => createReceivingNominationContext(v.options)).toThrow();
  });
  it("denies live demo context and invalid clocks before allocating any identity", async () => {
    const v = fixture();
    Object.assign(v.options.configuration, {
      mode: "live",
      applicationEnvironment: "production",
    });
    v.options.loadSite.mockResolvedValue({ siteId: "site-one", isDemo: true });
    await expect(
      createReceivingNominationContext(v.options).readContext({
        actor: v.actor,
        access: v.access,
      }),
    ).rejects.toMatchObject({ status: 409, code: "PROVIDER_MODE_UNAVAILABLE" });
    expect(v.readNominationScope).not.toHaveBeenCalled();
    const invalid = fixture();
    invalid.options.now.mockReturnValue(new Date(NaN));
    await expect(
      createReceivingNominationContext(invalid.options).readContext({
        actor: invalid.actor,
        access: invalid.access,
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(invalid.readNominationScope).not.toHaveBeenCalled();
  });
  it("copies actor/config and captures ports before asynchronous scope discovery", async () => {
    const v = fixture();
    let resolve!: (value: ReceivingNominationSnapshot | null) => void;
    v.readNominationScope.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const service = createReceivingNominationContext(v.options);
    const pending = service.readContext({ actor: v.actor, access: v.access });
    await Promise.resolve();
    v.actor.userId = "other";
    v.actor.sessionId = "other";
    v.options.configuration.policyVersion = "other";
    resolve(null);
    const result = await pending;
    expect(result.policyVersion).toBe("intent-v1");
    expect(v.readNominationScope).toHaveBeenCalledWith({
      siteId: "site-one",
      operatorUserId: "user-one",
      environment: "sandbox",
    });
  });
});
