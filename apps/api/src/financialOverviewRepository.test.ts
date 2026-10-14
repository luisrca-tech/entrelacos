import { drizzle, type NodePgClient } from "drizzle-orm/node-postgres";
import { describe, expect, it, vi } from "vitest";
import { hashAsaasEventIdentity } from "./asaasWebhook";
import {
  type FinancialAccountBinding,
  loadFinancialOverview,
} from "./financialOverview";
import { createFinancialOverviewRepository } from "./financialOverviewRepository";
import { giftReceivedEffectKey } from "./giftPaymentReconciliation";

type Row = Record<string, unknown>;
const instant = new Date("2026-10-12T19:00:00.000Z");
const zeros = {
  nominalReceivedCents: 0,
  netReceivedCents: 0,
  processingCents: 0,
  commissionCents: 0,
  awaitingReleaseCents: 0,
  pendingCommitmentsCents: 0,
  withdrawnCents: 0,
  refundedCents: 0,
};
function fixture() {
  const binding: FinancialAccountBinding = {
    provider: "ASAAS",
    siteId: "site-one",
    accountBindingId: "account-one",
    accountReference: "remote_one",
    environment: "sandbox",
  };
  const scope = {
    site_id: binding.siteId,
    account_id: binding.accountBindingId,
    environment: binding.environment,
  };
  const site: Row = {
    id: binding.siteId,
    is_demo: false,
    lifecycle: "ARCHIVED",
  };
  const account: Row = {
    id: binding.accountBindingId,
    site_id: binding.siteId,
    environment: binding.environment,
    provider: "ASAAS",
    account_reference: binding.accountReference,
    is_current: false,
    provider_account_state: "BLOCKED",
    receiving_capability: false,
  };
  const tables: Record<string, Row[]> = {
    sites: [site],
    accounts: [account],
    payments: [],
    orders: [],
    quotes: [],
    attempts: [],
    operations: [],
    ledgers: [],
    events: [],
    withdrawals: [],
  };
  const clock = { value: new Date(instant), database: instant as unknown };
  const faults = {
    query: "",
    override: {} as Row,
    mutateAfterBinding: false,
    commit: false,
  };
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let snapshot: typeof tables | null = null;
  const sameScope = (left: Row, right: Row) =>
    left.site_id === right.site_id &&
    left.account_id === right.account_id &&
    left.environment === right.environment;
  const query = vi.fn(
    async (statement: string | { text: string }, params: unknown[] = []) => {
      const sql = typeof statement === "string" ? statement : statement.text;
      queries.push({ sql, params });
      if (/^begin/i.test(sql)) {
        snapshot = structuredClone(tables);
        return { rows: [] };
      }
      if (/^commit/i.test(sql) && faults.commit)
        throw new Error("private commit uncertainty");
      if (/^(commit|rollback)/i.test(sql)) {
        snapshot = null;
        return { rows: [] };
      }
      if (faults.query && sql.includes(faults.query))
        throw new Error("private SQL/provider detail");
      if (!/^SELECT/i.test(sql)) throw new Error("Totals must only select");
      const data = snapshot ?? tables;
      const parameter = (alias: string, column: string) => {
        const match = sql.match(
          new RegExp(`${alias}\\.${column}\\s*=\\s*\\$(\\d+)`),
        );
        return match ? params[Number(match[1]) - 1] : undefined;
      };
      let sources: Array<Record<string, Row | null>> = [];
      if (/FROM "receiving_account" a/.test(sql)) {
        for (const a of data.accounts.filter(
          (a) =>
            a.id === parameter("a", "id") &&
            a.site_id === parameter("a", "site_id") &&
            a.environment === parameter("a", "environment"),
        )) {
          for (const st of data.sites.filter((st) => st.id === a.site_id))
            sources.push({ a, st });
        }
        if (faults.mutateAfterBinding)
          tables.events.push({
            ...scope,
            id: "unseen-event",
            event_type: "PAYMENT_RECEIVED",
          });
      } else if (/FROM "gift_payment_record" p/.test(sql)) {
        for (const p of data.payments.filter(
          (p) =>
            p.site_id === parameter("p", "site_id") &&
            p.account_id === parameter("p", "account_id") &&
            p.environment === parameter("p", "environment"),
        )) {
          const o =
            data.orders.find((o) => sameScope(o, p) && o.id === p.order_id) ??
            null;
          const q = o
            ? (data.quotes.find(
                (q) => sameScope(q, o) && q.id === o.quote_id,
              ) ?? null)
            : null;
          const a =
            data.attempts.find(
              (a) =>
                sameScope(a, p) &&
                a.id === p.attempt_id &&
                a.order_id === p.order_id,
            ) ?? null;
          const op = a
            ? (data.operations.find(
                (op) =>
                  sameScope(op, a) &&
                  op.id === a.operation_id &&
                  op.order_id === p.order_id &&
                  op.kind === a.operation_kind,
              ) ?? null)
            : null;
          sources.push({ p, o, q, a, op });
        }
      } else {
        const matched = sql.match(
          /FROM "(financial_ledger_entry|financial_event_inbox|financial_operation|withdrawal_intent)" (l|e|op|w)/,
        );
        if (!matched) throw new Error("Unexpected totals table");
        const table = (
          {
            financial_ledger_entry: "ledgers",
            financial_event_inbox: "events",
            financial_operation: "operations",
            withdrawal_intent: "withdrawals",
          } as Record<string, string>
        )[matched[1]];
        const alias = matched[2];
        sources = data[table]
          .filter(
            (row) =>
              row.site_id === parameter(alias, "site_id") &&
              row.account_id === parameter(alias, "account_id") &&
              row.environment === parameter(alias, "environment"),
          )
          .map((row) => ({ [alias]: row }));
      }
      const projection = sql
        .split(/FROM/i)[0]
        .replace(/^SELECT\s+/i, "")
        .split(",")
        .map((part) => part.trim());
      return {
        rows: sources.map((source) => ({
          ...Object.fromEntries(
            projection.map((part) => {
              const field = part.match(/^([a-z]+)\.([a-z_]+) AS "([^"]+)"$/);
              if (field)
                return [field[3], source[field[1]]?.[field[2]] ?? null];
              const json = part.match(
                /^q\.snapshot->'receiving'->>'([^']+)' AS "([^"]+)"$/,
              );
              if (json)
                return [
                  json[2],
                  (source.q?.snapshot as { receiving: Row } | undefined)
                    ?.receiving[json[1]] ?? null,
                ];
              if (part === 'clock_timestamp() AS "observedAt"')
                return ["observedAt", clock.database];
              throw new Error(`Unsupported actual projection: ${part}`);
            }),
          ),
          ...faults.override,
        })),
      };
    },
  );
  const db = drizzle({ query } as unknown as NodePgClient);
  const options = {
    environment: "sandbox" as "sandbox" | "live",
    now: () => new Date(clock.value),
  };
  return {
    repository: createFinancialOverviewRepository(db, options),
    db,
    options,
    binding,
    scope,
    site,
    account,
    tables,
    clock,
    faults,
    queries,
  };
}
function received(
  values: ReturnType<typeof fixture>,
  suffix = "one",
  status = "RECEIVED",
) {
  const p: Row = {
    ...values.scope,
    id: `payment-${suffix}`,
    order_id: `order-${suffix}`,
    attempt_id: `attempt-${suffix}`,
    provider_payment_reference: `pay_${suffix}`,
    provider_status: status,
    verification_status: "VERIFIED",
    observed_at: new Date("2026-10-12T18:55:00.000Z"),
    created_at: new Date("2026-10-12T18:56:00.000Z"),
    currency: "BRL",
    gross_cents: 10239,
    processing_cents: 39,
    commission_cents: 200,
    recipient_net_cents: 10000,
    split_provider_reference: `split_${suffix}`,
    split_fixed_cents: 200,
  };
  const o: Row = {
    ...values.scope,
    id: p.order_id,
    quote_id: `quote-${suffix}`,
    created_at: new Date("2026-10-12T18:50:00.000Z"),
  };
  const q: Row = {
    ...values.scope,
    id: o.quote_id,
    currency: "BRL",
    nominal_cents: 10000,
    commission_basis_points: 200,
    commission_cents: 200,
    processing_cents: 39,
    total_cents: 10239,
    snapshot: {
      receiving: {
        siteId: values.binding.siteId,
        environment: values.binding.environment,
        provider: "ASAAS",
        accountReference: values.binding.accountReference,
      },
    },
  };
  const a: Row = {
    ...values.scope,
    id: p.attempt_id,
    order_id: o.id,
    operation_id: p.attempt_id,
    operation_kind: "CHECKOUT_CREATE",
    provider_reference: `checkout_${suffix}`,
  };
  const op: Row = {
    ...values.scope,
    id: a.operation_id,
    kind: "CHECKOUT_CREATE",
    state: "SUCCEEDED",
    order_id: o.id,
    withdrawal_intent_id: null,
    payment_id: null,
    provider_operation_reference: a.provider_reference,
    created_at: o.created_at,
    updated_at: new Date("2026-10-12T18:51:00.000Z"),
  };
  const payload = {
    paymentId: p.provider_payment_reference as string,
    externalReference: a.id as string,
    checkoutId: a.provider_reference as string,
  };
  const e: Row = {
    ...values.scope,
    id: `event-${suffix}`,
    provider_event_reference: `evt_${suffix}`,
    event_type: "PAYMENT_RECEIVED",
    payload,
    payload_hash: hashAsaasEventIdentity(
      `evt_${suffix}`,
      "PAYMENT_RECEIVED",
      values.binding.accountReference,
      payload,
    ),
    payment_id: p.id,
    state: "PROCESSED",
    received_at: new Date("2026-10-12T18:54:00.000Z"),
    authenticated_at: new Date("2026-10-12T18:54:00.000Z"),
    processed_at: new Date("2026-10-12T18:56:00.000Z"),
  };
  const l: Row = {
    ...values.scope,
    id: `ledger-${suffix}`,
    effect_key: giftReceivedEffectKey(p.provider_payment_reference as string),
    kind: "GIFT_RECEIVED",
    direction: "CREDIT",
    currency: "BRL",
    amount_cents: 10000,
    payment_id: p.id,
    withdrawal_intent_id: null,
    operation_id: op.id,
    event_id: e.id,
    compensates_entry_id: null,
    created_at: new Date("2026-10-12T18:56:00.000Z"),
  };
  for (const [table, row] of Object.entries({
    payments: p,
    orders: o,
    quotes: q,
    attempts: a,
    operations: op,
    events: e,
  }))
    values.tables[table].push(row);
  if (status === "RECEIVED") values.tables.ledgers.push(l);
  return { p, o, q, a, op, e, l };
}
function hold(values: ReturnType<typeof fixture>, state = "REQUESTED") {
  const w: Row = {
    ...values.scope,
    id: "withdrawal-one",
    amount_cents: 5000,
    fee_cents: 100,
    net_cents: 4900,
    currency: "BRL",
    destination_version: 1,
    state,
    reservation_state: "HELD",
    reserved_cents: 5000,
    provider_reference: null,
    receipt_reference: null,
    resolution_observed_at: null,
    created_at: new Date("2026-10-12T18:57:00.000Z"),
    updated_at: new Date("2026-10-12T18:58:00.000Z"),
  };
  values.tables.withdrawals.push(w);
  return w;
}
async function denied(values: ReturnType<typeof fixture>) {
  await expect(
    values.repository.loadStoredTotals(values.binding),
  ).rejects.toMatchObject({
    status: 503,
    code: "FINANCIAL_OVERVIEW_REPOSITORY_UNAVAILABLE",
    message: "Stored financial totals are unavailable",
  });
}
describe("authoritative stored financial overview totals", () => {
  it("returns actual zeros only for an authoritative bound empty repeatable-read snapshot", async () => {
    const values = fixture();
    expect(await values.repository.loadStoredTotals(values.binding)).toEqual({
      binding: values.binding,
      currency: "BRL",
      totals: zeros,
      observedAt: instant,
      lastBalanceObservation: null,
      unresolvedFinancialEventCount: 0,
    });
    expect(values.queries[0].sql).toMatch(
      /begin isolation level repeatable read read only/i,
    );
    expect(values.queries.at(-1)?.sql).toBe("commit");
    expect(values.queries.filter((q) => /^SELECT/i.test(q.sql))).toHaveLength(
      6,
    );
    expect(
      values.queries.every(
        (q) =>
          !/(\bINSERT\b|\bUPDATE\b|\bDELETE\b|FOR SHARE|FOR UPDATE|credential|bank_reference|authorization_reference|request_snapshot|is_current|receiving_capability|lifecycle)/i.test(
            q.sql,
          ),
      ),
    ).toBe(true);
  });
  it("returns null for a missing stored account rather than manufactured zeros", async () => {
    const values = fixture();
    values.tables.accounts.length = 0;
    expect(await values.repository.loadStoredTotals(values.binding)).toBeNull();
    expect(values.queries.filter((q) => /^SELECT/i.test(q.sql))).toHaveLength(
      1,
    );
  });
  it("sums only canonical actual received allocations, independently for multiple payments", async () => {
    const values = fixture();
    received(values);
    received(values, "two");
    const result = await values.repository.loadStoredTotals(values.binding);
    expect(result?.totals).toEqual({
      ...zeros,
      nominalReceivedCents: 20000,
      netReceivedCents: 20000,
      processingCents: 78,
      commissionCents: 400,
    });
    expect(result?.unresolvedFinancialEventCount).toBe(0);
    expect(values.queries.filter((q) => /^SELECT/i.test(q.sql))).toHaveLength(
      6,
    );
  });
  it.each(
    [
      "ledger",
      "payment",
      "order",
      "attempt",
      "quote",
      "event",
      "operation",
      "account",
    ].flatMap((kind) => [".", ":"].map((separator) => [kind, separator])),
  )("accepts canonical %s IDs containing %s", async (kind, separator) => {
    const values = fixture();
    const r = received(values);
    const targets: Record<string, Row> = {
      ledger: r.l,
      payment: r.p,
      order: r.o,
      attempt: r.a,
      quote: r.q,
      event: r.e,
      operation: r.op,
      account: values.account,
    };
    const references: Record<string, string[]> = {
      ledger: [],
      payment: ["payment_id"],
      order: ["order_id"],
      attempt: ["attempt_id"],
      quote: ["quote_id"],
      event: ["event_id"],
      operation: ["operation_id"],
      account: ["account_id"],
    };
    const target = targets[kind];
    const oldId = target.id;
    const newId = `${kind}${separator}one`;
    target.id = newId;
    for (const table of Object.values(values.tables))
      for (const row of table)
        for (const key of references[kind])
          if (row[key] === oldId) row[key] = newId;
    if (kind === "account") values.binding.accountBindingId = newId;
    const payload = r.e.payload as Record<string, string>;
    if (kind === "attempt") payload.externalReference = newId;
    r.e.payload_hash = hashAsaasEventIdentity(
      r.e.provider_event_reference as string,
      r.e.event_type as string,
      values.binding.accountReference,
      payload,
    );
    expect(
      (await values.repository.loadStoredTotals(values.binding))?.totals
        .netReceivedCents,
    ).toBe(10000);
  });
  it.each(["site.one", "site:one"])(
    "keeps the actual site ID grammar strict for %s",
    async (siteId) => {
      const values = fixture();
      values.binding.siteId = siteId;
      await denied(values);
      expect(values.queries).toHaveLength(0);
    },
  );
  it("never credits a quote or hosted checkout without an actual payment/ledger", async () => {
    const values = fixture();
    received(values);
    values.tables.payments.length = 0;
    values.tables.ledgers.length = 0;
    values.tables.events.length = 0;
    expect(
      (await values.repository.loadStoredTotals(values.binding))?.totals,
    ).toEqual(zeros);
  });
  it("counts only fully known CONFIRMED actual recipient net as awaiting release", async () => {
    const values = fixture();
    const rows = received(values, "one", "CONFIRMED");
    values.tables.events.length = 0;
    expect(
      (await values.repository.loadStoredTotals(values.binding))?.totals,
    ).toEqual({ ...zeros, awaitingReleaseCents: rows.p.recipient_net_cents });
  });
  it.each([
    "recipient_net_cents",
    "processing_cents",
    "commission_cents",
    "gross_cents",
    "split_fixed_cents",
  ])("fails closed on unknown confirmed actual %s", async (field) => {
    const values = fixture();
    const rows = received(values, "one", "CONFIRMED");
    rows.p[field] = null;
    await denied(values);
  });
  it.each(["REQUESTED", "AWAITING_AUTHORIZATION", "PROCESSING", "UNKNOWN"])(
    "counts exact HELD reservation in %s",
    async (state) => {
      const values = fixture();
      hold(values, state);
      expect(
        (await values.repository.loadStoredTotals(values.binding))?.totals
          .pendingCommitmentsCents,
      ).toBe(5000);
    },
  );
  it.each([
    { reserved_cents: 4999 },
    { reservation_state: "RELEASED" },
    { net_cents: 4999 },
    { currency: "USD" },
  ])("rejects inconsistent hold fields %j", async (change) => {
    const values = fixture();
    Object.assign(hold(values), change);
    await denied(values);
  });
  it.each(["COMPLETED", "FAILED", "CANCELLED"])(
    "does not invent transfer receipt or release proof for %s",
    async (state) => {
      const values = fixture();
      const w = hold(values, state);
      Object.assign(w, {
        reservation_state: state === "COMPLETED" ? "CONSUMED" : "RELEASED",
        reserved_cents: 0,
        provider_reference: "transfer_one",
        receipt_reference: "receipt_one",
        resolution_observed_at: new Date("2026-10-12T18:59:00.000Z"),
      });
      await denied(values);
    },
  );
  it("rejects a refund compensation debit until a canonical actual refund proof writer exists", async () => {
    const values = fixture();
    const rows = received(values);
    values.tables.ledgers.push({
      ...rows.l,
      id: "refund-one",
      effect_key: "REFUND:one",
      kind: "GIFT_REFUNDED",
      direction: "DEBIT",
      amount_cents: 1000,
      compensates_entry_id: rows.l.id,
    });
    await denied(values);
  });
  it("does not turn a raw REFUNDED provider status into a known refund amount", async () => {
    const values = fixture();
    const rows = received(values);
    rows.p.provider_status = "REFUNDED";
    await denied(values);
  });
  it("retains recorded receipts but blocks provider availability on a later restrictive RETRY", async () => {
    const values = fixture();
    const rows = received(values);
    values.tables.events.push({
      ...rows.e,
      id: "restrictive-event",
      provider_event_reference: "evt_restrictive",
      payload_hash: hashAsaasEventIdentity(
        "evt_restrictive",
        "PAYMENT_RECEIVED",
        values.binding.accountReference,
        rows.e.payload as Record<string, string>,
      ),
      state: "RETRY",
      processed_at: null,
    });
    const stored = await values.repository.loadStoredTotals(values.binding);
    expect(stored?.totals.netReceivedCents).toBe(10000);
    expect(stored?.unresolvedFinancialEventCount).toBe(1);
    const providerBalance = {
      getBalance: vi.fn().mockResolvedValue({
        source: "provider",
        ...values.binding,
        currency: "BRL",
        observedAt: instant,
        balanceCents: 10000,
      }),
    };
    const overview = await loadFinancialOverview({
      mode: "sandbox",
      binding: values.binding,
      repository: values.repository,
      providerBalance,
      now: () => new Date(instant),
      freshnessMs: 1000,
    });
    expect(overview).toMatchObject({
      netReceivedCents: 10000,
      availableCents: null,
      availability: "UNKNOWN",
    });
  });
  it.each([
    "PAYMENT_CREATED",
    "CHECKOUT_CREATED",
    "TRANSFER_CREATED",
    "REFUND_PENDING",
  ])("explicitly counts authenticated unprocessed %s", async (eventType) => {
    const values = fixture();
    const rows = received(values);
    values.tables.ledgers.length = 0;
    values.tables.payments.length = 0;
    values.tables.events = [
      {
        ...rows.e,
        event_type: eventType,
        state: "DEAD_LETTER",
        processed_at: null,
        payment_id: null,
        payload_hash: hashAsaasEventIdentity(
          rows.e.provider_event_reference as string,
          eventType,
          values.binding.accountReference,
          rows.e.payload as Record<string, string>,
        ),
      },
    ];
    expect(
      (await values.repository.loadStoredTotals(values.binding))
        ?.unresolvedFinancialEventCount,
    ).toBe(1);
  });
  it("counts UNKNOWN operations even when no receipt or inbox row exists", async () => {
    const values = fixture();
    const rows = received(values);
    values.tables.payments.length = 0;
    values.tables.ledgers.length = 0;
    values.tables.events.length = 0;
    rows.op.state = "UNKNOWN";
    expect(
      (await values.repository.loadStoredTotals(values.binding))
        ?.unresolvedFinancialEventCount,
    ).toBe(1);
  });
  it("counts an unhandled chargeback status without erasing its original receipt", async () => {
    const values = fixture();
    const rows = received(values);
    rows.p.provider_status = "CHARGEBACK_REQUESTED";
    const result = await values.repository.loadStoredTotals(values.binding);
    expect(result?.totals.netReceivedCents).toBe(10000);
    expect(result?.unresolvedFinancialEventCount).toBeGreaterThan(0);
  });
  it("fails closed on a processed reversal without actual compensation proof", async () => {
    const values = fixture();
    const r = received(values);
    values.tables.events.push({
      ...r.e,
      id: "processed-refund",
      provider_event_reference: "evt_refund",
      event_type: "PAYMENT_REFUNDED",
      payload_hash: hashAsaasEventIdentity(
        "evt_refund",
        "PAYMENT_REFUNDED",
        values.binding.accountReference,
        r.e.payload as Record<string, string>,
      ),
    });
    await denied(values);
  });
  it("fails closed on unsupported refund operations even with a failed local state", async () => {
    const values = fixture();
    const r = received(values);
    values.tables.operations.push({
      ...r.op,
      id: "refund-op",
      kind: "REFUND",
      payment_id: r.p.id,
      state: "FAILED",
      provider_operation_reference: "refund_remote",
    });
    await denied(values);
  });
  it("does not treat a different received status without canonical posting as empty pending money", async () => {
    const values = fixture();
    received(values, "one", "DUNNING_RECEIVED");
    values.tables.events.length = 0;
    await denied(values);
  });
  it.each(["payments", "ledgers", "events", "operations", "withdrawals"])(
    "rejects duplicate scoped %s facts",
    async (table) => {
      const values = fixture();
      received(values);
      if (table === "withdrawals") hold(values);
      values.tables[table].push({ ...values.tables[table][0] });
      await denied(values);
    },
  );
  it.each([
    "ledger-amount",
    "effect",
    "receipt-event",
    "event-hash",
    "event-payment",
    "event-auth",
    "scope",
    "quote-account",
    "allocation",
    "creation-proof",
    "split",
  ])("rejects malformed canonical receipt %s", async (change) => {
    const values = fixture();
    const rows = received(values);
    if (change === "ledger-amount") rows.l.amount_cents = 9999;
    if (change === "effect") rows.l.effect_key = "arbitrary-credit";
    if (change === "receipt-event") rows.l.event_id = null;
    if (change === "event-hash") rows.e.payload_hash = "a".repeat(64);
    if (change === "event-payment") rows.e.payment_id = "other-payment";
    if (change === "event-auth") rows.e.authenticated_at = null;
    if (change === "scope") rows.o.account_id = "other-account";
    if (change === "quote-account")
      (rows.q.snapshot as { receiving: Row }).receiving.accountReference =
        "other_remote";
    if (change === "allocation") rows.p.processing_cents = 40;
    if (change === "creation-proof") rows.op.state = "UNKNOWN";
    if (change === "split") rows.p.split_provider_reference = null;
    await denied(values);
  });
  it("filters foreign account/environment facts while retaining noncurrent account history", async () => {
    const values = fixture();
    const rows = received(values);
    values.tables.payments.push({
      ...rows.p,
      id: "foreign-pay",
      account_id: "foreign-account",
    });
    values.tables.events.push({
      ...rows.e,
      id: "foreign-event",
      environment: "live",
      state: "RETRY",
      processed_at: null,
    });
    const result = await values.repository.loadStoredTotals(values.binding);
    expect(result?.totals.netReceivedCents).toBe(10000);
    expect(result?.unresolvedFinancialEventCount).toBe(0);
  });
  it("rejects wrong mode, account identity, demo-live and ambiguous storage", async () => {
    for (const change of ["mode", "reference", "demo", "duplicate"]) {
      const values = fixture();
      if (change === "mode") values.binding.environment = "live";
      if (change === "reference")
        values.account.account_reference = "different_remote";
      if (change === "demo") {
        values.options.environment = "live";
        values.binding.environment = "live";
        values.account.environment = "live";
        values.site.is_demo = true;
        values.repository = createFinancialOverviewRepository(
          values.db,
          values.options,
        );
      }
      if (change === "duplicate")
        values.tables.accounts.push({ ...values.account });
      await denied(values);
    }
  });
  it("normalizes native driver timestamp strings without relaxing the injected clock", async () => {
    const values = fixture();
    received(values);
    for (const rows of Object.values(values.tables))
      for (const row of rows)
        for (const [key, value] of Object.entries(row))
          if (value instanceof Date)
            row[key] = value
              .toISOString()
              .replace("T", " ")
              .replace(".000Z", "+00");
    values.clock.database = "2026-10-12 19:00:00+00";
    expect(
      (await values.repository.loadStoredTotals(values.binding))?.totals
        .netReceivedCents,
    ).toBe(10000);
    values.options.now = () => "2026-10-12T19:00:00.000Z" as unknown as Date;
    values.repository = createFinancialOverviewRepository(
      values.db,
      values.options,
    );
    await denied(values);
  });
  it("rejects timestamps one microsecond beyond read time even when C1 milliseconds match", async () => {
    const values = fixture();
    const rows = received(values);
    rows.p.observed_at = "2026-10-12 19:00:00.000001+00";
    await denied(values);
  });
  it("rejects a receipt event processed one microsecond before its ledger entry", async () => {
    const values = fixture();
    const rows = received(values);
    rows.l.created_at = "2026-10-12 18:56:00.000001+00";
    rows.e.processed_at = "2026-10-12 18:56:00+00";
    await denied(values);
  });
  it.each([
    new Date("2026-10-12T18:53:59.999Z"),
    "2026-10-12 18:53:59.999999+00",
  ])("accepts event receipt %s before authentication", async (receivedAt) => {
    const values = fixture();
    const rows = received(values);
    rows.e.received_at = receivedAt;
    expect(
      (await values.repository.loadStoredTotals(values.binding))?.totals
        .netReceivedCents,
    ).toBe(10000);
  });
  it.each([
    new Date("2026-10-12T18:54:00.001Z"),
    "2026-10-12 18:54:00.000001+00",
  ])("rejects event receipt %s after authentication", async (receivedAt) => {
    const values = fixture();
    const rows = received(values);
    rows.e.received_at = receivedAt;
    await denied(values);
  });
  it("rejects C1 summation overflow while using actual integer cents", async () => {
    const values = fixture();
    for (const suffix of ["one", "two", "three"]) {
      const rows = received(values, suffix);
      const nominal = 1073741000;
      const commission = Number((BigInt(nominal) * 200n + 5000n) / 10000n);
      const gross = nominal + commission + 39;
      Object.assign(rows.q, {
        nominal_cents: nominal,
        commission_cents: commission,
        total_cents: gross,
      });
      Object.assign(rows.p, {
        gross_cents: gross,
        commission_cents: commission,
        recipient_net_cents: nominal,
        split_fixed_cents: commission,
      });
      rows.l.amount_cents = nominal;
    }
    await denied(values);
  });
  it("keeps a single immutable read snapshot across all batched projections", async () => {
    const values = fixture();
    received(values);
    values.faults.mutateAfterBinding = true;
    expect(
      (await values.repository.loadStoredTotals(values.binding))
        ?.unresolvedFinancialEventCount,
    ).toBe(0);
    expect(values.tables.events).toHaveLength(2);
  });
  it("sanitizes query/commit failures without claiming complete totals", async () => {
    const values = fixture();
    values.faults.query = '"financial_ledger_entry"';
    await denied(values);
    expect(values.queries.at(-1)?.sql).toBe("rollback");
  });
  it("returns copied scalar totals, binding and read time", async () => {
    const values = fixture();
    received(values);
    const result = await values.repository.loadStoredTotals(values.binding);
    if (!result) throw new Error("Expected stored totals");
    result.totals.netReceivedCents = 0;
    result.observedAt.setTime(0);
    expect(
      (await values.repository.loadStoredTotals(values.binding))?.totals
        .netReceivedCents,
    ).toBe(10000);
  });
});

async function consistency(
  values: ReturnType<typeof fixture>,
  bound = new Date(instant),
) {
  const check = values.repository.checkBalanceConsistency;
  if (!check)
    throw new Error(
      "The stored repository must provide post-fetch consistency",
    );
  return check(values.binding, bound);
}
function debit(values: ReturnType<typeof fixture>, createdAt: unknown) {
  if (values.tables.payments.length === 0) received(values);
  const payment = values.tables.payments[0];
  const credit = values.tables.ledgers.find((l) => l.payment_id === payment.id);
  const row: Row = {
    ...values.scope,
    id: "actual-debit",
    effect_key: "ACTUAL_DEBIT:one",
    kind: "GIFT_REFUNDED",
    direction: "DEBIT",
    currency: "BRL",
    amount_cents: 5000,
    payment_id: payment.id,
    withdrawal_intent_id: null,
    operation_id: null,
    event_id: null,
    compensates_entry_id: credit?.id,
    created_at: createdAt,
  };
  values.tables.ledgers.push(row);
  return row;
}
describe("stored balance consistency after the provider GET", () => {
  it("provides a new authoritative empty snapshot with explicit zero counts", async () => {
    const values = fixture();
    const result = await consistency(values);
    expect(result).toEqual({
      binding: values.binding,
      balanceObservedAt: instant,
      checkedAt: instant,
      unresolvedFinancialEventCount: 0,
      balanceEffectsAfterObservationCount: 0,
    });
    expect(values.queries[0].sql).toMatch(
      /begin isolation level repeatable read read only/i,
    );
    expect(values.queries.filter((q) => /^SELECT/i.test(q.sql))).toHaveLength(
      6,
    );
  });
  it("reads after GET rather than reusing the earlier totals snapshot", async () => {
    const values = fixture();
    received(values);
    const getBalance = vi.fn(async () => {
      debit(values, new Date(instant));
      return {
        source: "provider" as const,
        ...values.binding,
        currency: "BRL" as const,
        observedAt: new Date(instant),
        balanceCents: 10000,
      };
    });
    const result = await loadFinancialOverview({
      mode: "sandbox",
      binding: values.binding,
      repository: values.repository,
      providerBalance: { getBalance },
      now: () => new Date(instant),
      freshnessMs: 1000,
    });
    expect(result).toMatchObject({
      netReceivedCents: 10000,
      availability: "UNKNOWN",
      availableCents: null,
    });
    expect(getBalance).toHaveBeenCalledOnce();
    expect(values.queries.filter((q) => /^begin/i.test(q.sql))).toHaveLength(2);
  });
  it.each([
    ["2026-10-12 18:59:59.999999+00", 0],
    ["2026-10-12 19:00:00+00", 1],
    ["2026-10-12 19:00:00.000001+00", 1],
  ])(
    "counts actual debit %s inclusively without losing microseconds",
    async (createdAt, expected) => {
      const values = fixture();
      values.clock.value = new Date("2026-10-12T19:00:01.000Z");
      values.clock.database = "2026-10-12 19:00:01+00";
      debit(values, createdAt);
      expect(
        (await consistency(values))?.balanceEffectsAfterObservationCount,
      ).toBe(expected);
    },
  );
  it("counts completed withdrawals by their stored update boundary, without inventing totals", async () => {
    const values = fixture();
    const w = hold(values, "COMPLETED");
    Object.assign(w, {
      reservation_state: "CONSUMED",
      reserved_cents: 0,
      provider_reference: "transfer_one",
      receipt_reference: "receipt_one",
      resolution_observed_at: new Date("2026-10-12T18:59:00.000Z"),
      updated_at: new Date(instant),
    });
    expect(
      (await consistency(values))?.balanceEffectsAfterObservationCount,
    ).toBe(1);
    await denied(values);
  });
  it("includes a newly authenticated pending financial event", async () => {
    const values = fixture();
    const r = received(values);
    values.tables.events.push({
      ...r.e,
      id: "later-event",
      provider_event_reference: "evt_later",
      state: "RETRY",
      processed_at: null,
      payload_hash: hashAsaasEventIdentity(
        "evt_later",
        "PAYMENT_RECEIVED",
        values.binding.accountReference,
        r.e.payload as Record<string, string>,
      ),
    });
    expect((await consistency(values))?.unresolvedFinancialEventCount).toBe(1);
  });
  it("blocks unhandled restrictive payment observations and UNKNOWN operations", async () => {
    const values = fixture();
    const r = received(values);
    r.p.provider_status = "CHARGEBACK_REQUESTED";
    values.tables.operations.push({
      ...r.op,
      id: "unknown-account-op",
      kind: "ACCOUNT_CREATE",
      order_id: null,
      provider_operation_reference: null,
      state: "UNKNOWN",
    });
    expect((await consistency(values))?.unresolvedFinancialEventCount).toBe(2);
  });
  it("counts a processed reversal whose actual compensation is still unsupported", async () => {
    const values = fixture();
    const r = received(values);
    values.tables.events.push({
      ...r.e,
      id: "processed-refund",
      provider_event_reference: "evt_refund",
      event_type: "PAYMENT_REFUNDED",
      payload_hash: hashAsaasEventIdentity(
        "evt_refund",
        "PAYMENT_REFUNDED",
        values.binding.accountReference,
        r.e.payload as Record<string, string>,
      ),
    });
    expect((await consistency(values))?.unresolvedFinancialEventCount).toBe(1);
  });
  it("does not turn an unsupported payment status into zero unresolved facts", async () => {
    const values = fixture();
    received(values, "one", "DUNNING_RECEIVED");
    values.tables.events.length = 0;
    expect((await consistency(values))?.unresolvedFinancialEventCount).toBe(1);
  });
  it("ignores actual debit facts from another account or environment", async () => {
    const values = fixture();
    const l = debit(values, new Date(instant));
    l.account_id = "foreign-account";
    values.tables.ledgers.push({
      ...l,
      id: "foreign-live",
      account_id: values.binding.accountBindingId,
      environment: "live",
    });
    expect(
      (await consistency(values))?.balanceEffectsAfterObservationCount,
    ).toBe(0);
  });
  it("returns null for a missing binding and rejects stored tuple mismatches", async () => {
    const values = fixture();
    values.tables.accounts.length = 0;
    expect(await consistency(values)).toBeNull();
    values.tables.accounts.push({
      ...values.account,
      account_reference: "wrong_remote",
    });
    await expect(consistency(values)).rejects.toMatchObject({ status: 503 });
  });
  it.each([
    "2026-10-12T19:00:00.000Z",
    new Date(Number.NaN),
    new Date("2026-10-12T19:00:00.001Z"),
  ])(
    "rejects invalid or future provider observation bounds %s",
    async (bound) => {
      const values = fixture();
      await expect(consistency(values, bound as Date)).rejects.toMatchObject({
        code: "FINANCIAL_OVERVIEW_REPOSITORY_UNAVAILABLE",
      });
    },
  );
  it("rejects a database check one microsecond beyond the fresh server clock", async () => {
    const values = fixture();
    values.clock.database = "2026-10-12 19:00:00.000001+00";
    await expect(consistency(values)).rejects.toMatchObject({ status: 503 });
  });
  it.each(["query", "commit"])(
    "sanitizes %s failures rather than returning zero proof",
    async (kind) => {
      const values = fixture();
      if (kind === "query")
        values.faults.query = 'FROM "financial_ledger_entry"';
      else values.faults.commit = true;
      await expect(consistency(values)).rejects.toMatchObject({
        status: 503,
        message: "Stored financial totals are unavailable",
      });
      expect(values.queries.at(-1)?.sql).toBe("rollback");
    },
  );
  it("copies binding and observation inputs before awaiting the transaction", async () => {
    const values = fixture();
    const bound = new Date(instant);
    const pending = consistency(values, bound);
    bound.setTime(0);
    values.binding.accountReference = "changed_remote";
    expect(await pending).toMatchObject({
      binding: { accountReference: "remote_one" },
      balanceObservedAt: instant,
    });
  });
  it("keeps options pinned after the factory and does not alter supplied dates", async () => {
    const values = fixture();
    values.options.environment = "live";
    values.options.now = () => new Date(0);
    const bound = new Date(instant);
    expect(await consistency(values, bound)).toMatchObject({
      checkedAt: instant,
      balanceObservedAt: instant,
    });
    expect(bound).toEqual(instant);
  });
});
