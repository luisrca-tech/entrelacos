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

function fixture(native = false) {
  const row = {
    siteId: "site-one",
    accountId: "account-one",
    operatorUserId: "holder-one",
    operatorReference: "local-operator",
    accountReference: "native-account",
    recipientReference: "native-wallet",
    nativeDestination: native,
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
  mocks.begin.mockImplementation((command) => {
    if (command.action === "SELECT") row.nativeDestination = true;
    return {
      feedback: Promise.resolve({ state: "STORED" }),
      completion: Promise.resolve(),
    };
  });
  const composition = createReceivingVerificationComposition({
    db: { execute } as never,
    mode: "sandbox",
    applicationEnvironment: "development",
    platformAccountReference: "parent-one",
    keyring: new Map([["key-one", new Uint8Array(32)]]),
    repository: repository as never,
    fetch: vi.fn(),
    now,
    readReadiness: async () => ({
      siteId: "site-one",
      mode: "sandbox",
      state: "READY",
      reason: null,
      catalogEligible: true,
      destinationVersion: 2,
      observedAt: now().toISOString(),
    }),
  });
  return { composition, actor, proof, row, execute, repository };
}
describe("native receiving verification composition", () => {
  it("never selects an incoming bank while refreshing a simulated or missing destination", async () => {
    const v = fixture();
    mocks.begin.mockClear();
    await v.composition.refresh("site-one");
    expect(mocks.begin).not.toHaveBeenCalled();
    await v.composition.close();
  });
  it("selects only with explicit real holder authentication, then observes the selected bank", async () => {
    const v = fixture();
    mocks.begin.mockClear();
    expect((await v.composition.verify(v.actor)).state).toBe("READY");
    expect(mocks.begin.mock.calls.map(([command]) => command.action)).toEqual([
      "SELECT",
      "OBSERVE",
    ]);
    expect(v.repository.requireHolder).toHaveBeenCalledWith(v.actor);
    expect(mocks.begin.mock.calls[0][0].authorization.recentAuth).toBe(v.proof);
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
  it("refreshes an explicitly selected native destination without changing its version", async () => {
    const v = fixture(true);
    mocks.begin.mockClear();
    await v.composition.refresh("site-one");
    await v.composition.refresh("site-one");
    expect(mocks.begin.mock.calls.map(([command]) => command.action)).toEqual([
      "OBSERVE",
    ]);
    await v.composition.close();
  });
});
