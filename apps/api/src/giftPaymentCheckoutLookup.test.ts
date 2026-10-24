import { drizzle, type NodePgClient } from "drizzle-orm/node-postgres";
import { describe, expect, it, vi } from "vitest";
import { hashAsaasEventIdentity } from "./asaasWebhook";
import { createGiftPaymentCheckoutLookup } from "./giftPaymentCheckoutLookup";
import type { GiftPaymentInboxClaim } from "./giftPaymentInboxRepository";

type Row = Record<string, unknown>;
const now = new Date("2026-10-12T18:00:00.000Z");
function fixture(rawTimestamps = false) {
  const claim: GiftPaymentInboxClaim = {
    eventId: "event.one",
    siteId: "site:one",
    accountId: "account.one",
    environment: "sandbox",
    leaseOwner: "worker.one",
    leaseToken: "lease:one",
    attempts: 2,
    paymentReference: "pay_one",
    providerAccountReference: "remote_account_one",
  };
  const scope = {
    site_id: claim.siteId,
    account_id: claim.accountId,
    environment: claim.environment,
  };
  const event: Row = {
    ...scope,
    id: claim.eventId,
    event_type: "PAYMENT_RECEIVED",
    provider_event_reference: "evt:one.1",
    payload: {
      paymentId: "pay_one",
      externalReference: "attempt:one",
      checkoutId: "checkout_one",
    },
    authenticated_at: new Date("2026-10-12T17:59:00.000Z"),
    received_at: new Date("2026-10-12T17:59:00.000Z"),
    state: "CLAIMED",
    lease_owner: claim.leaseOwner,
    lease_token: claim.leaseToken,
    attempts: claim.attempts,
    lease_expires_at: new Date("2026-10-12T18:00:30.000Z"),
    processed_at: null,
  };
  const account: Row = {
    ...scope,
    id: claim.accountId,
    provider: "ASAAS",
    account_reference: claim.providerAccountReference,
    is_current: false,
    receiving_capability: false,
    provider_account_state: "BLOCKED",
    credential_ciphertext: "private-encrypted-key",
  };
  const attempt: Row = {
    ...scope,
    id: "attempt:one",
    order_id: "order.one",
    operation_id: "operation.one",
    operation_kind: "CHECKOUT_CREATE",
    provider_reference: "checkout_one",
    hosted_url: "https://checkout.example/private",
  };
  const order: Row = {
    ...scope,
    id: "order.one",
    quote_id: "quote.one",
    recovery_token_hash: "private-capability-hash",
  };
  const quote: Row = {
    ...scope,
    id: "quote.one",
    snapshot: {
      receiving: {
        siteId: claim.siteId,
        environment: claim.environment,
        provider: "ASAAS",
        accountReference: claim.providerAccountReference,
      },
    },
    expires_at: new Date("2026-10-12T17:00:00.000Z"),
  };
  const operation: Row = {
    ...scope,
    id: "operation.one",
    order_id: "order.one",
    kind: "CHECKOUT_CREATE",
    state: "SUCCEEDED",
    provider_operation_reference: "checkout_one",
  };
  const tables = {
    events: [event],
    accounts: [account],
    attempts: [attempt],
    orders: [order],
    quotes: [quote],
    operations: [operation],
    payments: [] as Row[],
  };
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const faults = { failure: false, projection: {} as Row };
  const sameScope = (left: Row, right: Row) =>
    left.site_id === right.site_id &&
    left.account_id === right.account_id &&
    left.environment === right.environment;
  const query = vi.fn(
    async (statement: string | { text: string }, params: unknown[] = []) => {
      const sql = typeof statement === "string" ? statement : statement.text;
      queries.push({ sql, params });
      if (faults.failure) throw new Error("private-SQL-account-key");
      if (!/^SELECT/i.test(sql)) throw new Error("Lookup must only select");
      const parameter = (column: string) => {
        const match = sql.match(new RegExp(`e\\.${column}\\s*=\\s*\\$(\\d+)`));
        return match ? params[Number(match[1]) - 1] : undefined;
      };
      const sources: Array<Record<string, Row | null>> = [];
      for (const e of tables.events) {
        if (
          e.id !== parameter("id") ||
          e.site_id !== parameter("site_id") ||
          e.account_id !== parameter("account_id") ||
          e.environment !== parameter("environment") ||
          e.lease_owner !== parameter("lease_owner") ||
          e.lease_token !== parameter("lease_token") ||
          e.attempts !== parameter("attempts") ||
          e.state !== "CLAIMED" ||
          !(
            e.event_type === "PAYMENT_RECEIVED" ||
            (e.event_type === "PAYMENT_CONFIRMED" &&
              sql.includes("PAYMENT_CONFIRMED"))
          ) ||
          !(e.authenticated_at instanceof Date) ||
          e.authenticated_at > now ||
          !(e.received_at instanceof Date) ||
          e.received_at > e.authenticated_at ||
          !(e.lease_expires_at instanceof Date) ||
          e.lease_expires_at < now
        )
          continue;
        for (const account of tables.accounts.filter(
          (a) =>
            a.id === e.account_id &&
            a.site_id === e.site_id &&
            a.environment === e.environment,
        )) {
          const payload = e.payload as Row;
          const payments = tables.payments.filter(
            (p) =>
              sameScope(p, e) &&
              p.provider_payment_reference === payload?.paymentId,
          );
          for (const p of payments.length ? payments : [null]) {
            const candidates = tables.attempts.filter(
              (a) =>
                sameScope(a, e) &&
                (a.id === payload?.externalReference ||
                  a.provider_reference === payload?.checkoutId ||
                  (sql.match(/a\.provider_reference=\$(\d+)/)?.[1] !==
                    undefined &&
                    a.provider_reference ===
                      params[
                        Number(
                          sql.match(/a\.provider_reference=\$(\d+)/)?.[1],
                        ) - 1
                      ]) ||
                  (p && a.id === p.attempt_id && a.order_id === p.order_id)),
            );
            for (const a of candidates.length ? candidates : [null]) {
              const orders = a
                ? tables.orders.filter(
                    (o) => sameScope(o, a) && o.id === a.order_id,
                  )
                : [];
              for (const o of orders.length ? orders : [null]) {
                const quotes = o
                  ? tables.quotes.filter(
                      (q) => sameScope(q, o) && q.id === o.quote_id,
                    )
                  : [];
                const operations =
                  a && o
                    ? tables.operations.filter(
                        (op) =>
                          sameScope(op, a) &&
                          op.id === a.operation_id &&
                          op.order_id === o.id &&
                          op.kind === a.operation_kind,
                      )
                    : [];
                for (const q of quotes.length ? quotes : [null])
                  for (const op of operations.length ? operations : [null])
                    sources.push({ e, account, p, a, o, q, op });
              }
            }
          }
        }
      }
      const projection = sql
        .split(/FROM/i)[0]
        .replace(/^SELECT\s+/i, "")
        .split(",")
        .map((part) => part.trim());
      return {
        rows: sources.map((source) =>
          Object.fromEntries(
            projection.map((part) => {
              const field = part.match(
                /^([a-z]+)\.([a-z_]+)(?: AS "([^"]+)")?$/i,
              );
              if (field)
                return [
                  field[3] ?? field[2],
                  source[field[1]]?.[field[2]] ?? null,
                ];
              const json = part.match(
                /^q\.snapshot->'receiving'->>'([^']+)' AS "([^"]+)"$/,
              );
              if (json)
                return [
                  json[2],
                  (source.q?.snapshot as { receiving: Row } | undefined)
                    ?.receiving[json[1]] ?? null,
                ];
              const clock = part.match(/^clock_timestamp\(\) AS "([^"]+)"$/i);
              if (clock) return [clock[1], new Date(now)];
              throw new Error(`Unsupported selected projection: ${part}`);
            }),
          ),
        ),
      };
    },
  );
  const binding = {
    siteId: claim.siteId,
    accountId: claim.accountId,
    environment: claim.environment,
    accountReference: claim.providerAccountReference,
    orderId: "order.one",
    attemptId: "attempt:one",
    providerCheckoutReference: "checkout_one",
  };
  const rehash = () => {
    event.payload_hash = hashAsaasEventIdentity(
      event.provider_event_reference as string,
      event.event_type as string,
      account.account_reference as string,
      event.payload as Record<string, string>,
    );
  };
  rehash();
  return {
    lookup: createGiftPaymentCheckoutLookup(
      drizzle({
        query: async (...args: Parameters<typeof query>) => {
          const result = await query(...args);
          return {
            ...result,
            rows: result.rows.map((row) => ({
              ...Object.fromEntries(
                Object.entries(row).map(([key, value]) => [
                  key,
                  rawTimestamps && value instanceof Date
                    ? value.toISOString().replace("T", " ").replace("Z", "+00")
                    : value,
                ]),
              ),
              ...faults.projection,
            })),
          };
        },
      } as unknown as NodePgClient),
    ),
    claim,
    binding,
    event,
    account,
    attempt,
    order,
    quote,
    operation,
    tables,
    queries,
    faults,
    rehash,
    scope,
  };
}
function storedPayment(
  values: ReturnType<typeof fixture>,
  overrides: Row = {},
) {
  values.tables.payments.push({
    ...values.scope,
    id: "payment.one",
    provider_payment_reference: "pay_one",
    order_id: "order.one",
    attempt_id: "attempt:one",
    ...overrides,
  });
}

describe("durable payment checkout lookup", () => {
  it("resolves payment-only correlation from a server-observed checkout session", async () => {
    const values = fixture();
    values.event.payload = { paymentId: "pay_one" };
    values.rehash();
    expect(
      await values.lookup.loadCheckout(values.claim, "checkout_one"),
    ).toEqual(values.binding);
    expect(values.queries[0].params).toContain("checkout_one");
  });

  it("does not resolve a server-observed session from another account", async () => {
    const values = fixture();
    values.event.payload = { paymentId: "pay_one" };
    values.rehash();
    values.attempt.account_id = "foreign-account";
    expect(
      await values.lookup.loadCheckout(values.claim, "checkout_one"),
    ).toBeNull();
  });

  it("rejects contradictory native and event checkout references", async () => {
    const values = fixture();
    await expect(
      values.lookup.loadCheckout(values.claim, "other_checkout"),
    ).rejects.toMatchObject({ code: "PAYMENT_CHECKOUT_LOOKUP_UNAVAILABLE" });
  });

  it("rejects stale leases even with a server-observed session", async () => {
    const values = fixture();
    values.event.payload = { paymentId: "pay_one" };
    values.rehash();
    values.event.lease_token = "new-lease";
    await expect(
      values.lookup.loadCheckout(values.claim, "checkout_one"),
    ).rejects.toMatchObject({ code: "PAYMENT_CHECKOUT_LOOKUP_UNAVAILABLE" });
  });

  it("rejects malformed server-observed session before SQL", async () => {
    const values = fixture();
    await expect(
      values.lookup.loadCheckout(values.claim, "checkout:invalid"),
    ).rejects.toMatchObject({ code: "PAYMENT_CHECKOUT_LOOKUP_UNAVAILABLE" });
    expect(values.queries).toHaveLength(0);
  });

  it("resolves confirmed event correlation using its original authenticated hash", async () => {
    const values = fixture();
    values.event.event_type = "PAYMENT_CONFIRMED";
    values.event.payload_hash = hashAsaasEventIdentity(
      String(values.event.provider_event_reference),
      "PAYMENT_CONFIRMED",
      String(values.account.account_reference),
      values.event.payload as Record<string, string>,
    );
    expect(await values.lookup.loadCheckout(values.claim)).toEqual(
      values.binding,
    );
  });
  it("loads checkout evidence from raw Drizzle timestamps without weakening claim fences", async () => {
    const v = fixture(true);
    expect(await v.lookup.loadCheckout(v.claim)).toEqual(v.binding);
  });

  it("rejects projected authentication one microsecond after the database clock", async () => {
    const v = fixture(true);
    v.faults.projection.authenticatedAt = "2026-10-12 18:00:00.000001+00";
    await expect(v.lookup.loadCheckout(v.claim)).rejects.toMatchObject({
      code: "PAYMENT_CHECKOUT_LOOKUP_UNAVAILABLE",
    });
  });

  it.each(["external", "checkout", "payment", "all"])(
    "resolves %s correlation with the frozen historical account",
    async (correlation) => {
      const values = fixture();
      values.event.payload = {
        paymentId: "pay_one",
        ...(correlation === "external" || correlation === "all"
          ? { externalReference: "attempt:one" }
          : {}),
        ...(correlation === "checkout" || correlation === "all"
          ? { checkoutId: "checkout_one" }
          : {}),
      };
      if (correlation === "payment" || correlation === "all")
        storedPayment(values);
      values.rehash();
      expect(await values.lookup.loadCheckout(values.claim)).toEqual(
        values.binding,
      );
      expect(values.queries).toHaveLength(1);
      expect(values.queries[0].sql).not.toMatch(
        /FOR UPDATE|BEGIN|UPDATE|credential|hosted_url|recovery_token|is_current|receiving_capability|is_active/i,
      );
      expect(values.queries[0].sql).toContain("clock_timestamp()");
      expect(values.queries[0].sql).toMatch(/e\.attempts\s*=\s*\$/);
      expect(values.queries[0].params).toContain("lease:one");
      expect(JSON.stringify(values.binding)).not.toMatch(
        /private|hash|lease|payload/,
      );
    },
  );
  it("returns null when no local checkout correlation has been stored yet", async () => {
    const values = fixture();
    values.event.payload = { paymentId: "pay_one" };
    values.rehash();
    expect(await values.lookup.loadCheckout(values.claim)).toBeNull();
  });
  it("does not resolve a similarly named attempt from another site", async () => {
    const values = fixture();
    values.attempt.site_id = "foreign-site";
    expect(await values.lookup.loadCheckout(values.claim)).toBeNull();
  });
  it.each([
    "REQUESTED",
    "CLAIMED",
    "PROCESSING",
    "UNKNOWN",
    "FAILED",
    "CANCELLED",
  ])(
    "leaves %s hosted creation pending without inventing a provider reference",
    async (state) => {
      const values = fixture();
      values.operation.state = state;
      values.operation.provider_operation_reference = null;
      values.attempt.provider_reference = null;
      expect(await values.lookup.loadCheckout(values.claim)).toBeNull();
    },
  );
  it.each([
    { lease_owner: "new-worker" },
    { lease_token: "new-token" },
    { attempts: 3 },
    { site_id: "foreign-site" },
    { account_id: "foreign-account" },
    { environment: "live" },
    { state: "RETRY" },
    { event_type: "PAYMENT_UPDATED" },
    { authenticated_at: null },
    { authenticated_at: new Date("2026-10-12T18:01:00.000Z") },
    { lease_expires_at: new Date("2026-10-12T17:59:59.000Z") },
  ])("rejects missing or stale durable claim %j", async (change) => {
    const values = fixture();
    Object.assign(values.event, change);
    await expect(
      values.lookup.loadCheckout(values.claim),
    ).rejects.toMatchObject({
      status: 503,
      code: "PAYMENT_CHECKOUT_LOOKUP_UNAVAILABLE",
    });
  });
  it.each([
    {
      paymentId: "other_payment",
      externalReference: "attempt:one",
      checkoutId: "checkout_one",
    },
    {
      paymentId: "pay_one",
      externalReference: "other:attempt",
      checkoutId: "checkout_one",
    },
    {
      paymentId: "pay_one",
      externalReference: "attempt:one",
      checkoutId: "other_checkout",
    },
    {
      paymentId: "pay_one",
      externalReference: "attempt:one",
      checkoutId: null,
    },
    {
      paymentId: "pay_one",
      externalReference: "attempt:one",
      payer: "private",
    },
    {
      paymentId: "pay_one",
      externalReference: "attempt:one",
      checkoutId: "checkout:unsafe",
    },
  ])(
    "never lets one matching correlation bypass contradictory event payload %j",
    async (payload) => {
      const values = fixture();
      values.event.payload = payload;
      values.rehash();
      await expect(
        values.lookup.loadCheckout(values.claim),
      ).rejects.toMatchObject({ code: "PAYMENT_CHECKOUT_LOOKUP_UNAVAILABLE" });
    },
  );
  it("rejects a scoped stored payment pointing to another attempt even if the event matches", async () => {
    const values = fixture();
    storedPayment(values, {
      attempt_id: "other-attempt",
      order_id: "other-order",
    });
    await expect(
      values.lookup.loadCheckout(values.claim),
    ).rejects.toMatchObject({ code: "PAYMENT_CHECKOUT_LOOKUP_UNAVAILABLE" });
  });
  it("rejects a contradictory operation reference while hosted creation is still UNKNOWN", async () => {
    const values = fixture();
    values.operation.state = "UNKNOWN";
    values.attempt.provider_reference = null;
    values.operation.provider_operation_reference = "different_checkout";
    await expect(
      values.lookup.loadCheckout(values.claim),
    ).rejects.toMatchObject({
      code: "PAYMENT_CHECKOUT_LOOKUP_UNAVAILABLE",
    });
  });
  it.each(["attempt", "operation", "payment"])(
    "rejects duplicate %s storage instead of taking the first result",
    async (kind) => {
      const values = fixture();
      if (kind === "attempt")
        values.tables.attempts.push({ ...values.attempt });
      if (kind === "operation")
        values.tables.operations.push({ ...values.operation });
      if (kind === "payment") {
        storedPayment(values);
        storedPayment(values, { id: "payment.two" });
      }
      await expect(
        values.lookup.loadCheckout(values.claim),
      ).rejects.toMatchObject({ code: "PAYMENT_CHECKOUT_LOOKUP_UNAVAILABLE" });
    },
  );
  it.each([
    "account",
    "quote-account",
    "quote-env",
    "quote-missing",
    "order-missing",
    "operation-missing",
    "kind",
    "provider-ref",
    "missing-ref",
    "malformed-ref",
    "hash",
  ])("rejects malformed stored binding: %s", async (change) => {
    const values = fixture();
    if (change === "account")
      values.account.account_reference = "wrong_account";
    if (change === "quote-account")
      (values.quote.snapshot as { receiving: Row }).receiving.accountReference =
        "wrong_account";
    if (change === "quote-env")
      (values.quote.snapshot as { receiving: Row }).receiving.environment =
        "live";
    if (change === "quote-missing") values.tables.quotes.length = 0;
    if (change === "order-missing") values.tables.orders.length = 0;
    if (change === "operation-missing") values.tables.operations.length = 0;
    if (change === "kind") values.attempt.operation_kind = "WITHDRAWAL";
    if (change === "provider-ref")
      values.operation.provider_operation_reference = "other_checkout";
    if (change === "missing-ref")
      values.operation.provider_operation_reference = null;
    if (change === "malformed-ref")
      values.operation.provider_operation_reference = "checkout.unsafe";
    if (change === "hash") values.event.payload_hash = "0".repeat(64);
    await expect(
      values.lookup.loadCheckout(values.claim),
    ).rejects.toMatchObject({ code: "PAYMENT_CHECKOUT_LOOKUP_UNAVAILABLE" });
  });
  it("sanitizes SQL errors and returns only the checkout binding projection", async () => {
    const values = fixture();
    values.faults.failure = true;
    await expect(
      values.lookup.loadCheckout(values.claim),
    ).rejects.toMatchObject({
      status: 503,
      code: "PAYMENT_CHECKOUT_LOOKUP_UNAVAILABLE",
      message: "Payment checkout lookup unavailable",
    });
    values.faults.failure = false;
    const result = await values.lookup.loadCheckout(values.claim);
    expect(Object.keys(result ?? {}).sort()).toEqual(
      Object.keys(values.binding).sort(),
    );
  });
  it("copies the original claim before waiting for the database", async () => {
    const values = fixture();
    const pending = values.lookup.loadCheckout(values.claim);
    values.claim.leaseToken = "mutated";
    expect(await pending).toEqual(values.binding);
  });
  it.each([
    { attempts: 0 },
    { paymentReference: "pay:invalid" },
    { providerAccountReference: "remote.invalid" },
    { siteId: "invalid space" },
    { environment: "disabled" },
    { now: new Date(now) },
  ])(
    "rejects caller-selected malformed claims %j before SQL",
    async (change) => {
      const values = fixture();
      Object.assign(values.claim, change);
      await expect(
        values.lookup.loadCheckout(values.claim),
      ).rejects.toMatchObject({ code: "PAYMENT_CHECKOUT_LOOKUP_UNAVAILABLE" });
      expect(values.queries).toHaveLength(0);
    },
  );
});
