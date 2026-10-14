import { drizzle, type NodePgClient } from "drizzle-orm/node-postgres";
import { describe, expect, it, vi } from "vitest";
import { createFinancialReauthenticationRateLimit } from "./financialReauthenticationRateLimit";

function fixture(rawTimestamps = false) {
  const state: {
    row: Record<string, unknown> | null;
    now: Date;
    fail: boolean;
    commitLost: boolean;
  } = {
    row: null,
    now: new Date("2026-10-12T18:00:00.000Z"),
    fail: false,
    commitLost: false,
  };
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let before: typeof state.row = null;
  const query = vi.fn(
    async (statement: string | { text: string }, params: unknown[] = []) => {
      const text = typeof statement === "string" ? statement : statement.text;
      queries.push({ sql: text, params });
      if (/^begin/i.test(text)) {
        before = structuredClone(state.row);
        return { rows: [] };
      }
      if (/^commit/i.test(text)) {
        before = null;
        if (state.commitLost) throw new Error("private SQL commit");
        return { rows: [] };
      }
      if (/^rollback/i.test(text)) {
        if (before) state.row = before;
        return { rows: [] };
      }
      if (state.fail) throw new Error("private SQL credential");
      if (/pg_advisory_xact_lock/.test(text)) return { rows: [] };
      if (/clock_timestamp\(\) AS/.test(text))
        return { rows: [{ currentTime: new Date(state.now) }] };
      if (/FROM "verification"/.test(text))
        return { rows: state.row ? [structuredClone(state.row)] : [] };
      if (/^INSERT INTO "verification"/i.test(text)) {
        state.row = {
          id: params[0],
          identifier: params[1],
          value: params[2],
          expiresAt: new Date(params[3] as string),
        };
        return { rows: [{ id: params[0] }] };
      }
      throw new Error("Unexpected query");
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
  return {
    state,
    queries,
    query,
    db,
    limiter: createFinancialReauthenticationRateLimit(db, {
      maxAttempts: 2,
      windowMs: 60000,
    }),
  };
}

describe("durable financial password attempt limit", () => {
  it("reads raw Drizzle timestamp strings while preserving the bounded counter", async () => {
    const v = fixture(true);
    expect(await v.limiter.consume("admin-one")).toBe(true);
    expect(await v.limiter.consume("admin-one")).toBe(true);
    expect(await v.limiter.consume("admin-one")).toBe(false);
    v.state.now = new Date("2026-10-12T18:01:00.000Z");
    expect(await v.limiter.consume("admin-one")).toBe(true);
  });

  it("rejects a stored expiry differing by one microsecond from the immutable window", async () => {
    const v = fixture();
    await v.limiter.consume("admin-one");
    if (!v.state.row) throw new Error("Missing counter");
    v.state.row.expiresAt = "2026-10-12 18:01:00.000001+00";
    await expect(v.limiter.consume("admin-one")).rejects.toMatchObject({
      code: "REAUTHENTICATION_UNAVAILABLE",
    });
  });

  it("resets a valid expired counter after a server window policy change", async () => {
    const v = fixture();
    await v.limiter.consume("admin-one");
    v.state.now = new Date("2026-10-12T18:01:01.000Z");
    const limiter = createFinancialReauthenticationRateLimit(v.db, {
      maxAttempts: 2,
      windowMs: 120000,
    });
    expect(await limiter.consume("admin-one")).toBe(true);
    expect(v.state.row?.expiresAt).toEqual(
      new Date("2026-10-12T18:03:01.000Z"),
    );
    expect(JSON.parse(v.state.row?.value as string).attempts).toBe(1);
  });
  it("does not reinterpret an active counter under a changed policy", async () => {
    const v = fixture();
    await v.limiter.consume("admin-one");
    const original = structuredClone(v.state.row);
    const limiter = createFinancialReauthenticationRateLimit(v.db, {
      maxAttempts: 2,
      windowMs: 120000,
    });
    await expect(limiter.consume("admin-one")).rejects.toMatchObject({
      code: "REAUTHENTICATION_UNAVAILABLE",
    });
    expect(v.state.row).toEqual(original);
  });
  it("counts attempts before verification and denies the bounded shared user window", async () => {
    const v = fixture();
    expect(await v.limiter.consume("admin-one")).toBe(true);
    expect(await v.limiter.consume("admin-one")).toBe(true);
    expect(await v.limiter.consume("admin-one")).toBe(false);
    expect(JSON.parse(v.state.row?.value as string).attempts).toBe(2);
    expect(v.queries.some((q) => /pg_advisory_xact_lock/.test(q.sql))).toBe(
      true,
    );
    expect(v.queries.at(-1)?.sql).toBe("commit");
  });
  it("resets only at the authoritative database expiry boundary", async () => {
    const v = fixture();
    await v.limiter.consume("admin-one");
    await v.limiter.consume("admin-one");
    v.state.now = new Date("2026-10-12T18:00:59.999Z");
    expect(await v.limiter.consume("admin-one")).toBe(false);
    v.state.now = new Date("2026-10-12T18:01:00.000Z");
    expect(await v.limiter.consume("admin-one")).toBe(true);
    expect(JSON.parse(v.state.row?.value as string).attempts).toBe(1);
  });
  it("does not expose or store raw user identifiers or credential material", async () => {
    const v = fixture();
    await v.limiter.consume("admin:one");
    expect(JSON.stringify(v.state.row)).not.toContain("admin:one");
    expect(JSON.stringify(v.state.row)).not.toMatch(
      /test-only-password|session-one|private-token/,
    );
    expect(v.queries.some((q) => /DELETE|TRUNCATE/i.test(q.sql))).toBe(false);
  });
  it.each(["identifier", "id", "value", "count", "expiry", "future"])(
    "fails closed on corrupt retained state %s",
    async (variant) => {
      const v = fixture();
      await v.limiter.consume("admin-one");
      const row = v.state.row as Record<string, unknown>;
      if (variant === "identifier") row.identifier = "another-purpose";
      if (variant === "id") row.id = "foreign-row";
      if (variant === "value") row.value = "{broken";
      if (variant === "count")
        row.value = JSON.stringify({
          ...JSON.parse(row.value as string),
          attempts: -1,
        });
      if (variant === "expiry")
        row.expiresAt = new Date("2026-10-12T18:02:00.000Z");
      if (variant === "future")
        v.state.now = new Date("2026-10-12T17:59:59.000Z");
      await expect(v.limiter.consume("admin-one")).rejects.toMatchObject({
        status: 503,
        code: "REAUTHENTICATION_UNAVAILABLE",
      });
    },
  );
  it.each(["storage", "commit"])(
    "never grants an attempt after an uncertain %s",
    async (stage) => {
      const v = fixture();
      if (stage === "storage") v.state.fail = true;
      else v.state.commitLost = true;
      const error = await v.limiter.consume("admin-one").catch((e) => e);
      expect(error).toMatchObject({
        status: 503,
        code: "REAUTHENTICATION_UNAVAILABLE",
      });
      expect(error.message).not.toContain("private");
      expect(error.cause).toBeUndefined();
    },
  );
  it.each([
    { maxAttempts: 0, windowMs: 60000 },
    { maxAttempts: 21, windowMs: 60000 },
    { maxAttempts: 2, windowMs: 0 },
    { maxAttempts: 2, windowMs: 300001 },
  ])("rejects invalid server policy %j", async (policy) => {
    const v = fixture();
    expect(() =>
      createFinancialReauthenticationRateLimit(v.db, policy),
    ).toThrow(
      expect.objectContaining({ code: "REAUTHENTICATION_UNAVAILABLE" }),
    );
  });
});
