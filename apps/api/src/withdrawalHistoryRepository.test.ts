import { withdrawalIntentSchema } from "@entrelacos/contracts";
import { drizzle, type NodePgClient } from "drizzle-orm/node-postgres";
import { describe, expect, it, vi } from "vitest";
import { createWithdrawalHistoryRepository } from "./withdrawalHistoryRepository";

type Row = Record<string, unknown>;
function fixture(
  mode: "disabled" | "sandbox" | "live" = "sandbox",
  rawTimestamps = false,
) {
  const site: Row = {
    id: "site:one",
    is_demo: false,
    lifecycle: "ARCHIVED",
    publication_state: "UNPUBLISHED",
  };
  const oldAccount: Row = {
    id: "account.old",
    site_id: site.id,
    environment: "sandbox",
    provider: "ASAAS",
    is_current: false,
    provider_account_state: "BLOCKED",
    receiving_capability: false,
    credential_ciphertext: "private-key",
    account_reference: "private-provider-account",
  };
  const currentAccount: Row = {
    ...oldAccount,
    id: "account.current",
    is_current: true,
  };
  const oldWithdrawal: Row = {
    id: "withdrawal.a",
    site_id: site.id,
    account_id: oldAccount.id,
    environment: "sandbox",
    amount_cents: 10_000,
    fee_cents: 100,
    net_cents: 9900,
    currency: "BRL",
    destination_version: 1,
    state: "COMPLETED",
    created_at: new Date("2026-10-10T12:00:00.000Z"),
    updated_at: new Date("2026-10-11T12:00:00.000Z"),
    provider_reference: "private-transfer",
    authorization_reference: "private-authorization",
    receipt_reference: "private-receipt",
    request_hash: "private-request-hash",
  };
  const recentWithdrawal: Row = {
    ...oldWithdrawal,
    id: "withdrawal.z",
    account_id: currentAccount.id,
    destination_version: 2,
    state: "UNKNOWN",
    created_at: new Date("2026-10-12T12:00:00.000Z"),
    updated_at: new Date("2026-10-12T12:01:00.000Z"),
  };
  const tables = {
    sites: [site],
    accounts: [oldAccount, currentAccount],
    withdrawals: [oldWithdrawal, recentWithdrawal],
  };
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const faults = { failure: false, reverse: false, override: {} as Row };
  const query = vi.fn(
    async (statement: string | { text: string }, params: unknown[] = []) => {
      const sql = typeof statement === "string" ? statement : statement.text;
      queries.push({ sql, params });
      if (faults.failure) throw new Error("private-bank-reference SQL detail");
      if (!/^SELECT/i.test(sql)) throw new Error("History must only select");
      const requestedSite = sql.match(/st\.id\s*=\s*\$(\d+)/);
      const environment = sql.match(/w\.environment\s*=\s*\$(\d+)/);
      if (!requestedSite || !environment)
        throw new Error("Missing stored scope predicate");
      const siteId = params[Number(requestedSite[1]) - 1];
      const env = params[Number(environment[1]) - 1];
      const sources: Array<{ st: Row; w: Row | null; a: Row | null }> = [];
      for (const st of tables.sites.filter(
        (row) => row.id === siteId && (env !== "live" || row.is_demo === false),
      )) {
        const withdrawals = tables.withdrawals.filter(
          (w) => w.site_id === st.id && w.environment === env,
        );
        for (const w of withdrawals.length ? withdrawals : [null]) {
          const accounts = w
            ? tables.accounts.filter(
                (a) =>
                  a.id === w.account_id &&
                  a.site_id === w.site_id &&
                  a.environment === w.environment &&
                  a.provider === "ASAAS",
              )
            : [];
          for (const a of accounts.length ? accounts : [null])
            sources.push({ st, w, a });
        }
      }
      sources.sort((left, right) => {
        if (
          !/date_trunc\('milliseconds',\s*w\.created_at\)/i.test(sql) &&
          typeof left.w?.created_at_micro === "number" &&
          typeof right.w?.created_at_micro === "number"
        ) {
          const delta = right.w.created_at_micro - left.w.created_at_micro;
          if (delta) return delta;
        }
        const delta =
          (right.w?.created_at instanceof Date
            ? right.w.created_at.getTime()
            : 0) -
          (left.w?.created_at instanceof Date
            ? left.w.created_at.getTime()
            : 0);
        if (delta && Number.isFinite(delta)) return delta;
        return String(left.w?.id) < String(right.w?.id)
          ? -1
          : String(left.w?.id) > String(right.w?.id)
            ? 1
            : 0;
      });
      if (faults.reverse) sources.reverse();
      const limit = sql.match(/LIMIT\s+(\d+)/i);
      if (!limit) throw new Error("Unbounded history query");
      const projection = sql
        .split(/FROM/i)[0]
        .replace(/^SELECT\s+/i, "")
        .split(",")
        .map((part) => part.trim());
      return {
        rows: sources.slice(0, Number(limit[1])).map((source) => ({
          ...Object.fromEntries(
            projection.map((part) => {
              const field = part.match(/^(st|w)\.([a-z_]+) AS "([^"]+)"$/i);
              if (field)
                return [
                  field[3],
                  source[field[1] as "st" | "w"]?.[field[2]] ?? null,
                ];
              if (part === 'a.id IS NOT NULL AS "accountMatches"')
                return ["accountMatches", source.a !== null];
              throw new Error(`Unsupported history projection: ${part}`);
            }),
          ),
          ...faults.override,
        })),
      };
    },
  );
  const db = drizzle({
    query: async (...args: Parameters<typeof query>) => {
      const result = await query(...args);
      if (!rawTimestamps) return result;
      return {
        ...result,
        rows: result.rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              value instanceof Date
                ? value.toISOString().replace("T", " ").replace("Z", "+00")
                : value,
            ]),
          ),
        ),
      };
    },
  } as unknown as NodePgClient);
  const options = { mode };
  const expected = (w: Row) => ({
    id: w.id,
    siteId: site.id,
    amountCents: w.amount_cents,
    feeCents: w.fee_cents,
    netCents: w.net_cents,
    currency: w.currency,
    destinationVersion: w.destination_version,
    state: w.state,
    createdAt: (w.created_at as Date).toISOString(),
    updatedAt: (w.updated_at as Date).toISOString(),
    mode: w.environment,
  });
  return {
    repository: createWithdrawalHistoryRepository(db, options),
    db,
    options,
    site,
    oldAccount,
    currentAccount,
    oldWithdrawal,
    recentWithdrawal,
    tables,
    queries,
    faults,
    expected,
  };
}
describe("stored withdrawal history", () => {
  it("projects raw Drizzle timestamp strings without changing public history ordering", async () => {
    const v = fixture("sandbox", true);
    expect(await v.repository.listWithdrawals(v.site.id as string)).toEqual([
      v.expected(v.recentWithdrawal),
      v.expected(v.oldWithdrawal),
    ]);
  });

  it("rejects an update before creation even when both timestamps share one millisecond", async () => {
    const v = fixture();
    v.faults.override.createdAt = "2026-10-12 12:00:00.000002+00";
    v.faults.override.updatedAt = "2026-10-12 12:00:00.000001+00";
    await expect(
      v.repository.listWithdrawals(v.site.id as string),
    ).rejects.toMatchObject({ code: "WITHDRAWAL_HISTORY_UNAVAILABLE" });
  });
  it("orders consistently when PostgreSQL microseconds collapse to the same driver millisecond", async () => {
    const v = fixture();
    v.recentWithdrawal.created_at = new Date("2026-10-12T12:00:00.000900Z");
    v.oldWithdrawal.created_at = new Date("2026-10-12T12:00:00.000100Z");
    v.recentWithdrawal.created_at_micro =
      (v.recentWithdrawal.created_at as Date).getTime() * 1000 + 900;
    v.oldWithdrawal.created_at_micro =
      (v.oldWithdrawal.created_at as Date).getTime() * 1000 + 100;
    v.oldWithdrawal.updated_at = new Date("2026-10-12T12:01:00.000Z");
    const history = await v.repository.listWithdrawals(v.site.id as string);
    expect(history.map((entry) => entry.id)).toEqual([
      "withdrawal.a",
      "withdrawal.z",
    ]);
    expect(history[0].createdAt).toBe(history[1].createdAt);
    expect(v.queries[0].sql).toMatch(
      /ORDER BY date_trunc\('milliseconds',\s*w\.created_at\) DESC/,
    );
  });
  it("reads old and current accounts for an archived site in stable order with only C1 fields", async () => {
    const values = fixture();
    const result = await values.repository.listWithdrawals("site:one");
    expect(result).toEqual([
      values.expected(values.recentWithdrawal),
      values.expected(values.oldWithdrawal),
    ]);
    for (const row of result)
      expect(withdrawalIntentSchema.safeParse(row).success).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(
      /private|account|provider|authorization|receipt|request|accountMatches/,
    );
    expect(values.queries).toHaveLength(1);
    expect(values.queries[0].sql).toMatch(/LIMIT 1001/);
    expect(values.queries[0].sql).toMatch(
      /ORDER BY date_trunc\('milliseconds', w\.created_at\) DESC, w\.id COLLATE "C" ASC/,
    );
    expect(values.queries[0].sql).not.toMatch(
      /FOR UPDATE|BEGIN|credential|account_reference|provider_reference|authorization_reference|request_hash|receipt_reference|is_current|receiving_capability|lifecycle/,
    );
    expect(values.queries[0].sql).toContain("a.provider='ASAAS'");
  });
  it("returns an empty list only for an existing site's authoritative empty history", async () => {
    const values = fixture();
    values.tables.withdrawals.length = 0;
    expect(await values.repository.listWithdrawals("site:one")).toEqual([]);
    expect(values.queries).toHaveLength(1);
  });
  it("rejects a missing or different site instead of inventing an empty history", async () => {
    const values = fixture();
    await expect(
      values.repository.listWithdrawals("site:missing"),
    ).rejects.toMatchObject({
      status: 503,
      code: "WITHDRAWAL_HISTORY_UNAVAILABLE",
    });
  });
  it("pins sandbox independently of caller changes and excludes stored live rows", async () => {
    const values = fixture();
    values.options.mode = "live";
    values.tables.accounts.push({
      ...values.currentAccount,
      id: "account.live",
      environment: "live",
    });
    values.tables.withdrawals.push({
      ...values.recentWithdrawal,
      id: "withdrawal.live",
      account_id: "account.live",
      environment: "live",
    });
    const result = await values.repository.listWithdrawals("site:one");
    expect(result).toHaveLength(2);
    expect(result.every((row) => row.mode === "sandbox")).toBe(true);
    expect(values.queries[0].params).not.toContain("live");
  });
  it("reads real live history and denies a demo site in live mode", async () => {
    const values = fixture("live");
    for (const row of [...values.tables.accounts, ...values.tables.withdrawals])
      row.environment = "live";
    expect(
      (await values.repository.listWithdrawals("site:one")).every(
        (row) => row.mode === "live",
      ),
    ).toBe(true);
    values.site.is_demo = true;
    await expect(
      values.repository.listWithdrawals("site:one"),
    ).rejects.toMatchObject({
      status: 503,
      code: "WITHDRAWAL_HISTORY_UNAVAILABLE",
    });
  });
  it("rejects disabled provider mode with a sanitized 409 before any SQL", async () => {
    const values = fixture("disabled");
    await expect(
      values.repository.listWithdrawals("site:one"),
    ).rejects.toMatchObject({
      status: 409,
      code: "PROVIDER_MODE_UNAVAILABLE",
      message: "Financial provider is unavailable",
    });
    expect(values.queries).toHaveLength(0);
  });
  it.each(["site", "environment", "missing", "provider"])(
    "fails closed on mismatched stored account %s instead of dropping withdrawals",
    async (change) => {
      const values = fixture();
      if (change === "site") values.oldAccount.site_id = "foreign-site";
      if (change === "environment") values.oldAccount.environment = "live";
      if (change === "missing") values.tables.accounts.splice(0, 1);
      if (change === "provider") values.oldAccount.provider = "OTHER_PROVIDER";
      await expect(
        values.repository.listWithdrawals("site:one"),
      ).rejects.toMatchObject({
        status: 503,
        code: "WITHDRAWAL_HISTORY_UNAVAILABLE",
      });
    },
  );
  it.each([
    { id: "bad id" },
    { amount_cents: 0 },
    { amount_cents: 2147483648 },
    { fee_cents: -1 },
    { net_cents: 0 },
    { net_cents: 9901 },
    { currency: "USD" },
    { destination_version: 0 },
    { state: "PAID" },
    { created_at: new Date(Number.NaN) },
    { updated_at: new Date("2026-10-09T12:00:00.000Z") },
    { updated_at: null },
    { created_at: "2026-10-10T12:00:00.000" },
  ])("rejects corrupted stored C1 fields %j", async (change) => {
    const values = fixture();
    Object.assign(values.oldWithdrawal, change);
    await expect(
      values.repository.listWithdrawals("site:one"),
    ).rejects.toMatchObject({
      status: 503,
      code: "WITHDRAWAL_HISTORY_UNAVAILABLE",
    });
  });
  it.each([
    { siteId: "foreign-site" },
    { mode: "live" },
    { accountMatches: "true" },
  ])("rejects contradictory driver projection %j", async (override) => {
    const values = fixture();
    values.faults.override = override;
    await expect(
      values.repository.listWithdrawals("site:one"),
    ).rejects.toMatchObject({ code: "WITHDRAWAL_HISTORY_UNAVAILABLE" });
  });
  it.each(["withdrawal", "account", "site"])(
    "rejects duplicate %s identities",
    async (kind) => {
      const values = fixture();
      if (kind === "withdrawal")
        values.tables.withdrawals.push({ ...values.oldWithdrawal });
      if (kind === "account")
        values.tables.accounts.push({ ...values.oldAccount });
      if (kind === "site") values.tables.sites.push({ ...values.site });
      await expect(
        values.repository.listWithdrawals("site:one"),
      ).rejects.toMatchObject({ code: "WITHDRAWAL_HISTORY_UNAVAILABLE" });
    },
  );
  it("orders equal timestamps by byte-stable local ID and rejects out-of-order storage results", async () => {
    const values = fixture();
    values.recentWithdrawal.created_at = values.oldWithdrawal.created_at;
    expect(
      (await values.repository.listWithdrawals("site:one")).map(
        (row) => row.id,
      ),
    ).toEqual(["withdrawal.a", "withdrawal.z"]);
    values.faults.reverse = true;
    await expect(
      values.repository.listWithdrawals("site:one"),
    ).rejects.toMatchObject({ code: "WITHDRAWAL_HISTORY_UNAVAILABLE" });
  });
  it("allows exactly 1000 records and rejects a bounded 1001-row result instead of truncating", async () => {
    const values = fixture();
    values.tables.withdrawals = Array.from({ length: 1000 }, (_, i) => ({
      ...values.oldWithdrawal,
      id: `withdrawal.${String(i).padStart(4, "0")}`,
    }));
    expect(await values.repository.listWithdrawals("site:one")).toHaveLength(
      1000,
    );
    values.tables.withdrawals.push({
      ...values.oldWithdrawal,
      id: "withdrawal.1000",
    });
    await expect(
      values.repository.listWithdrawals("site:one"),
    ).rejects.toMatchObject({ code: "WITHDRAWAL_HISTORY_UNAVAILABLE" });
    expect(
      values.queries.every((entry) => entry.sql.includes("LIMIT 1001")),
    ).toBe(true);
  });
  it("rejects an inconsistent empty sentinel instead of hiding corrupted records", async () => {
    const values = fixture();
    values.tables.withdrawals.length = 0;
    values.faults.override = { amountCents: 100 };
    await expect(
      values.repository.listWithdrawals("site:one"),
    ).rejects.toMatchObject({ code: "WITHDRAWAL_HISTORY_UNAVAILABLE" });
  });
  it("sanitizes SQL failures without secret details or a successful empty response", async () => {
    const values = fixture();
    values.faults.failure = true;
    await expect(
      values.repository.listWithdrawals("site:one"),
    ).rejects.toMatchObject({
      status: 503,
      code: "WITHDRAWAL_HISTORY_UNAVAILABLE",
      message: "Withdrawal history unavailable",
    });
  });
  it("returns copies whose mutation cannot alter stored history", async () => {
    const values = fixture();
    const result = await values.repository.listWithdrawals("site:one");
    result[0].amountCents = 1;
    result.reverse();
    expect(await values.repository.listWithdrawals("site:one")).toEqual([
      values.expected(values.recentWithdrawal),
      values.expected(values.oldWithdrawal),
    ]);
  });
  it.each(["invalid site", "", null])(
    "rejects invalid caller site %s before SQL",
    async (siteId) => {
      const values = fixture();
      await expect(
        values.repository.listWithdrawals(siteId as string),
      ).rejects.toMatchObject({ code: "WITHDRAWAL_HISTORY_UNAVAILABLE" });
      expect(values.queries).toHaveLength(0);
    },
  );
});
