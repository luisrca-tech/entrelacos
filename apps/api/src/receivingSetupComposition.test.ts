import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { GiftPaymentConfig } from "./giftPaymentConfig";
import {
  deriveReceivingFingerprintKey,
  RECEIVING_FINGERPRINT_KEY_ID,
} from "./receivingAccountProvisioning";
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
function pagarmeFixture(name: string) {
  return readFileSync(
    new URL(`./__fixtures__/pagarme/${name}.json`, import.meta.url),
    "utf8",
  );
}
function fixture() {
  vi.clearAllMocks();
  const now = () => new Date("2026-10-16T15:00:00Z");
  const config: Extract<GiftPaymentConfig, { mode: "sandbox" | "live" }> = {
    mode: "sandbox",
    providerMode: "test",
    applicationEnvironment: "test",
    secretKey: "sk_test_fixtureSecret0123456789",
    platformRecipientId: "rp_platformRecipient",
    webhookBasicUser: "webhook-user",
    webhookCredentialsHash: "a".repeat(64),
  };
  const account = {
    accountId: "account-one",
    operatorUserId: "holder-one",
    state: "SUCCEEDED",
    nomination: {},
    record: null,
    result: {
      accountReference: "rp_fixtureRecipient01",
      recipientReference: "rp_fixtureRecipient01",
    },
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
    const json = (body: string) =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (path.endsWith("/recipients/rp_fixtureRecipient01"))
      return json(pagarmeFixture("recipient-active"));
    if (path.endsWith("/recipients/rp_fixtureRecipient01/kyc_link"))
      return json(pagarmeFixture("recipient-kyc-link"));
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
        liveDemoSiteIds: ["site-one"],
      },
      v.options,
    );
    expect(mocks.setupRepository.mock.calls[0][1]).toMatchObject({
      liveDemoSiteIds: ["site-one"],
      mode: "live",
    });
    expect(mocks.nomination.mock.calls[0][0]).toMatchObject({
      liveDemoSiteIds: ["site-one"],
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
  it("returns disabled before reading private configuration or dependencies", async () => {
    const config = { mode: "disabled" as const };
    Object.defineProperty(config, "secretKey", {
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
  it("pins the platform recipient and derives the fingerprint key from the application secret", async () => {
    const values = fixture();
    const composition = createReceivingSetupComposition(
      values.config,
      values.options,
    );
    Object.assign(values.config, { platformRecipientId: "rp_another" });
    const provisioningOptions = mocks.provisioning.mock.calls[0][0];
    expect(provisioningOptions.activeFingerprintKeyId).toBe(
      RECEIVING_FINGERPRINT_KEY_ID,
    );
    expect(
      Buffer.from(
        provisioningOptions.fingerprintKeys.get(RECEIVING_FINGERPRINT_KEY_ID),
      ),
    ).toEqual(
      Buffer.from(deriveReceivingFingerprintKey(values.options.secret)),
    );
    const provider = await provisioningOptions.readProvider({
      siteId: "site-one",
      environment: "sandbox",
      policyVersion: values.repository.policyVersion,
    });
    expect(provider.parentAccountReference).toBe("rp_platformRecipient");
    expect(provider.recipients.createRecipient).toBeTypeOf("function");
    const nomination = mocks.nomination.mock.calls[0][0];
    expect(nomination.nomination.admission).toBe(values.repository.admission);
    expect(values.db.execute).not.toHaveBeenCalled();
    expect(values.fetch).not.toHaveBeenCalled();
    values.drain.resolve();
    await composition.close();
  });
  it("reads the recipient status with the platform secret key", async () => {
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
    expect(result?.providerStatus).toEqual({
      recipientStatus: "active",
      accountState: "APPROVED",
      receivingEnabled: true,
      observedAt: "2026-10-16T15:00:00.000Z",
    });
    expect(values.fetch).toHaveBeenCalledOnce();
    const [url, init] = values.fetch.mock.calls[0];
    expect(new URL(String(url)).pathname).toMatch(
      /\/recipients\/rp_fixtureRecipient01$/,
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("sk_test_fixtureSecret0123456789:").toString("base64")}`,
    );
    values.drain.resolve();
    await composition.close();
  });
  it("keeps the provider status empty when Pagar.me cannot be read", async () => {
    const values = fixture();
    values.fetch.mockRejectedValue(new Error("network down"));
    const composition = createReceivingSetupComposition(
      values.config,
      values.options,
    );
    const result = await composition.ports.receivingSetup?.read({
      siteId: "site-one",
      userId: "holder-one",
      sessionId: "session-one",
    });
    expect(result?.accountState).toBe("CREATED");
    expect(result?.providerStatus).toBeNull();
    values.drain.resolve();
    await composition.close();
  });
  it("creates a fresh identity verification link without touching the database", async () => {
    const values = fixture();
    const composition = createReceivingSetupComposition(
      values.config,
      values.options,
    );
    const link = await composition.ports.receivingSetup?.createKycLink(
      { siteId: "site-one", userId: "owner-one", sessionId: "session-one" },
      "OWNER",
    );
    expect(link).toEqual({
      url: "https://exemplo.com/kyc?token=eyWfwqrnqwrnfoqwntoqwntqw",
      base64QrCode: "PD94bWwgdmVyc2lvbj0iMS4wIj8+PHN2Zy8+",
      expiresAt: "2026-11-18T12:20:00.000Z",
    });
    const [url, init] = values.fetch.mock.calls[0];
    expect(new URL(String(url)).pathname).toMatch(
      /\/recipients\/rp_fixtureRecipient01\/kyc_link$/,
    );
    expect(init?.method).toBe("POST");
    expect(values.db.execute).not.toHaveBeenCalled();
    expect(values.db.transaction).not.toHaveBeenCalled();
    expect(values.repository.consent).not.toHaveBeenCalled();
    expect(values.repository.designate).not.toHaveBeenCalled();
    values.drain.resolve();
    await composition.close();
  });
  it("awaits in-flight provider and database work before closing", async () => {
    const values = fixture();
    const database = deferred();
    const provider = deferred();
    values.repository.designate.mockImplementation(() => database.promise);
    const respond = values.fetch.getMockImplementation();
    values.fetch.mockImplementation(async (...args) => {
      await provider.promise;
      return respond?.(...args) as Promise<Response>;
    });
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
    expect(composition.close()).toBe(closing);
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    values.drain.resolve();
    provider.resolve();
    await read;
    expect(closed).toBe(false);
    database.resolve();
    await designate;
    await closing;
    expect(closed).toBe(true);
    await expect(
      composition.ports.receivingSetup?.read({
        siteId: "site-one",
        userId: "holder-one",
        sessionId: "session-one",
      }),
    ).rejects.toThrow("Receiving setup composition unavailable");
  });
});
