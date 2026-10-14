import { drizzle, type NodePgClient } from "drizzle-orm/node-postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AsaasStoredAccountReaderOptions,
  createAsaasStoredAccountReader,
} from "./asaasStoredAccountReader";
import type { FinancialAccountBinding } from "./financialOverview";
import type { GiftPaymentInboxClaim } from "./giftPaymentInboxRepository";
import {
  createProviderCredentialCryptoForTests,
  type ProviderCredentialContext,
} from "./providerCredentials";

type Row = Record<string, unknown>;
const instant = new Date("2026-10-12T18:30:00.000Z");
const syntheticSandboxToken = "$aact_hmlg_offline-stored-account-token";
const syntheticLiveToken = "$aact_prod_offline-stored-account-token";
function fixture(
  mode: "disabled" | "sandbox" | "live" = "sandbox",
  applicationEnvironment: "development" | "test" | "production" = "test",
) {
  const environment = mode === "live" ? "live" : "sandbox";
  const binding: FinancialAccountBinding = {
    provider: "ASAAS",
    siteId: "site:one",
    accountBindingId: "account.one",
    accountReference: "remote_account_one",
    environment,
  };
  const claim: GiftPaymentInboxClaim = {
    siteId: binding.siteId,
    accountId: binding.accountBindingId,
    environment,
    eventId: "event.one",
    leaseOwner: "worker.one",
    leaseToken: "original:token",
    attempts: 2,
    paymentReference: "pay_one",
    providerAccountReference: binding.accountReference,
  };
  const clock = { value: new Date(instant), database: new Date(instant) };
  const key = new Uint8Array(32).fill(17);
  const keyring = new Map([["key.one", key]]);
  const crypto = createProviderCredentialCryptoForTests(() =>
    new Uint8Array(12).fill(23),
  );
  const context: ProviderCredentialContext = {
    provider: "ASAAS" as const,
    siteId: binding.siteId,
    accountBindingId: binding.accountBindingId,
    environment,
  };
  const token = mode === "live" ? syntheticLiveToken : syntheticSandboxToken;
  const envelope = crypto.encryptProviderCredential(
    token,
    context,
    keyring,
    "key.one",
  );
  const site: Row = {
    id: binding.siteId,
    is_demo: false,
    lifecycle: "ARCHIVED",
  };
  const account: Row = {
    id: binding.accountBindingId,
    site_id: binding.siteId,
    environment,
    provider: "ASAAS",
    account_reference: binding.accountReference,
    is_current: false,
    provider_account_state: "BLOCKED",
    receiving_capability: false,
    credential_version: envelope.version,
    credential_key_id: envelope.keyId,
    credential_nonce: envelope.nonce,
    credential_ciphertext: envelope.ciphertext,
    credential_tag: envelope.tag,
  };
  const event: Row = {
    id: claim.eventId,
    site_id: claim.siteId,
    account_id: claim.accountId,
    environment,
    event_type: "PAYMENT_RECEIVED",
    state: "CLAIMED",
    lease_owner: claim.leaseOwner,
    lease_token: claim.leaseToken,
    attempts: claim.attempts,
    payload: { paymentId: claim.paymentReference },
    authenticated_at: new Date("2026-10-12T18:29:00.000Z"),
    received_at: new Date("2026-10-12T18:29:00.000Z"),
    lease_expires_at: new Date("2026-10-12T18:31:00.000Z"),
    processed_at: null,
  };
  const tables = { sites: [site], accounts: [account], events: [event] };
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const faults = {
    sql: false,
    network: false,
    hang: false,
    status: 200,
    duplicate: false,
    override: {} as Row,
  };
  const query = vi.fn(
    async (statement: string | { text: string }, params: unknown[] = []) => {
      const sql = typeof statement === "string" ? statement : statement.text;
      queries.push({ sql, params });
      if (faults.sql) throw new Error("private-database-envelope-detail");
      if (!/^SELECT/i.test(sql))
        throw new Error("Reader cannot mutate stored data");
      const parameter = (alias: string, column: string) => {
        const match = sql.match(
          new RegExp(`${alias}\\.${column}\\s*=\\s*\\$(\\d+)`),
        );
        return match ? params[Number(match[1]) - 1] : undefined;
      };
      const sources: Array<{ a: Row; st: Row }> = [];
      for (const a of tables.accounts.filter(
        (a) =>
          a.id === parameter("a", "id") &&
          a.site_id === parameter("a", "site_id") &&
          a.environment === parameter("a", "environment") &&
          a.account_reference === parameter("a", "account_reference"),
      )) {
        for (const st of tables.sites.filter((st) => st.id === a.site_id)) {
          if (sql.includes('"financial_event_inbox"')) {
            const matching = tables.events.some(
              (e) =>
                e.id === parameter("e", "id") &&
                e.site_id === a.site_id &&
                e.account_id === a.id &&
                e.environment === a.environment &&
                e.lease_owner === parameter("e", "lease_owner") &&
                e.lease_token === parameter("e", "lease_token") &&
                e.attempts === parameter("e", "attempts") &&
                e.state === "CLAIMED" &&
                e.event_type === "PAYMENT_RECEIVED" &&
                e.processed_at === null &&
                (e.payload as Row).paymentId === claim.paymentReference &&
                e.authenticated_at instanceof Date &&
                e.authenticated_at <= clock.database &&
                e.received_at instanceof Date &&
                e.received_at <= e.authenticated_at &&
                e.lease_expires_at instanceof Date &&
                e.lease_expires_at >= clock.database,
            );
            if (!matching) continue;
          }
          sources.push({ a, st });
        }
      }
      if (faults.duplicate && sources[0]) sources.push(sources[0]);
      const projection = sql
        .split(/FROM/i)[0]
        .replace(/^SELECT\s+/i, "")
        .split(",")
        .map((part) => part.trim());
      return {
        rows: sources.map((source) => ({
          ...Object.fromEntries(
            projection.map((part) => {
              const field = part.match(/^(a|st)\.([a-z_]+) AS "([^"]+)"$/);
              if (!field)
                throw new Error(`Unexpected credential projection: ${part}`);
              return [field[3], source[field[1] as "a" | "st"][field[2]]];
            }),
          ),
          ...faults.override,
        })),
      };
    },
  );
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async (url) => {
      if (faults.network) throw new Error(`${token} private-network-detail`);
      if (faults.hang) return new Promise<Response>(() => undefined);
      const payment = {
        id: "pay_one",
        checkoutSession: "checkout_one",
        externalReference: "attempt:one",
        status: "RECEIVED",
        billingType: "PIX",
        value: 102.39,
        netValue: 102,
        split: [
          {
            id: "split_one",
            walletId: "platform_one",
            status: "DONE",
            fixedValue: 2,
            totalValue: 2,
          },
        ],
        customer: { name: "private-payer" },
        apiKey: token,
      };
      return new Response(
        JSON.stringify(
          String(url).includes("/payments/")
            ? payment
            : { balance: 123.45, apiKey: token },
        ),
        {
          status: faults.status,
          headers: { "content-type": "application/json" },
        },
      );
    });
  const db = drizzle({ query } as unknown as NodePgClient);
  const options: AsaasStoredAccountReaderOptions = {
    mode,
    applicationEnvironment,
    keyring,
    fetch,
    timeoutMs: 100,
    maxResponseBytes: 4096,
    now: () => new Date(clock.value),
  };
  return {
    reader: createAsaasStoredAccountReader(db, options),
    db,
    options,
    claim,
    binding,
    clock,
    key,
    keyring,
    crypto,
    context,
    token,
    envelope,
    site,
    account,
    event,
    tables,
    queries,
    fetch,
    faults,
  };
}
async function rejectsSafely(
  operation: Promise<unknown>,
  values: ReturnType<typeof fixture>,
) {
  const error = await operation.catch((error) => error);
  expect(error).toMatchObject({
    status: 503,
    code: "ASAAS_STORED_ACCOUNT_UNAVAILABLE",
    message: "Stored provider account is unavailable",
  });
  expect(error).not.toHaveProperty("cause");
  if (!(error instanceof Error)) throw new Error("Expected a sanitized error");
  const serialized = JSON.stringify(error) + String(error.stack);
  for (const secret of [
    values.token,
    values.envelope.ciphertext,
    values.envelope.tag,
    "private-network-detail",
    "private-database-envelope-detail",
  ])
    expect(serialized).not.toContain(secret);
}
afterEach(() => vi.useRealTimers());
describe("server-only stored Asaas account reads", () => {
  it("decrypts the stored sandbox credential and fetches only the original claimed payment", async () => {
    const values = fixture();
    const result = await values.reader.getPayment(values.claim);
    expect(result).toMatchObject({
      source: "provider",
      provider: "ASAAS",
      siteId: values.claim.siteId,
      accountReference: values.claim.providerAccountReference,
      environment: "sandbox",
      currency: "BRL",
      observedAt: instant,
      payment: {
        id: "pay_one",
        value: "102.39",
        netValue: "102.00",
        split: [{ fixedValue: "2.00", totalValue: "2.00" }],
      },
    });
    expect(values.fetch).toHaveBeenCalledTimes(1);
    const [url, request] = values.fetch.mock.calls[0];
    expect(url).toBe("https://api-sandbox.asaas.com/v3/payments/pay_one");
    expect(request).toMatchObject({
      method: "GET",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    });
    expect(new Headers(request?.headers).get("access_token")).toBe(
      values.token,
    );
    expect(JSON.stringify(result)).not.toMatch(
      /private|credential|ciphertext|apiKey|customer|leaseToken/,
    );
    expect(values.queries).toHaveLength(1);
    expect(values.queries[0].sql).toContain("clock_timestamp()");
    expect(values.queries[0].sql).not.toMatch(
      /FOR UPDATE|BEGIN|is_current|receiving_capability|provider_account_state|lifecycle/,
    );
    expect(values.key).toEqual(new Uint8Array(32).fill(17));
  });
  it("reads balance for the exact stored inactive binding without asserting account approval", async () => {
    const values = fixture();
    expect(await values.reader.getBalance(values.binding)).toEqual({
      source: "provider",
      ...values.binding,
      currency: "BRL",
      observedAt: instant,
      balanceCents: 12345,
    });
    expect(values.fetch.mock.calls[0][0]).toBe(
      "https://api-sandbox.asaas.com/v3/finance/balance",
    );
    expect(values.queries[0].sql).not.toContain('"financial_event_inbox"');
    const projection = values.queries[0].sql.split(/FROM/i)[0];
    expect(projection).not.toMatch(
      /operator|recipient|bank|webhook|authorization|payer/,
    );
  });
  it("pins options and copies externally owned keyring bytes before later mutation", async () => {
    const values = fixture();
    values.key.fill(0);
    values.keyring.clear();
    values.options.mode = "live";
    values.options.applicationEnvironment = "production";
    values.options.fetch = vi.fn();
    values.options.timeoutMs = 0;
    values.options.maxResponseBytes = 0;
    values.options.now = () => new Date(Number.NaN);
    expect((await values.reader.getPayment(values.claim)).environment).toBe(
      "sandbox",
    );
    expect((await values.reader.getBalance(values.binding)).balanceCents).toBe(
      12345,
    );
    expect(values.fetch).toHaveBeenCalledTimes(2);
  });
  it("reads live only in production using a live envelope, prefix and fixed origin", async () => {
    const values = fixture("live", "production");
    expect((await values.reader.getBalance(values.binding)).environment).toBe(
      "live",
    );
    expect(values.fetch.mock.calls[0][0]).toBe(
      "https://api.asaas.com/v3/finance/balance",
    );
    expect(
      new Headers(values.fetch.mock.calls[0][1]?.headers).get("access_token"),
    ).toBe(syntheticLiveToken);
  });
  it.each(["development", "test"] as const)(
    "denies live in %s before SQL or HTTP",
    async (applicationEnvironment) => {
      const values = fixture("live", applicationEnvironment);
      await rejectsSafely(values.reader.getPayment(values.claim), values);
      await rejectsSafely(values.reader.getBalance(values.binding), values);
      expect(values.queries).toHaveLength(0);
      expect(values.fetch).not.toHaveBeenCalled();
    },
  );
  it("denies disabled mode before SQL or HTTP", async () => {
    const values = fixture("disabled");
    await rejectsSafely(values.reader.getPayment(values.claim), values);
    await rejectsSafely(values.reader.getBalance(values.binding), values);
    expect(values.queries).toHaveLength(0);
    expect(values.fetch).not.toHaveBeenCalled();
  });
  it.each([{ isDemo: true }, { isDemo: null }])(
    "denies a live demo or malformed stored demo flag %j",
    async (override) => {
      const values = fixture("live", "production");
      values.faults.override = override;
      await rejectsSafely(values.reader.getBalance(values.binding), values);
      expect(values.fetch).not.toHaveBeenCalled();
    },
  );
  it.each([
    { siteId: "foreign:site" },
    { accountBindingId: "foreign.account" },
    { environment: "live" },
    { provider: "OTHER" },
    { accountReference: "other_remote_account" },
    { accountReference: "invalid.ref" },
    { bankReference: "client-bank" },
  ])(
    "rejects mismatched or client-expanded balance binding %j",
    async (change) => {
      const values = fixture();
      Object.assign(values.binding, change);
      await rejectsSafely(values.reader.getBalance(values.binding), values);
      expect(values.fetch).not.toHaveBeenCalled();
    },
  );
  it.each([
    { siteId: "foreign:site" },
    { accountId: "foreign.account" },
    { environment: "live" },
    { providerAccountReference: "other_remote_account" },
    { paymentReference: "pay/other" },
    { leaseToken: "stale-token" },
    { leaseOwner: "stale-worker" },
    { attempts: 1 },
    { attempts: 0 },
    { origin: "https://client.invalid" },
  ])("rejects mismatched original payment claim %j", async (change) => {
    const values = fixture();
    Object.assign(values.claim, change);
    await rejectsSafely(values.reader.getPayment(values.claim), values);
    expect(values.fetch).not.toHaveBeenCalled();
  });
  it.each([
    { state: "RETRY" },
    { lease_token: "newer-token" },
    { attempts: 3 },
    { lease_expires_at: new Date("2026-10-12T18:29:59.000Z") },
    { payload: { paymentId: "other_payment" } },
    { authenticated_at: null },
  ])("rejects stale stored claim authority %j", async (change) => {
    const values = fixture();
    Object.assign(values.event, change);
    await rejectsSafely(values.reader.getPayment(values.claim), values);
    expect(values.fetch).not.toHaveBeenCalled();
  });
  it.each([
    "missing",
    "duplicate",
    "wrong-provider",
    "wrong-site",
    "wrong-account",
    "wrong-environment",
    "wrong-reference",
  ])("denies %s projected account storage before HTTP", async (change) => {
    const values = fixture();
    if (change === "missing") values.tables.accounts.length = 0;
    if (change === "duplicate") values.faults.duplicate = true;
    if (change === "wrong-provider")
      values.faults.override = { provider: "OTHER" };
    if (change === "wrong-site")
      values.faults.override = { siteId: "foreign-site" };
    if (change === "wrong-account")
      values.faults.override = { accountBindingId: "foreign-account" };
    if (change === "wrong-environment")
      values.faults.override = { environment: "live" };
    if (change === "wrong-reference")
      values.faults.override = { accountReference: "other_reference" };
    await rejectsSafely(values.reader.getBalance(values.binding), values);
    expect(values.fetch).not.toHaveBeenCalled();
  });
  it.each([
    { credential_version: null },
    { credential_version: 2 },
    { credential_key_id: null },
    { credential_key_id: "missing-key" },
    { credential_nonce: null },
    { credential_nonce: "not-base64url==" },
    { credential_ciphertext: "" },
    { credential_tag: null },
    { credential_tag: "AA" },
  ])(
    "rejects malformed or unavailable encrypted credentials %j",
    async (change) => {
      const values = fixture();
      Object.assign(values.account, change);
      await rejectsSafely(values.reader.getBalance(values.binding), values);
      expect(values.fetch).not.toHaveBeenCalled();
    },
  );
  it.each(["site", "account", "environment", "tag", "ciphertext"])(
    "rejects authenticated envelope tamper in %s",
    async (change) => {
      const values = fixture();
      if (["site", "account", "environment"].includes(change)) {
        const context = {
          ...values.context,
          ...(change === "site"
            ? { siteId: "other-site" }
            : change === "account"
              ? { accountBindingId: "other-account" }
              : { environment: "live" as const }),
        };
        const envelope = values.crypto.encryptProviderCredential(
          values.token,
          context,
          values.keyring,
          "key.one",
        );
        Object.assign(values.account, {
          credential_nonce: envelope.nonce,
          credential_ciphertext: envelope.ciphertext,
          credential_tag: envelope.tag,
        });
      } else {
        const field =
          change === "tag" ? "credential_tag" : "credential_ciphertext";
        const bytes = Buffer.from(values.account[field] as string, "base64url");
        bytes[0] ^= 1;
        values.account[field] = bytes.toString("base64url");
      }
      await rejectsSafely(values.reader.getPayment(values.claim), values);
      expect(values.fetch).not.toHaveBeenCalled();
    },
  );
  it("decrypts an older keyId after the selected keyring grows for rotation", async () => {
    const values = fixture();
    values.keyring.set("key.two", new Uint8Array(32).fill(33));
    const reader = createAsaasStoredAccountReader(values.db, values.options);
    values.keyring.delete("key.one");
    expect((await reader.getBalance(values.binding)).balanceCents).toBe(12345);
  });
  it("rejects an authenticated credential with the wrong environment prefix before HTTP", async () => {
    const values = fixture();
    const envelope = values.crypto.encryptProviderCredential(
      syntheticLiveToken,
      values.context,
      values.keyring,
      "key.one",
    );
    Object.assign(values.account, {
      credential_nonce: envelope.nonce,
      credential_ciphertext: envelope.ciphertext,
      credential_tag: envelope.tag,
    });
    await rejectsSafely(values.reader.getBalance(values.binding), values);
    expect(values.fetch).not.toHaveBeenCalled();
  });
  it.each(["SQL", "network", "status", "response-limit"])(
    "sanitizes %s errors without credential or envelope disclosure",
    async (change) => {
      const values = fixture();
      let reader = values.reader;
      if (change === "SQL") values.faults.sql = true;
      if (change === "network") values.faults.network = true;
      if (change === "status") values.faults.status = 403;
      if (change === "response-limit")
        reader = createAsaasStoredAccountReader(values.db, {
          ...values.options,
          maxResponseBytes: 1,
        });
      await rejectsSafely(reader.getPayment(values.claim), values);
    },
  );
  it("enforces the native total HTTP deadline with a non-cooperative fetch", async () => {
    vi.useFakeTimers();
    const values = fixture();
    let releaseFetch!: (response: Response) => void;
    const fetchCompletion = new Promise<Response>((resolve) => {
      releaseFetch = resolve;
    });
    let releaseCancellation!: () => void;
    const cancellationCompletion = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    const cancelled = vi.fn(() => cancellationCompletion);
    const lateResponse = new Response(
      new ReadableStream({ cancel: cancelled }),
      { headers: { "content-type": "application/json" } },
    );
    values.fetch.mockReturnValueOnce(fetchCompletion);
    let settled = false;
    const completion = values.reader.getBalance(values.binding).then(
      (value) => {
        settled = true;
        return { value, error: undefined };
      },
      (error: unknown) => {
        settled = true;
        return { value: undefined, error };
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(101);
      expect(settled).toBe(false);
      expect(values.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
      expect(values.fetch).toHaveBeenCalledTimes(1);
      releaseFetch(lateResponse);
      await vi.advanceTimersByTimeAsync(0);
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
    } finally {
      releaseFetch(lateResponse);
      releaseCancellation();
      await completion;
    }
    const outcome = await completion;
    expect(outcome.value).toBeUndefined();
    await rejectsSafely(Promise.reject(outcome.error), values);
    expect(values.fetch).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("copies caller binding and claim before the first asynchronous lookup", async () => {
    const values = fixture();
    const payment = values.reader.getPayment(values.claim);
    values.claim.providerAccountReference = "mutated_ref";
    values.claim.leaseToken = "mutated_token";
    expect((await payment).accountReference).toBe("remote_account_one");
    const balance = values.reader.getBalance(values.binding);
    values.binding.accountReference = "mutated_balance_ref";
    expect((await balance).accountReference).toBe("remote_account_one");
  });
  it.each([
    { timeoutMs: 0 },
    { timeoutMs: 30001 },
    { maxResponseBytes: 0 },
    { maxResponseBytes: 1048577 },
    { applicationEnvironment: "preview" },
    { mode: "browser" },
  ])("rejects invalid server configuration %j", async (change) => {
    const values = fixture();
    expect(() =>
      createAsaasStoredAccountReader(values.db, {
        ...values.options,
        ...change,
      } as AsaasStoredAccountReaderOptions),
    ).toThrow("Stored provider account is unavailable");
    expect(values.queries).toHaveLength(0);
    expect(values.fetch).not.toHaveBeenCalled();
  });
  it("rejects invalid key bytes without modifying the caller's buffer", async () => {
    const values = fixture();
    const key = new Uint8Array(31).fill(42);
    expect(() =>
      createAsaasStoredAccountReader(values.db, {
        ...values.options,
        keyring: new Map([["key.one", key]]),
      }),
    ).toThrow("Stored provider account is unavailable");
    expect(key).toEqual(new Uint8Array(31).fill(42));
  });
});
