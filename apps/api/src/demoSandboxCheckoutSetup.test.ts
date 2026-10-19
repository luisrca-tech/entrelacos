import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { prepareDemoSandboxCheckout } from "./demoSandboxCheckoutSetup";
import { encryptProviderCredential } from "./providerCredentials";

const now = new Date("2026-10-16T12:00:00.000Z");
const context = {
  provider: "ASAAS" as const,
  siteId: "demo-wedding",
  accountBindingId: "account-one",
  environment: "sandbox" as const,
};
function fixture() {
  const keys = new Map([["key-one", new Uint8Array(32).fill(33)]]);
  const envelope = encryptProviderCredential(
    "sandbox-child-secret",
    context,
    keys,
    "key-one",
  );
  const site = {
    id: "demo-wedding",
    isDemo: true,
    repositorySlug: "demo-wedding",
    currentTime: now,
  };
  const holder = {
    id: "holder-one",
    holderUserId: "bride-one",
    consentId: "consent-one",
    consentVersion: "asaas-receiving-v1",
    consentAt: new Date(now.getTime() - 60000),
    state: "ACTIVE",
    role: "SITE_ADMIN",
  };
  const account = {
    id: "account-one",
    siteId: "demo-wedding",
    environment: "sandbox",
    provider: "ASAAS",
    operatorUserId: "bride-one",
    operatorReference: null,
    accountReference: "actual-account-one",
    recipientReference: "actual-wallet-one",
    credential: envelope,
    webhookTokenHash: "a".repeat(64),
    webhookRegistration: {
      version: 1,
      state: "REGISTERED",
      url: "https://tunnel.example.test/v1/webhooks/asaas",
      providerWebhookId: "webhook-one",
    } as unknown,
    creationState: "SUCCEEDED",
  };
  const rows: unknown[][] = [
    [site],
    [holder],
    [account],
    [],
    [],
    [{ id: "account-one" }],
    [{ id: "demo-checkout-destination-account-one" }],
    [{ id: "evidence-one" }],
  ];
  const queries: string[] = [];
  const dialect = new PgDialect();
  const execute = vi.fn(async (query) => {
    queries.push(dialect.sqlToQuery(query).sql);
    return { rows: rows.shift() ?? [] };
  });
  const transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
    work({ execute }),
  );
  const config = {
    mode: "sandbox",
    applicationEnvironment: "development",
    credentialKeyring: keys,
    platformApiKey: "platform-secret",
    platformAccountId: "parent-account",
    platformWalletId: "parent-wallet",
    credentialKeyId: "key-one",
    webhookPublicOrigin: "https://tunnel.example.test",
    webhookUrl: "https://tunnel.example.test/v1/webhooks/asaas",
  } as Parameters<typeof prepareDemoSandboxCheckout>[1];
  const input = {
    confirmation:
      "PREPARE development demo-wedding Sandbox checkout simulation",
  };
  const db = { transaction } as unknown as Parameters<
    typeof prepareDemoSandboxCheckout
  >[0];
  return {
    db,
    config,
    input,
    rows,
    site,
    holder,
    account,
    queries,
    execute,
    transaction,
  };
}
describe("explicit development demo checkout simulation", () => {
  it.each(["live", "disabled"])(
    "rejects mode %s before opening a transaction",
    async (mode) => {
      const v = fixture();
      await expect(
        prepareDemoSandboxCheckout(
          v.db,
          { ...v.config, mode } as never,
          v.input,
        ),
      ).rejects.toThrow("Demo Sandbox checkout preparation unavailable");
      expect(v.transaction).not.toHaveBeenCalled();
    },
  );
  it.each(["production", "test"])(
    "rejects application environment %s before database access",
    async (applicationEnvironment) => {
      const v = fixture();
      await expect(
        prepareDemoSandboxCheckout(
          v.db,
          { ...v.config, applicationEnvironment } as never,
          v.input,
        ),
      ).rejects.toThrow();
      expect(v.transaction).not.toHaveBeenCalled();
    },
  );
  it("requires exact deliberate simulation acceptance", async () => {
    const v = fixture();
    await expect(
      prepareDemoSandboxCheckout(v.db, v.config, { confirmation: "yes" }),
    ).rejects.toThrow();
    expect(v.transaction).not.toHaveBeenCalled();
  });
  it.each([
    "site",
    "consent",
    "holder",
    "mode",
    "creation",
    "credential",
    "webhook",
  ])("rejects missing authoritative %s without writes", async (gate) => {
    const v = fixture();
    if (gate === "site") v.site.isDemo = false;
    if (gate === "consent") v.holder.consentVersion = "old-policy";
    if (gate === "holder") v.account.operatorUserId = "planner-one";
    if (gate === "mode") v.account.environment = "live";
    if (gate === "creation") v.account.creationState = "UNKNOWN";
    if (gate === "credential")
      v.account.credential = { ...v.account.credential, tag: "invalid" };
    if (gate === "webhook") v.account.webhookTokenHash = "";
    await expect(
      prepareDemoSandboxCheckout(v.db, v.config, v.input),
    ).rejects.toThrow();
    expect(
      v.queries.some((query) => /^\s*(INSERT|UPDATE|DELETE)/.test(query)),
    ).toBe(false);
  });
  it("keeps actual account/wallet/credential references and writes only marked simulation evidence", async () => {
    const v = fixture();
    const result = await prepareDemoSandboxCheckout(v.db, v.config, v.input);
    expect(result).toEqual({
      siteId: "demo-wedding",
      accountId: "account-one",
      provenance: "SIMULATION",
      purpose: "GUEST_CHECKOUT_ONLY",
      destinationVersion: 1,
      observedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 300000).toISOString(),
    });
    const accountUpdate = v.queries.find((query) =>
      /^\s*UPDATE receiving_account/.test(query),
    );
    expect(accountUpdate).toBeDefined();
    expect(accountUpdate).not.toMatch(
      /SET[\s\S]*(account_reference|recipient_reference|credential_|webhook_token_hash)\s*=/,
    );
    expect(
      v.queries.find((query) =>
        /INSERT INTO receiving_verification_evidence/.test(query),
      ),
    ).toContain("'SIMULATION'");
    expect(JSON.stringify(result)).not.toMatch(
      /secret|actual-wallet|ciphertext|apiKey/,
    );
  });
  it("does not replace a genuine existing bank destination", async () => {
    const v = fixture();
    v.rows[3] = [
      {
        id: "native-destination",
        version: 1,
        bankReference: "native-bank",
        isCurrent: true,
      },
    ];
    await expect(
      prepareDemoSandboxCheckout(v.db, v.config, v.input),
    ).rejects.toThrow();
    expect(
      v.queries.some((query) => /^\s*(INSERT|UPDATE|DELETE)/.test(query)),
    ).toBe(false);
  });
  it("does not reinterpret provider evidence as a checkout fixture", async () => {
    const v = fixture();
    v.rows[4] = [
      {
        id: "native-proof",
        provenance: "PROVIDER",
        createdAt: new Date(now.getTime() - 60000),
      },
    ];
    await expect(
      prepareDemoSandboxCheckout(v.db, v.config, v.input),
    ).rejects.toThrow();
    expect(
      v.queries.some((query) => /^\s*(INSERT|UPDATE|DELETE)/.test(query)),
    ).toBe(false);
  });
  it("refreshes only its existing simulation when explicitly invoked again", async () => {
    const v = fixture();
    v.rows[3] = [
      {
        id: "demo-checkout-destination-account-one",
        version: 1,
        bankReference: "simulation:demo-checkout:account-one",
        bankState: "VERIFIED",
        isCurrent: true,
      },
    ];
    v.rows[4] = [
      {
        id: "previous-simulation",
        provenance: "SIMULATION",
        accountReference: "actual-account-one",
        recipientReference: "actual-wallet-one",
        operatorReference: "simulation-demo-checkout:holder-one",
        bankReference: "simulation:demo-checkout:account-one",
        createdAt: new Date(now.getTime() - 60000),
      },
    ];
    expect(
      await prepareDemoSandboxCheckout(v.db, v.config, v.input),
    ).toMatchObject({
      purpose: "GUEST_CHECKOUT_ONLY",
      expiresAt: new Date(now.getTime() + 300000).toISOString(),
    });
    expect(
      v.queries.some((query) =>
        /INSERT INTO receiving_destination/.test(query),
      ),
    ).toBe(false);
    expect(
      v.queries.filter((query) =>
        /INSERT INTO receiving_verification_evidence/.test(query),
      ),
    ).toHaveLength(1);
  });
  it.each([
    null,
    {
      version: 1,
      state: "PREPARED",
      url: "https://tunnel.example.test/v1/webhooks/asaas",
      providerWebhookId: "webhook-one",
    },
    {
      version: 1,
      state: "ARMED",
      url: "https://tunnel.example.test/v1/webhooks/asaas",
      providerWebhookId: "webhook-one",
    },
    {
      version: 1,
      state: "UPDATING",
      url: "https://tunnel.example.test/v1/webhooks/asaas",
      providerWebhookId: "webhook-one",
    },
    {
      version: 1,
      state: "REGISTERED",
      url: "https://old-tunnel.example.test/v1/webhooks/asaas",
      providerWebhookId: "webhook-one",
    },
    {
      version: 1,
      state: "REGISTERED",
      url: "https://tunnel.example.test/v1/webhooks/asaas",
      providerWebhookId: null,
    },
    {
      version: 1,
      state: "REGISTERED",
      url: "https://tunnel.example.test/v1/webhooks/asaas",
      providerWebhookId: "bad id",
    },
    {
      version: 2,
      state: "REGISTERED",
      url: "https://tunnel.example.test/v1/webhooks/asaas",
      providerWebhookId: "webhook-one",
    },
  ])(
    "requires completed remote webhook registration for the current tunnel",
    async (registration) => {
      const v = fixture();
      v.account.webhookRegistration = registration;
      await expect(
        prepareDemoSandboxCheckout(v.db, v.config, v.input),
      ).rejects.toThrow();
      expect(
        v.queries.some((query) => /^\s*(INSERT|UPDATE|DELETE)/.test(query)),
      ).toBe(false);
    },
  );
  it.each(["UNVERIFIED", "PENDING", "REJECTED", undefined])(
    "rejects an existing simulation destination with bank state %s without silently repairing it",
    async (bankState) => {
      const v = fixture();
      v.rows[3] = [
        {
          id: "demo-checkout-destination-account-one",
          version: 1,
          bankReference: "simulation:demo-checkout:account-one",
          bankState,
          isCurrent: true,
        },
      ];
      await expect(
        prepareDemoSandboxCheckout(v.db, v.config, v.input),
      ).rejects.toThrow();
      expect(
        v.queries.some((query) => /^\s*(INSERT|UPDATE|DELETE)/.test(query)),
      ).toBe(false);
    },
  );
});
