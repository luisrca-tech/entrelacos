import { describe, expect, it, vi } from "vitest";
import type { GiftPaymentConfig } from "./giftPaymentConfig";
import { encryptProviderCredential } from "./providerCredentials";
import { createReceivingSetupComposition } from "./receivingSetupComposition";

const mocks = vi.hoisted(() => ({
  nomination: vi.fn(),
  setupRepository: vi.fn(),
  provisioning: vi.fn(),
}));
vi.mock("./receivingNominationComposition", () => ({
  createReceivingNominationComposition: mocks.nomination,
}));
vi.mock("./receivingSetupRepository", async (original) => ({
  ...(await original<typeof import("./receivingSetupRepository")>()),
  createReceivingSetupRepository: mocks.setupRepository,
}));
vi.mock("./receivingAccountProvisioning", async (original) => ({
  ...(await original<typeof import("./receivingAccountProvisioning")>()),
  createReceivingAccountProvisioning: mocks.provisioning,
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture() {
  vi.clearAllMocks();
  const now = () => new Date("2026-10-16T15:00:00Z");
  const keyring = new Map([["sandbox-v1", Buffer.alloc(32, 19)]]);
  const config: GiftPaymentConfig = {
    mode: "sandbox",
    applicationEnvironment: "test",
    platformApiKey: "private-platform-key",
    platformAccountId: "platform-account",
    platformWalletId: "platform-wallet",
    credentialKeyId: "sandbox-v1",
    credentialKeyring: keyring,
    webhookPublicOrigin: "https://tunnel.example.test",
    webhookUrl: "https://tunnel.example.test/v1/webhooks/asaas",
  };
  const context = {
    provider: "ASAAS" as const,
    siteId: "site-one",
    accountBindingId: "account-one",
    environment: "sandbox" as const,
  };
  const result = {
    accountReference: "recipient-account",
    recipientReference: "recipient-wallet",
    credential: encryptProviderCredential(
      "private-subaccount-key",
      context,
      keyring,
      "sandbox-v1",
    ),
  };
  const account = {
    accountId: "account-one",
    operatorUserId: "holder-one",
    state: "SUCCEEDED",
    nomination: {},
    record: null,
    result,
  };
  const repository = {
    mode: "sandbox",
    policyVersion: "receiving-setup-v1",
    admission: { readAuthority: vi.fn(), lockAuthority: vi.fn() },
    readHolder: vi.fn(async () => null),
    readAccount: vi.fn(async () => account),
    requireHolder: vi.fn(),
    consent: vi.fn(),
    designate: vi.fn(),
    readCurrentProvisioningPolicy: vi.fn(),
  };
  mocks.setupRepository.mockReturnValue(repository);
  const nominate = vi.fn();
  mocks.nomination.mockReturnValue({
    receivingNomination: { nominate },
    financialReauthentication: { authenticate: vi.fn(), readProof: vi.fn() },
    now,
  });
  const drain = deferred();
  const provisioning = { begin: vi.fn(), close: vi.fn(() => drain.promise) };
  mocks.provisioning.mockReturnValue(provisioning);
  const db = { execute: vi.fn(), transaction: vi.fn() };
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v3/wallets/")
      return Response.json({
        data: [{ id: "recipient-wallet" }],
        hasMore: false,
      });
    if (path === "/v3/myAccount/status/")
      return Response.json({
        id: "status-one",
        commercialInfo: "APPROVED",
        bankAccountInfo: "APPROVED",
        documentation: "APPROVED",
        general: "APPROVED",
      });
    if (path === "/v3/myAccount/commercialInfo/")
      return Response.json({ commercialInfoExpiration: { isExpired: false } });
    throw new Error("Unexpected network path");
  });
  const options = {
    db: db as never,
    standardAuth: {} as never,
    secret: "test-auth-secret-longer-than-thirty-two",
    baseURL: "http://localhost:8080",
    adminOrigin: "http://localhost:3000",
    now,
    fetch,
  };
  return {
    config,
    options,
    repository,
    provisioning,
    drain,
    db,
    fetch,
    account,
    context,
  };
}

describe("receiving setup composition", () => {
  it("propagates the private showcase policy without adding it to nomination configuration", async () => {
    const v = fixture();
    const composition = createReceivingSetupComposition(
      {
        ...v.config,
        mode: "live",
        applicationEnvironment: "production",
        liveDemoSiteId: "site-one",
      },
      v.options,
    );
    expect(mocks.setupRepository.mock.calls[0][1]).toMatchObject({
      liveDemoSiteId: "site-one",
      mode: "live",
    });
    expect(mocks.nomination.mock.calls[0][0]).toMatchObject({
      liveDemoSiteId: "site-one",
    });
    expect(
      Object.keys(mocks.nomination.mock.calls[0][0].configuration),
    ).toHaveLength(4);
    expect(v.fetch).not.toHaveBeenCalled();
    expect(v.db.execute).not.toHaveBeenCalled();
    v.drain.resolve();
    await composition.close();
  });
  it("mounts native receiving verification in live production without provider writes", async () => {
    const values = fixture();
    const composition = createReceivingSetupComposition(
      { ...values.config, mode: "live", applicationEnvironment: "production" },
      values.options,
    );
    expect(composition.ports.receivingVerification?.verify).toBeTypeOf(
      "function",
    );
    expect(values.fetch).not.toHaveBeenCalled();
    expect(values.db.execute).not.toHaveBeenCalled();
    values.drain.resolve();
    await composition.close();
  });
  it("constructs the actual authority and provisioning services with isolated authentication without I/O", async () => {
    const values = fixture();
    const { createAuth } = await import("./auth");
    const actualNomination = await vi.importActual<
      typeof import("./receivingNominationComposition")
    >("./receivingNominationComposition");
    const actualProvisioning = await vi.importActual<
      typeof import("./receivingAccountProvisioning")
    >("./receivingAccountProvisioning");
    const actualRepository = await vi.importActual<
      typeof import("./receivingSetupRepository")
    >("./receivingSetupRepository");
    mocks.nomination.mockImplementationOnce(
      actualNomination.createReceivingNominationComposition,
    );
    mocks.provisioning.mockImplementationOnce(
      actualProvisioning.createReceivingAccountProvisioning,
    );
    mocks.setupRepository.mockImplementationOnce(
      actualRepository.createReceivingSetupRepository,
    );
    const standardAuth = createAuth({
      db: values.options.db,
      secret: values.options.secret,
      baseURL: values.options.baseURL,
      adminOrigin: values.options.adminOrigin,
    });
    await standardAuth.$context;
    const composition = createReceivingSetupComposition(values.config, {
      ...values.options,
      standardAuth,
    });
    expect(composition.ports.receivingNomination?.configuration).toMatchObject({
      mode: "sandbox",
      applicationEnvironment: "test",
      policyVersion: "receiving-setup-v1",
    });
    expect(values.db.execute).not.toHaveBeenCalled();
    expect(values.db.transaction).not.toHaveBeenCalled();
    expect(values.fetch).not.toHaveBeenCalled();
    await composition.close();
  });
  it("rejects a credential encrypted for another site before native status requests", async () => {
    const values = fixture();
    const composition = createReceivingSetupComposition(
      values.config,
      values.options,
    );
    const result = await composition.ports.receivingSetup?.read({
      siteId: "another-site",
      userId: "holder-one",
      sessionId: "session-one",
    });
    expect(result?.providerStatus).toBeNull();
    expect(values.fetch).not.toHaveBeenCalled();
    values.drain.resolve();
    await composition.close();
  });

  it("aborts native status observation and awaits owned database work during shutdown", async () => {
    const values = fixture();
    const database = deferred();
    values.repository.designate.mockImplementation(() => database.promise);
    values.fetch.mockImplementation(
      async (_url, request) =>
        new Promise<Response>((_resolve, reject) => {
          request?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const composition = createReceivingSetupComposition(
      values.config,
      values.options,
    );
    const read = composition.ports.receivingSetup?.read({
      siteId: "site-one",
      userId: "holder-one",
      sessionId: "session-one",
    });
    const designate = composition.ports.receivingSetup?.designate(
      { siteId: "site-one", userId: "owner-one", sessionId: "session-one" },
      "holder-one",
    );
    await vi.waitFor(() => expect(values.fetch).toHaveBeenCalledOnce());
    const closing = composition.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    values.drain.resolve();
    await read;
    expect(closed).toBe(false);
    database.resolve();
    await designate;
    await closing;
    expect(closed).toBe(true);
  });
  it("pins the selected platform account and active key before caller mutation", async () => {
    const values = fixture();
    const composition = createReceivingSetupComposition(
      values.config,
      values.options,
    );
    Object.assign(values.config, {
      platformAccountId: "another-account",
      credentialKeyId: "another-key",
    });
    const provider = await mocks.provisioning.mock.calls[0][0].readProvider({
      siteId: "site-one",
      environment: "sandbox",
      policyVersion: values.repository.policyVersion,
    });
    expect(provider.parentAccountReference).toBe("platform-account");
    const client = provider.createClient(values.context);
    expect(client.available).toBe(true);
    await client.close();
    values.drain.resolve();
    await composition.close();
  });
  it("returns disabled before reading private configuration or dependencies", async () => {
    const config = { mode: "disabled" as const };
    Object.defineProperty(config, "platformApiKey", {
      get() {
        throw new Error("Private setting read");
      },
    });
    const options = new Proxy(
      {},
      {
        get() {
          throw new Error("Dependency read");
        },
      },
    );
    const composition = createReceivingSetupComposition(
      config,
      options as never,
    );
    expect(composition.ports).toEqual({});
    await composition.close();
  });

  it("assembles independent admission, shared reauthentication and native account provisioning without I/O", async () => {
    const values = fixture();
    const composition = createReceivingSetupComposition(
      values.config,
      values.options,
    );
    const nomination = mocks.nomination.mock.calls[0][0];
    expect(nomination.nomination.admission).toBe(values.repository.admission);
    expect(nomination.reauthentication.rateLimit.consume).toBeTypeOf(
      "function",
    );
    expect(nomination.reauthentication.password.verifyPassword).toBeTypeOf(
      "function",
    );
    const provider = await mocks.provisioning.mock.calls[0][0].readProvider({
      siteId: "site-one",
      environment: "sandbox",
      policyVersion: values.repository.policyVersion,
    });
    expect(provider.parentAccountReference).toBe("platform-account");
    const client = provider.createClient(values.context);
    expect(client.available).toBe(true);
    await client.close();
    expect(values.db.execute).not.toHaveBeenCalled();
    expect(values.fetch).not.toHaveBeenCalled();
    values.drain.resolve();
    await composition.close();
  });

  it("decrypts only the bound subaccount credential for status reads and drains provisioning before close", async () => {
    const values = fixture();
    const composition = createReceivingSetupComposition(
      values.config,
      values.options,
    );
    const result = await composition.ports.receivingSetup?.read({
      siteId: "site-one",
      userId: "holder-one",
      sessionId: "session-one",
    });
    expect(result?.providerStatus?.general).toBe("APPROVED");
    expect(values.fetch).toHaveBeenCalledTimes(3);
    for (const [, request] of values.fetch.mock.calls)
      expect(request?.headers).toMatchObject({
        access_token: "private-subaccount-key",
      });
    const closing = composition.close();
    expect(composition.close()).toBe(closing);
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    values.drain.resolve();
    await closing;
    await expect(
      composition.ports.receivingSetup?.read({
        siteId: "site-one",
        userId: "holder-one",
        sessionId: "session-one",
      }),
    ).rejects.toThrow("Receiving setup composition unavailable");
  });
});
