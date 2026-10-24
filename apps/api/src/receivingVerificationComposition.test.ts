import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  begin: vi.fn(),
  close: vi.fn(async () => {}),
}));
vi.mock("./receivingVerification", async (original) => ({
  ...(await original<typeof import("./receivingVerification")>()),
  createReceivingVerification: () => ({
    begin: mocks.begin,
    close: mocks.close,
  }),
}));

import { createReceivingVerificationComposition } from "./receivingVerificationComposition";

function fixture(
  native = false,
  mode: "sandbox" | "live" = "sandbox",
  liveDemoSiteId?: string,
) {
  const row = {
    siteId: "site-one",
    accountId: "account-one",
    operatorUserId: "holder-one",
    operatorReference: "local-operator",
    accountReference: "native-account",
    recipientReference: "native-wallet",
    nativeDestination: native,
    isDemo: mode === "sandbox",
  };
  const execute = vi.fn(async () => ({ rows: [row] }));
  const repository = {
    requireHolder: vi.fn(async () => ({ holderUserId: "holder-one" })),
    readSessionAuthentication: vi.fn(async () => proof),
    readCurrentProvisioningPolicy: vi.fn(async () => true),
  };
  const actor = {
    siteId: "site-one",
    userId: "holder-one",
    sessionId: "session-one",
  };
  const proof = {
    ...actor,
    proofKind: "SESSION_AUTHENTICATION" as const,
    provenance: "backend" as const,
    verification: "verified" as const,
    authenticatedAt: new Date("2026-10-19T11:59:00Z"),
    expiresAt: new Date("2026-10-19T12:04:00Z"),
  };
  const now = () => new Date("2026-10-19T12:00:00Z");
  const prepareIncoming = vi.fn(
    async (): Promise<"READY" | "PENDING" | "REVIEW_REQUIRED"> => "READY",
  );
  mocks.begin.mockImplementation((command) => {
    if (command.action === "SELECT") row.nativeDestination = true;
    return {
      feedback: Promise.resolve({ state: "STORED" }),
      completion: Promise.resolve(),
    };
  });
  const composition = createReceivingVerificationComposition({
    db: { execute } as never,
    liveDemoSiteId,
    mode,
    applicationEnvironment: mode === "live" ? "production" : "development",
    platformAccountReference: "parent-one",
    keyring: new Map([["key-one", new Uint8Array(32)]]),
    repository: repository as never,
    fetch: vi.fn(),
    now,
    prepareIncoming,
    readReadiness: async () => ({
      siteId: "site-one",
      mode,
      state: "READY",
      reason: null,
      catalogEligible: true,
      destinationVersion: 2,
      observedAt: now().toISOString(),
    }),
  });
  return {
    composition,
    actor,
    proof,
    row,
    execute,
    repository,
    prepareIncoming,
  };
}
describe("native receiving verification composition", () => {
  it.each(["PENDING", "REVIEW_REQUIRED"] as const)(
    "keeps incoming readiness blocked while preparation is %s",
    async (state) => {
      const v = fixture(false, "live");
      v.prepareIncoming.mockResolvedValue(state);
      mocks.begin.mockClear();
      await expect(v.composition.verify(v.actor)).rejects.toMatchObject({
        status: 409,
        code: `RECEIVING_PIX_PREPARATION_${state}`,
      });
      expect(v.prepareIncoming).toHaveBeenCalledWith(
        v.actor,
        expect.objectContaining({ accountId: "account-one" }),
      );
      expect(mocks.begin).not.toHaveBeenCalled();
      await v.composition.close();
    },
  );
  it.each(["sandbox", "live"] as const)(
    "never selects %s incoming bank while refreshing a simulated or missing destination",
    async (mode) => {
      const v = fixture(false, mode);
      mocks.begin.mockClear();
      await v.composition.refresh("site-one");
      expect(mocks.begin).not.toHaveBeenCalled();
      expect(v.prepareIncoming).not.toHaveBeenCalled();
      await v.composition.close();
    },
  );
  it.each(["sandbox", "live"] as const)(
    "selects %s only with explicit real holder authentication, then observes the selected bank",
    async (mode) => {
      const v = fixture(false, mode);
      mocks.begin.mockClear();
      expect((await v.composition.verify(v.actor)).state).toBe("READY");
      expect(mocks.begin.mock.calls.map(([command]) => command.action)).toEqual(
        ["SELECT", "OBSERVE"],
      );
      expect(v.repository.requireHolder).toHaveBeenCalledWith(v.actor);
      expect(mocks.begin.mock.calls[0][0].authorization.recentAuth).toBe(
        v.proof,
      );
      await v.composition.close();
    },
  );
  it("verifies only the explicitly opted-in native production showcase", async () => {
    const v = fixture(false, "live", "site-one");
    v.row.isDemo = true;
    mocks.begin.mockClear();
    await expect(v.composition.verify(v.actor)).resolves.toMatchObject({
      mode: "live",
      state: "READY",
    });
    expect(v.row.isDemo).toBe(true);
    expect(mocks.begin.mock.calls.map(([command]) => command.action)).toEqual([
      "SELECT",
      "OBSERVE",
    ]);
    await v.composition.close();
  });
  it("rejects production demo rows before selecting or observing", async () => {
    const v = fixture(false, "live");
    v.row.isDemo = true;
    mocks.begin.mockClear();
    await expect(v.composition.verify(v.actor)).rejects.toThrow();
    expect(mocks.begin).not.toHaveBeenCalled();
    await v.composition.close();
  });
  it("cannot select using expired or foreign authentication", async () => {
    const v = fixture();
    mocks.begin.mockClear();
    v.repository.readSessionAuthentication.mockRejectedValue(
      new Error("actual session denied"),
    );
    await expect(v.composition.verify(v.actor)).rejects.toThrow();
    expect(mocks.begin).not.toHaveBeenCalled();
    await v.composition.close();
  });
  it.each(["sandbox", "live"] as const)(
    "refreshes %s explicitly selected native destination without changing its version",
    async (mode) => {
      const v = fixture(true, mode);
      mocks.begin.mockClear();
      await v.composition.refresh("site-one");
      await v.composition.refresh("site-one");
      expect(mocks.begin.mock.calls.map(([command]) => command.action)).toEqual(
        ["OBSERVE"],
      );
      await v.composition.close();
    },
  );
});
