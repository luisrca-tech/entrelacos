import { drizzle, type NodePgClient } from "drizzle-orm/node-postgres";
import { describe, expect, it, vi } from "vitest";
import {
  createGiftPaymentInboxRepository,
  type GiftPaymentInboxClaim,
} from "./giftPaymentInboxRepository";

const instant = "2026-10-12T12:00:00.000Z";
function fixture(rawTimestamps = false) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const row = {
    eventId: "event-one",
    siteId: "site-one",
    accountId: "account-one",
    environment: "sandbox",
    bindingSiteId: "site-one",
    bindingAccountId: "account-one",
    bindingEnvironment: "sandbox",
    bindingProvider: "ASAAS",
    providerAccountReference: "remote-account-one",
    authenticatedAt: new Date(instant),
    receivedAt: new Date(instant),
    attempts: 0,
    payload: { paymentId: "pay_one" },
    state: "RECEIVED",
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
  };
  let present = true;
  let mutationCount = 1;
  let failure = "";
  const projection: Record<string, unknown> = {};
  Object.assign(row, { nextAttemptAt: new Date(instant) });
  const query = vi.fn(
    async (statement: string | { text: string }, params: unknown[] = []) => {
      const sql = typeof statement === "string" ? statement : statement.text;
      queries.push({ sql, params });
      if (failure && sql.includes(failure))
        throw new Error("private-database-secret");
      if (/^(begin|commit|rollback)/i.test(sql)) return { rows: [] };
      if (/^select/i.test(sql)) return { rows: present ? [row] : [] };
      if (/^update/i.test(sql))
        return {
          rows: Array.from({ length: mutationCount }, () => ({
            id: row.eventId,
          })),
        };
      throw new Error("Unexpected query-only statement");
    },
  );
  const options = {
    environment: "sandbox" as const,
    instanceId: "worker-one",
    leaseMs: 30_000,
    maxAttempts: 3,
    retryDelayMs: 10_000,
    now: () => new Date(instant),
    generateLeaseToken: () => "fence-one",
  };
  return {
    repository: createGiftPaymentInboxRepository(
      drizzle({
        query: async (...args: Parameters<typeof query>) => {
          const result = await query(...args);
          return {
            ...result,
            rows: result.rows.map((value) => ({
              ...Object.fromEntries(
                Object.entries(value).map(([key, field]) => [
                  key,
                  rawTimestamps && field instanceof Date
                    ? field.toISOString().replace("T", " ").replace("Z", "+00")
                    : field,
                ]),
              ),
              ...projection,
            })),
          };
        },
      } as unknown as NodePgClient),
      options,
    ),
    queries,
    row,
    empty: () => {
      present = false;
    },
    lostFence: () => {
      mutationCount = 0;
    },
    fail: (statement: string) => {
      failure = statement;
    },
    options,
    projection,
  };
}
describe("durable received-payment inbox claims", () => {
  it.each([
    ["production", "demo-wedding", "demo-wedding"],
    ["production", "another-site", "another-site"],
    ["production", undefined, null],
    ["development", "demo-wedding", null],
    ["test", "demo-wedding", null],
    [undefined, "demo-wedding", null],
    ["production", "demo-wedding,another-site", null],
    ["production", " demo-wedding", null],
    ["production", "demo-wedding/other", null],
  ] as const)(
    "binds only the configured production showcase in native claim SQL (%s, %s)",
    async (applicationEnvironment, liveDemoSiteId, expectedSiteId) => {
      const queries: Array<{ sql: string; params: unknown[] }> = [];
      const db = drizzle({
        query: async (
          statement: string | { text: string },
          params: unknown[] = [],
        ) => {
          queries.push({
            sql: typeof statement === "string" ? statement : statement.text,
            params,
          });
          return { rows: [] };
        },
      } as unknown as NodePgClient);
      const repository = createGiftPaymentInboxRepository(db, {
        ...fixture().options,
        environment: "live",
        applicationEnvironment,
        liveDemoSiteId,
      });
      expect(await repository.claimNextReceivedPayment()).toBeNull();
      const selection = queries.find(({ sql }) => sql.startsWith("SELECT"));
      if (!selection) throw new Error("Expected the native claim selection");
      const parameter = /OR st\.id=\$(\d+)/.exec(selection.sql);
      expect(parameter).not.toBeNull();
      expect(selection.params[Number(parameter?.[1]) - 1]).toBe(expectedSiteId);
      expect(selection.sql).toContain("st.is_demo=false OR st.id=");
      expect(selection.sql).toContain("FOR UPDATE OF e SKIP LOCKED");
      expect(queries.some(({ sql }) => /^UPDATE/i.test(sql))).toBe(false);
    },
  );
  it("also selects confirmed events for an observation without granting settlement authority", async () => {
    const values = fixture();
    await values.repository.claimNextReceivedPayment();
    expect(
      values.queries.find((entry) => entry.sql.startsWith("SELECT"))?.sql,
    ).toContain("PAYMENT_CONFIRMED");
  });
  it("claims authenticated due events represented by raw Drizzle timestamp strings", async () => {
    const v = fixture(true);
    expect(await v.repository.claimNextReceivedPayment()).toMatchObject({
      kind: "CLAIMED",
      claim: { eventId: "event-one", leaseToken: "fence-one" },
    });
  });

  it("does not claim an observation one microsecond ahead of its backend clock", async () => {
    const v = fixture(true);
    v.projection.authenticatedAt = "2026-10-12 12:00:00.000001+00";
    await expect(v.repository.claimNextReceivedPayment()).rejects.toMatchObject(
      { code: "FINANCIAL_INBOX_UNAVAILABLE" },
    );
    expect(v.queries.some((query) => /^UPDATE/i.test(query.sql))).toBe(false);
  });

  it("does not claim a received timestamp after authentication within one past millisecond", async () => {
    const v = fixture(true);
    v.projection.authenticatedAt = "2026-10-12 11:59:59.000001+00";
    v.projection.receivedAt = "2026-10-12 11:59:59.000002+00";
    await expect(v.repository.claimNextReceivedPayment()).rejects.toMatchObject(
      { code: "FINANCIAL_INBOX_UNAVAILABLE" },
    );
    expect(v.queries.some((query) => /^UPDATE/i.test(query.sql))).toBe(false);
  });
  it("atomically claims only due authenticated scoped receipt events with a new fence", async () => {
    const values = fixture();
    expect(await values.repository.claimNextReceivedPayment()).toEqual({
      kind: "CLAIMED",
      claim: {
        eventId: "event-one",
        siteId: "site-one",
        accountId: "account-one",
        environment: "sandbox",
        leaseOwner: "worker-one",
        leaseToken: "fence-one",
        paymentReference: "pay_one",
        providerAccountReference: "remote-account-one",
        attempts: 1,
      },
    });
    const selection = values.queries.find((entry) =>
      entry.sql.startsWith("SELECT"),
    );
    expect(selection?.sql).toMatch(/FOR UPDATE OF e SKIP LOCKED/);
    expect(selection?.sql).toContain("PAYMENT_RECEIVED");
    expect(selection?.sql).toContain("authenticated_at IS NOT NULL");
    expect(selection?.sql).not.toMatch(
      /credential|bank_state|is_current|receiving_capability/,
    );
    expect(selection?.params).toContain("sandbox");
    const update = values.queries.find((entry) =>
      entry.sql.startsWith("UPDATE"),
    );
    expect(update?.params).toContain("worker-one");
    expect(update?.params).toContain("fence-one");
    expect(update?.sql).toContain("clock_timestamp()");
    expect(update?.sql).toContain("attempts = e.attempts + 1");
    expect(values.queries.at(-1)?.sql).toBe("commit");
  });
  it("returns idle without mutation when no due supported event exists", async () => {
    const values = fixture();
    values.empty();
    expect(await values.repository.claimNextReceivedPayment()).toBeNull();
    expect(values.queries.some((entry) => /^UPDATE/.test(entry.sql))).toBe(
      false,
    );
  });
  it("dead-letters an exhausted expired event without granting a new lease", async () => {
    const values = fixture();
    Object.assign(values.row, {
      attempts: 3,
      state: "CLAIMED",
      leaseOwner: "old-worker",
      leaseToken: "old-fence",
      leaseExpiresAt: new Date("2026-10-12T11:59:00.000Z"),
    });
    expect(await values.repository.claimNextReceivedPayment()).toEqual({
      kind: "DEAD_LETTER",
      eventId: "event-one",
      errorCode: "FINANCIAL_ATTEMPT_LIMIT",
    });
    const update = values.queries.find((entry) =>
      entry.sql.startsWith("UPDATE"),
    );
    expect(update?.sql).toContain("DEAD_LETTER");
    expect(update?.params).not.toContain("fence-one");
  });
  it("dead-letters a missing payment correlation without inventing a fetch reference", async () => {
    const values = fixture();
    Object.assign(values.row, { payload: {} });
    expect(await values.repository.claimNextReceivedPayment()).toEqual({
      kind: "DEAD_LETTER",
      eventId: "event-one",
      errorCode: "PAYMENT_CORRELATION_INVALID",
    });
  });

  it("rejects a reused lease token before an expired claim can regain authority", async () => {
    const values = fixture();
    Object.assign(values.row, {
      state: "CLAIMED",
      leaseOwner: "worker-one",
      leaseToken: "fence-one",
      leaseExpiresAt: new Date("2026-10-12T11:59:00.000Z"),
    });
    await expect(
      values.repository.claimNextReceivedPayment(),
    ).rejects.toMatchObject({ code: "FINANCIAL_INBOX_UNAVAILABLE" });
    expect(values.queries.some((entry) => entry.sql.startsWith("UPDATE"))).toBe(
      false,
    );
  });
  it("never hands a worker a claim if the atomic update or commit is unconfirmed", async () => {
    for (const failure of ["fence", "commit"]) {
      const values = fixture();
      if (failure === "fence") values.lostFence();
      else values.fail("commit");
      await expect(
        values.repository.claimNextReceivedPayment(),
      ).rejects.toMatchObject({
        code: "FINANCIAL_INBOX_UNAVAILABLE",
        message: "Financial inbox unavailable",
      });
    }
  });
  it.each([
    { siteId: "foreign-site" },
    { environment: "live" },
    { attempts: -1 },
    { authenticatedAt: new Date("2026-10-12T12:00:01.000Z") },
    { state: "PROCESSED" },
  ])("rejects contradictory stored claim data %j", async (change) => {
    const values = fixture();
    Object.assign(values.row, change);
    await expect(
      values.repository.claimNextReceivedPayment(),
    ).rejects.toMatchObject({ code: "FINANCIAL_INBOX_UNAVAILABLE" });
    expect(values.queries.some((entry) => /^UPDATE/.test(entry.sql))).toBe(
      false,
    );
  });
});

function deferFixture(rawTimestamps = false) {
  const claim: GiftPaymentInboxClaim = {
    eventId: "event-one",
    siteId: "site-one",
    accountId: "account-one",
    environment: "sandbox",
    leaseOwner: "worker-one",
    leaseToken: "original-fence",
    attempts: 1,
    paymentReference: "pay_one",
    providerAccountReference: "remote-account-one",
  };
  const row = {
    ...claim,
    bindingSiteId: claim.siteId,
    bindingAccountId: claim.accountId,
    bindingEnvironment: claim.environment,
    bindingProvider: "ASAAS",
    eventType: "PAYMENT_RECEIVED",
    payload: { paymentId: claim.paymentReference },
    authenticatedAt: new Date(instant),
    receivedAt: new Date(instant),
    leaseExpiresAt: new Date("2026-10-12T12:00:30.000Z"),
    nextAttemptAt: new Date(instant),
    processedAt: null as Date | null,
    state: "CLAIMED",
    lastErrorCode: null as string | null,
  };
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const clock = { value: new Date(instant), database: new Date(instant) };
  const faults = {
    commitAfterApplied: false,
    casMiss: false,
    selectClockAdvance: false,
    updateError: false,
  };
  let before: typeof row | null = null;
  const query = vi.fn(
    async (statement: string | { text: string }, params: unknown[] = []) => {
      const sql = typeof statement === "string" ? statement : statement.text;
      queries.push({ sql, params });
      if (/^begin/i.test(sql)) {
        before = structuredClone(row);
        return { rows: [] };
      }
      if (/^commit/i.test(sql)) {
        before = null;
        if (faults.commitAfterApplied) throw new Error("private-commit-detail");
        return { rows: [] };
      }
      if (/^rollback/i.test(sql)) {
        if (before) Object.assign(row, before);
        before = null;
        return { rows: [] };
      }
      if (/^SELECT/i.test(sql)) {
        if (faults.selectClockAdvance)
          clock.value = new Date("2026-10-12T12:00:31.000Z");
        const columns = Array.from(
          sql
            .split(/FROM/i)[0]
            .matchAll(/(?:e|a)\.([a-z_]+)(?: AS "([^"]+)")?/g),
          (match) =>
            match[2] ??
            match[1].replace(/_([a-z])/g, (_, letter: string) =>
              letter.toUpperCase(),
            ),
        );
        return {
          rows: [
            Object.fromEntries(
              columns.map((column) => [
                column,
                row[column as keyof typeof row],
              ]),
            ),
          ],
        };
      }
      if (/^UPDATE/i.test(sql)) {
        if (faults.updateError) throw new Error("private-database-secret");
        const original = (column: string) => {
          const match = sql.match(
            new RegExp(`e\\.${column}\\s*=\\s*\\$(\\d+)`),
          );
          return match ? params[Number(match[1]) - 1] : undefined;
        };
        if (
          faults.casMiss ||
          row.state !== "CLAIMED" ||
          row.leaseExpiresAt < clock.database ||
          row.eventId !== original("id") ||
          row.siteId !== original("site_id") ||
          row.accountId !== original("account_id") ||
          row.environment !== original("environment") ||
          row.leaseOwner !== original("lease_owner") ||
          row.leaseToken !== original("lease_token") ||
          row.attempts !== original("attempts")
        )
          return { rows: [] };
        const assignments = sql.split(/WHERE/i)[0];
        for (const column of ["state", "last_error_code", "next_attempt_at"]) {
          const match = assignments.match(
            new RegExp(`${column}\\s*=\\s*\\$(\\d+)`),
          );
          if (!match) throw new Error("Missing persisted deferral projection");
          const key = column.replace(/_([a-z])/g, (_, letter: string) =>
            letter.toUpperCase(),
          ) as "state" | "lastErrorCode" | "nextAttemptAt";
          Object.assign(row, {
            [key]:
              key === "nextAttemptAt"
                ? new Date(params[Number(match[1]) - 1] as string)
                : params[Number(match[1]) - 1],
          });
        }
        return { rows: [{ id: row.eventId }] };
      }
      throw new Error("Unexpected query-only statement");
    },
  );
  const options = {
    environment: "sandbox" as const,
    instanceId: "worker-one",
    leaseMs: 30_000,
    maxAttempts: 3,
    retryDelayMs: 10_000,
    now: () => new Date(clock.value),
    generateLeaseToken: () => "new-fence",
  };
  const db = drizzle({
    query: async (...args: Parameters<typeof query>) => {
      const result = await query(...args);
      if (!rawTimestamps) return result;
      return {
        ...result,
        rows: result.rows.map((value) =>
          Object.fromEntries(
            Object.entries(value).map(([key, field]) => [
              key,
              field instanceof Date
                ? field.toISOString().replace("T", " ").replace("Z", "+00")
                : field,
            ]),
          ),
        ),
      };
    },
  } as unknown as NodePgClient);
  return {
    repository: createGiftPaymentInboxRepository(db, options),
    db,
    options,
    row,
    claim,
    queries,
    clock,
    faults,
  };
}

describe("original-fence worker failure deferral", () => {
  it("defers raw timestamp events and recovers the committed result without another write", async () => {
    const v = deferFixture(true);
    expect(
      await v.repository.deferClaim(v.claim, "PROVIDER_READ_UNAVAILABLE"),
    ).toEqual({ kind: "RETRY" });
    expect(
      await v.repository.deferClaim(v.claim, "PROVIDER_READ_UNAVAILABLE"),
    ).toEqual({ kind: "RETRY" });
    expect(
      v.queries.filter((query) => /^UPDATE/i.test(query.sql)),
    ).toHaveLength(1);
  });
  it.each([
    "PROVIDER_READ_UNAVAILABLE",
    "CHECKOUT_BINDING_UNAVAILABLE",
    "PAYMENT_POSTING_UNAVAILABLE",
  ] as const)(
    "persists %s as bounded RETRY without renewing the original lease",
    async (reason) => {
      const values = deferFixture();
      expect(await values.repository.deferClaim(values.claim, reason)).toEqual({
        kind: "RETRY",
      });
      expect(values.row).toMatchObject({
        state: "RETRY",
        lastErrorCode: reason,
        attempts: 1,
        leaseOwner: "worker-one",
        leaseToken: "original-fence",
        leaseExpiresAt: new Date("2026-10-12T12:00:30.000Z"),
        nextAttemptAt: new Date("2026-10-12T12:00:10.000Z"),
      });
      const update = values.queries.find((entry) => /^UPDATE/i.test(entry.sql));
      expect(update?.sql).toContain("clock_timestamp()");
      expect(update?.sql).toMatch(/e\.attempts\s*=\s*\$/);
      expect(update?.sql.split(/WHERE/i)[0]).not.toMatch(
        /lease_(owner|token|expires_at)\s*=/,
      );
      expect(values.queries.at(-1)?.sql).toBe("commit");
    },
  );
  it("dead-letters the final consumed attempt using the original failure reason", async () => {
    const values = deferFixture();
    values.claim.attempts = 3;
    values.row.attempts = 3;
    expect(
      await values.repository.deferClaim(
        values.claim,
        "PROVIDER_READ_UNAVAILABLE",
      ),
    ).toEqual({ kind: "DEAD_LETTER" });
    expect(values.row).toMatchObject({
      state: "DEAD_LETTER",
      lastErrorCode: "PROVIDER_READ_UNAVAILABLE",
      attempts: 3,
      leaseToken: "original-fence",
    });
  });
  it.each([1, 3])(
    "recovers attempt %i after an applied commit loses its response without another mutation",
    async (attempts) => {
      const values = deferFixture();
      values.claim.attempts = attempts;
      values.row.attempts = attempts;
      values.faults.commitAfterApplied = true;
      await expect(
        values.repository.deferClaim(
          values.claim,
          "PAYMENT_POSTING_UNAVAILABLE",
        ),
      ).rejects.toMatchObject({
        code: "FINANCIAL_INBOX_UNAVAILABLE",
        message: "Financial inbox unavailable",
      });
      values.faults.commitAfterApplied = false;
      values.clock.value = new Date("2026-10-12T12:05:00.000Z");
      const writes = values.queries.filter((entry) =>
        /^UPDATE/i.test(entry.sql),
      ).length;
      expect(
        await values.repository.deferClaim(
          values.claim,
          "PAYMENT_POSTING_UNAVAILABLE",
        ),
      ).toEqual({ kind: attempts === 3 ? "DEAD_LETTER" : "RETRY" });
      expect(
        values.queries.filter((entry) => /^UPDATE/i.test(entry.sql)),
      ).toHaveLength(writes);
    },
  );
  it.each([
    { leaseOwner: "foreign-worker" },
    { leaseToken: "newer-fence" },
    { attempts: 2 },
    { siteId: "other-site" },
    { accountId: "other-account" },
    { environment: "live" },
    { providerAccountReference: "other-remote-account" },
    { payload: { paymentId: "other-payment" } },
    { state: "PROCESSED" },
    { processedAt: new Date(instant) },
    { eventType: "PAYMENT_UPDATED" },
  ])(
    "rejects stale or mismatched persisted authority %j before writes",
    async (change) => {
      const values = deferFixture();
      Object.assign(values.row, change);
      await expect(
        values.repository.deferClaim(values.claim, "PROVIDER_READ_UNAVAILABLE"),
      ).rejects.toMatchObject({ code: "FINANCIAL_INBOX_UNAVAILABLE" });
      expect(values.queries.some((entry) => /^UPDATE/i.test(entry.sql))).toBe(
        false,
      );
    },
  );
  it.each(["app", "database", "after-select"])(
    "denies expired %s time instead of reviving the lease",
    async (mode) => {
      const values = deferFixture();
      const expired = new Date("2026-10-12T12:00:31.000Z");
      if (mode === "app") values.clock.value = expired;
      if (mode === "database") values.clock.database = expired;
      if (mode === "after-select") values.faults.selectClockAdvance = true;
      await expect(
        values.repository.deferClaim(values.claim, "PROVIDER_READ_UNAVAILABLE"),
      ).rejects.toMatchObject({ code: "FINANCIAL_INBOX_UNAVAILABLE" });
      expect(values.row.state).toBe("CLAIMED");
      expect(values.queries.at(-1)?.sql).toBe("rollback");
    },
  );
  it.each(["fence", "SQL"])(
    "retains original CLAIMED state on %s failure and redacts errors",
    async (mode) => {
      const values = deferFixture();
      if (mode === "fence") values.faults.casMiss = true;
      else values.faults.updateError = true;
      await expect(
        values.repository.deferClaim(
          values.claim,
          "PAYMENT_POSTING_UNAVAILABLE",
        ),
      ).rejects.toMatchObject({
        code: "FINANCIAL_INBOX_UNAVAILABLE",
        message: "Financial inbox unavailable",
      });
      expect(values.row.state).toBe("CLAIMED");
      expect(values.row.leaseToken).toBe("original-fence");
    },
  );
  it.each([
    { state: "RETRY", lastErrorCode: "CHECKOUT_BINDING_UNAVAILABLE" },
    {
      state: "RETRY",
      lastErrorCode: "PROVIDER_READ_UNAVAILABLE",
      nextAttemptAt: new Date("2026-10-12T12:01:00.000Z"),
    },
    { state: "DEAD_LETTER", lastErrorCode: "PROVIDER_READ_UNAVAILABLE" },
  ])(
    "rejects contradictory recovery data %j without mutation",
    async (change) => {
      const values = deferFixture();
      Object.assign(values.row, change);
      await expect(
        values.repository.deferClaim(values.claim, "PROVIDER_READ_UNAVAILABLE"),
      ).rejects.toMatchObject({ code: "FINANCIAL_INBOX_UNAVAILABLE" });
      expect(values.queries.some((entry) => /^UPDATE/i.test(entry.sql))).toBe(
        false,
      );
    },
  );
  it("accepts only whitelisted reasons and claim fields, before SQL", async () => {
    for (const reason of ["raw-private-error", null]) {
      const values = deferFixture();
      await expect(
        values.repository.deferClaim(
          values.claim,
          reason as "PROVIDER_READ_UNAVAILABLE",
        ),
      ).rejects.toMatchObject({ code: "FINANCIAL_INBOX_UNAVAILABLE" });
      expect(values.queries).toHaveLength(0);
    }
    const values = deferFixture();
    Object.assign(values.claim, { now: new Date(instant) });
    await expect(
      values.repository.deferClaim(values.claim, "PROVIDER_READ_UNAVAILABLE"),
    ).rejects.toMatchObject({ code: "FINANCIAL_INBOX_UNAVAILABLE" });
    expect(values.queries).toHaveLength(0);
  });
  it.each([0, -1, 300001, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid server retry delay %s without SQL",
    async (retryDelayMs) => {
      const values = deferFixture();
      expect(() =>
        createGiftPaymentInboxRepository(values.db, {
          ...values.options,
          retryDelayMs,
        }),
      ).toThrow("Financial inbox unavailable");
      expect(values.queries).toHaveLength(0);
    },
  );
  it("copies caller authority and server policy before asynchronous work", async () => {
    const values = deferFixture();
    const pending = values.repository.deferClaim(
      values.claim,
      "PROVIDER_READ_UNAVAILABLE",
    );
    values.claim.leaseToken = "mutated-token";
    values.options.retryDelayMs = 300000;
    expect(await pending).toEqual({ kind: "RETRY" });
    expect(values.row.leaseToken).toBe("original-fence");
    expect(values.row.nextAttemptAt).toEqual(
      new Date("2026-10-12T12:00:10.000Z"),
    );
  });
});
