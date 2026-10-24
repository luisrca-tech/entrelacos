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

import { encryptProviderCredential } from "./providerCredentials";
import { createReceivingVerificationComposition } from "./receivingVerificationComposition";

function fixture(
  native = false,
  mode: "sandbox" | "live" = "sandbox",
  liveDemoSiteId?: string,
  actualPreparation = false,
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
    readAccount: vi.fn(async () => ({
      accountId: row.accountId,
      operatorUserId: row.operatorUserId,
      state: "SUCCEEDED",
      record: { provision: { parentAccountReference: "parent-one" } },
      result: {
        accountReference: row.accountReference,
        recipientReference: row.recipientReference,
        credential: encryptProviderCredential(
          "child-private-key",
          {
            provider: "ASAAS",
            siteId: row.siteId,
            accountBindingId: row.accountId,
            environment: mode,
          },
          new Map([["key-one", new Uint8Array(32)]]),
          "key-one",
        ),
      },
    })),
    armIncomingPix: vi.fn(async () => "attempt-one"),
    settleIncomingPix: vi.fn(async () => {}),
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
  let activeKey = false;
  const fetch = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/wallets/"))
        return Response.json({
          data: [{ id: row.recipientReference }],
          hasMore: false,
        });
      if (path.endsWith("/myAccount/status/"))
        return Response.json({
          id: "status-one",
          commercialInfo: "APPROVED",
          bankAccountInfo: "PENDING",
          documentation: "APPROVED",
          general: "APPROVED",
        });
      if (path.endsWith("/myAccount/commercialInfo/"))
        return Response.json({
          commercialInfoExpiration: { isExpired: false },
        });
      if (path.endsWith("/pix/addressKeys")) {
        if (init?.method === "POST") activeKey = true;
        const key = { id: "key-one", type: "EVP", status: "ACTIVE" };
        return Response.json(
          init?.method === "POST"
            ? key
            : { hasMore: false, data: activeKey ? [key] : [] },
        );
      }
      throw new Error("Unexpected native route");
    },
  );
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
    fetch,
    now,
    ...(actualPreparation ? {} : { prepareIncoming }),
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
    fetch,
  };
}
describe("native receiving verification composition", () => {
  it("shares one in-flight observation between public refresh and holder verification", async () => {
    const v = fixture(true, "live");
    let release = (_value: { state: string }) => {};
    const feedback = new Promise<{ state: string }>((resolve) => {
      release = resolve;
    });
    mocks.begin.mockClear();
    mocks.begin.mockImplementation(() => ({
      feedback,
      completion: Promise.resolve(),
    }));
    const publicRead = v.composition.refresh("site-one");
    await vi.waitFor(() => expect(mocks.begin).toHaveBeenCalledOnce());
    const holderRead = v.composition.verify(v.actor);
    await vi.waitFor(() => expect(v.prepareIncoming).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    release({ state: "STORED" });
    await Promise.all([publicRead, holderRead]);
    expect(mocks.begin).toHaveBeenCalledOnce();
    await v.composition.close();
  });
  it("decrypts the saved credential using only its exact security context before native preparation", async () => {
    const v = fixture(false, "live", undefined, true);
    expect(await v.composition.verify(v.actor)).toMatchObject({
      state: "READY",
      mode: "live",
    });
    expect(v.repository.armIncomingPix).toHaveBeenCalledOnce();
    expect(
      v.fetch.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    expect(
      new Headers(v.fetch.mock.calls[0][1]?.headers).get("access_token"),
    ).toBe("child-private-key");
    await v.composition.close();
  });
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
