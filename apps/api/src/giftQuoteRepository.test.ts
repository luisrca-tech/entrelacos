import { drizzle, type NodePgClient } from "drizzle-orm/node-postgres";
import { describe, expect, it, vi } from "vitest";
import { createGiftQuoteRepository } from "./giftQuoteRepository";
import type { GiftQuoteSnapshot } from "./giftQuotes";

const createdAt = "2026-10-12T12:00:00.000Z";
function snapshot(): GiftQuoteSnapshot {
  const receiving = {
    siteId: "site-one",
    provider: "ASAAS",
    operatorReference: "operator-one",
    accountReference: "remote-one",
    recipientReference: "recipient-one",
    bankReference: "bank-one",
    destinationVersion: 1,
    environment: "sandbox" as const,
  };
  return {
    quote: {
      id: "quote-one",
      siteId: "site-one",
      giftId: "gift-one",
      title: "Gift",
      method: "PIX",
      currency: "BRL",
      nominalCents: 10000,
      commissionBasisPoints: 200,
      commissionCents: 200,
      processingCents: 0,
      totalCents: 10200,
      policyVersion: "policy-one",
      expiresAt: "2026-10-12T12:05:00.000Z",
      mode: "sandbox",
    },
    gift: {
      id: "gift-one",
      siteId: "site-one",
      title: "Gift",
      description: "",
      nominalCents: 10000,
      currency: "BRL",
      image: null,
      sortOrder: 0,
    },
    receiving,
    pricing: {
      ...receiving,
      verification: "verified",
      provenance: "provider",
      observedAt: "2026-10-12T11:59:30.000Z",
      expiresAt: "2026-10-12T12:10:00.000Z",
      policy: {
        version: "policy-one",
        method: "PIX",
        commissionBasisPoints: 200,
        processingBasisPoints: 0,
        processingFixedCents: 0,
        rounding: "CEILING",
      },
    },
    createdAt,
    expiresAt: "2026-10-12T12:05:00.000Z",
  };
}
function fixture() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const stored = {
    id: "account-one",
    siteId: "site-one",
    provider: "ASAAS",
    environment: "sandbox",
    accountReference: "remote-one",
    operatorReference: "operator-one",
    recipientReference: "recipient-one",
    isCurrent: true,
    version: 1,
    bankReference: "bank-one",
    accountId: "account-one",
  };
  let failStatement = "";
  let copies = 1;
  let clock = new Date(createdAt);
  let clockReads = 0;
  let expiresDuringRead = false;
  const query = vi.fn(
    async (statement: string | { text: string }, params: unknown[] = []) => {
      const sql = typeof statement === "string" ? statement : statement.text;
      queries.push({ sql, params });
      if (failStatement && sql.includes(failStatement))
        throw new Error("private-database-key");
      if (/^(begin|commit|rollback)/i.test(sql)) return { rows: [] };
      if (/^insert into "gift_quote_record"/.test(sql))
        return { rows: [["quote-one"]] };
      const columns = [
        ...(sql.match(/^select (.*?) from/i)?.[1] ?? "").matchAll(
          /(?:"[a-z_]+"\.)?"([a-z_]+)"/g,
        ),
      ];
      const values = columns.map(
        ([, field]) =>
          stored[
            field.replace(/_([a-z])/g, (_, letter: string) =>
              letter.toUpperCase(),
            ) as keyof typeof stored
          ],
      );
      return { rows: Array.from({ length: copies }, () => values) };
    },
  );
  const db = drizzle({ query } as unknown as NodePgClient);
  return {
    repository: createGiftQuoteRepository(db, {
      now: () => {
        clockReads++;
        return expiresDuringRead && clockReads > 1
          ? new Date(snapshot().expiresAt)
          : clock;
      },
    }),
    queries,
    stored,
    fail: (value: string) => {
      failStatement = value;
    },
    copies: (value: number) => {
      copies = value;
    },
    clock: (value: Date) => {
      clock = value;
    },
    expireDuringRead: () => {
      expiresDuringRead = true;
    },
  };
}
describe("immutable stored gift quote append", () => {
  it("pins a stored account/destination and inserts the immutable whitelisted snapshot", async () => {
    const values = fixture();
    const input = snapshot();
    Object.assign(input, { credential: "private-key" });
    Object.assign(input.receiving, { credential: "private-key" });
    await values.repository.append(input);
    const insert = values.queries.find((entry) =>
      entry.sql.startsWith('insert into "gift_quote_record"'),
    );
    expect(insert?.params).toContain("account-one");
    expect(insert?.params).toContain("site-one");
    expect(insert?.params).toContain("sandbox");
    expect(insert?.params).toContain(10200);
    const frozen = insert?.params.find(
      (value) => typeof value === "string" && value.startsWith('{"quote"'),
    );
    expect(typeof frozen).toBe("string");
    expect(JSON.parse(frozen as string)).toEqual(snapshot());
    expect(JSON.stringify(insert?.params)).not.toContain("private-key");
    expect(insert?.sql).not.toContain("on conflict");
    expect(values.queries.at(-1)?.sql).toBe("commit");
    const selects = values.queries.filter((entry) =>
      entry.sql.startsWith("select"),
    );
    expect(selects).toHaveLength(2);
    expect(selects.every((entry) => entry.sql.includes("for share"))).toBe(
      true,
    );
    expect(selects.map((entry) => entry.sql).join(" ")).not.toMatch(
      /credential|masked_descriptor|webhook_token/,
    );
  });

  it.each([
    ["accountReference", "foreign"],
    ["recipientReference", "foreign"],
    ["operatorReference", "foreign"],
    ["environment", "live"],
    ["siteId", "other-site"],
    ["provider", "OTHER"],
    ["isCurrent", false],
    ["version", 2],
    ["bankReference", "foreign"],
    ["accountId", "foreign"],
  ] as const)("rejects a changed stored binding %s", async (field, value) => {
    const values = fixture();
    Object.assign(values.stored, { [field]: value });
    await expect(values.repository.append(snapshot())).rejects.toMatchObject({
      code: "QUOTE_STORAGE_UNAVAILABLE",
    });
    expect(values.queries.some((entry) => entry.sql.startsWith("insert"))).toBe(
      false,
    );
  });

  it.each([0, 2])(
    "refuses missing or ambiguous stored account/destination (%i)",
    async (count) => {
      const values = fixture();
      values.copies(count);
      await expect(values.repository.append(snapshot())).rejects.toMatchObject({
        code: "QUOTE_STORAGE_UNAVAILABLE",
      });
      expect(
        values.queries.some((entry) => entry.sql.startsWith("insert")),
      ).toBe(false);
    },
  );

  it.each(["totalCents", "commissionCents", "policyVersion"])(
    "rejects corrupt frozen quote math/policy %s before SQL",
    async (field) => {
      const values = fixture();
      const input = snapshot();
      Object.assign(input.quote, {
        [field]: field === "policyVersion" ? "wrong" : 1,
      });
      await expect(values.repository.append(input)).rejects.toMatchObject({
        code: "QUOTE_STORAGE_UNAVAILABLE",
      });
      expect(values.queries).toHaveLength(0);
    },
  );

  it("rejects expired or future-created snapshots before insertion", async () => {
    for (const instant of [
      "2026-10-12T12:05:00.000Z",
      "2026-10-12T11:59:59.000Z",
    ]) {
      const values = fixture();
      values.clock(new Date(instant));
      await expect(values.repository.append(snapshot())).rejects.toMatchObject({
        code: "QUOTE_STORAGE_UNAVAILABLE",
      });
      expect(
        values.queries.some((entry) => entry.sql.startsWith("insert")),
      ).toBe(false);
    }
  });

  it("rechecks the clock after account and destination reads before insertion", async () => {
    const values = fixture();
    values.expireDuringRead();
    await expect(values.repository.append(snapshot())).rejects.toMatchObject({
      code: "QUOTE_STORAGE_UNAVAILABLE",
    });
    expect(
      values.queries.filter((entry) => entry.sql.startsWith("select")),
    ).toHaveLength(2);
    expect(values.queries.some((entry) => entry.sql.startsWith("insert"))).toBe(
      false,
    );
    expect(values.queries.at(-1)?.sql).toBe("rollback");
  });

  it.each([
    "begin",
    'from "receiving_account"',
    'from "receiving_destination"',
    'insert into "gift_quote_record"',
    "commit",
  ])(
    "sanitizes failure at %s without overwriting any quote",
    async (statement) => {
      const values = fixture();
      values.fail(statement);
      await expect(values.repository.append(snapshot())).rejects.toMatchObject({
        code: "QUOTE_STORAGE_UNAVAILABLE",
        status: 503,
        message: "Gift quote persistence unavailable",
      });
      expect(values.queries.map((entry) => entry.sql).join(" ")).not.toMatch(
        /update|delete|truncate|on conflict/i,
      );
    },
  );
});
