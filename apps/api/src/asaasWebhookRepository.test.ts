import { createHash } from "node:crypto";
import { drizzle, type NodePgClient } from "drizzle-orm/node-postgres";
import { describe, expect, it, vi } from "vitest";
import type { AsaasInboxEvent } from "./asaasWebhook";
import { createAsaasWebhookRepository } from "./asaasWebhookRepository";

const webhookToken = "local-test-webhook-token-for-durable-inbox";
const tokenHash = createHash("sha256").update(webhookToken).digest("hex");
const account = {
  id: "account-one",
  siteId: "site-one",
  provider: "ASAAS",
  environment: "sandbox",
  accountReference: "remote-account-one",
  webhookTokenHash: tokenHash,
};
const payload = { paymentId: "pay_one", externalReference: "attempt-one" };
function event(): AsaasInboxEvent {
  return {
    id: "inbox-one",
    siteId: "site-one",
    accountId: "account-one",
    provider: "ASAAS",
    environment: "sandbox",
    providerAccountReference: "remote-account-one",
    providerEventId: "evt_one&123",
    eventType: "PAYMENT_RECEIVED",
    payload,
    payloadHash: createHash("sha256")
      .update(
        JSON.stringify([
          "evt_one&123",
          "PAYMENT_RECEIVED",
          "remote-account-one",
          Object.keys(payload)
            .sort()
            .map((key) => [key, payload[key as keyof typeof payload]]),
        ]),
      )
      .digest("hex"),
    receivedAt: "2026-10-12T12:00:00.000Z",
  };
}

function camel(value: string) {
  return value.replace(/_([a-z])/g, (_, character: string) =>
    character.toUpperCase(),
  );
}
function fixture() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let inserted = false;
  let savedHash: string | undefined;
  let missingAccount = false;
  let failSql = "";
  let bindingCopies = 1;
  let commitGate: Promise<void> | null = null;
  let commitStarted = () => {};
  const query = vi.fn(
    async (
      statement: string | { text: string; rowMode?: string },
      params: unknown[] = [],
    ) => {
      const text = typeof statement === "string" ? statement : statement.text;
      queries.push({ sql: text, params });
      if (failSql && text.includes(failSql))
        throw new Error("private-database-secret");
      if (/^commit/i.test(text) && commitGate) {
        commitStarted();
        await commitGate;
      }
      if (/^(begin|commit|rollback)/i.test(text)) return { rows: [] };
      if (/^insert into "financial_event_inbox"/i.test(text)) {
        if (inserted) return { rows: [] };
        inserted = true;
        savedHash = params.find(
          (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
        ) as string | undefined;
        return { rows: [["inbox-one"]] };
      }
      if (/from "financial_event_inbox"/.test(text))
        return { rows: [[savedHash]] };
      if (/from "receiving_account"/.test(text)) {
        if (missingAccount) return { rows: [] };
        const selection = text.match(/^select (.*?) from/i)?.[1] ?? "";
        const columns = [
          ...selection.matchAll(/(?:"([a-z_]+)"\.)?"([a-z_]+)"/g),
        ];
        const row = columns.map(([, table, field]) =>
          table === "site"
            ? false
            : account[camel(field) as keyof typeof account],
        );
        return { rows: Array.from({ length: bindingCopies }, () => row) };
      }
      throw new Error("Unexpected query-only fixture statement");
    },
  );
  const db = drizzle({ query } as unknown as NodePgClient);
  return {
    repository: createAsaasWebhookRepository(db, "sandbox"),
    queries,
    missing: () => {
      missingAccount = true;
    },
    collision: () => {
      inserted = true;
      savedHash = "b".repeat(64);
    },
    failure: (sql: string) => {
      failSql = sql;
    },
    multipleBindings: () => {
      bindingCopies = 2;
    },
    holdCommit: () => {
      let release = () => {};
      commitGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        commitStarted = resolve;
      });
      return { release, started };
    },
  };
}

describe("Asaas stored webhook binding and inbox repository", () => {
  it("resolves no per-account binding once sub-account webhook tokens were dropped", async () => {
    const values = fixture();
    expect(await values.repository.resolveBinding(tokenHash)).toBeNull();
    expect(values.queries).toHaveLength(0);
  });
  it("inserts scoped authenticated safe correlation before commit and deduplicates unchanged delivery", async () => {
    const values = fixture();
    expect(await values.repository.append(event())).toBe("INSERTED");
    expect(values.queries.at(-1)?.sql).toMatch(/^commit/i);
    const insert = values.queries.find((query) =>
      query.sql.startsWith('insert into "financial_event_inbox"'),
    );
    expect(insert?.sql).toContain(
      'on conflict ("site_id","account_id","environment","provider_event_reference") do nothing',
    );
    expect(insert?.params).toContain("evt_one&123");
    expect(insert?.params).toContain("site-one");
    expect(insert?.params).toContain("account-one");
    expect(JSON.stringify(insert?.params)).not.toContain(tokenHash);
    expect(
      await values.repository.append({ ...event(), id: "delivery-two" }),
    ).toBe("DUPLICATE");
  });

  it("preserves a hash collision instead of treating it as an accepted duplicate", async () => {
    const values = fixture();
    values.collision();
    expect(await values.repository.append(event())).toBe("COLLISION");
  });

  it("refuses missing authoritative account without writing an inbox row", async () => {
    const values = fixture();
    values.missing();
    expect(await values.repository.resolveBinding(tokenHash)).toBeNull();
    await expect(values.repository.append(event())).rejects.toMatchObject({
      code: "WEBHOOK_UNAVAILABLE",
    });
    expect(values.queries.some((query) => query.sql.startsWith("insert"))).toBe(
      false,
    );
  });

  it("rejects an ambiguous binding and wrong selected environment", async () => {
    const values = fixture();
    values.multipleBindings();
    expect(await values.repository.resolveBinding(tokenHash)).toBeNull();
    const other = fixture();
    await expect(
      other.repository.append({ ...event(), environment: "live" }),
    ).rejects.toMatchObject({ code: "WEBHOOK_UNAVAILABLE" });
    expect(other.queries).toHaveLength(0);
  });

  it.each([
    "begin",
    'from "receiving_account"',
    'insert into "financial_event_inbox"',
    "commit",
  ])("sanitizes persistence failure at %s", async (sql) => {
    const values = fixture();
    values.failure(sql);
    await expect(values.repository.append(event())).rejects.toMatchObject({
      code: "WEBHOOK_UNAVAILABLE",
      message: "Webhook persistence unavailable",
    });
  });

  it.each([
    { payloadHash: "b".repeat(64) },
    { payload: { creditCardToken: "private" } },
    { provider: "OTHER" },
    { providerAccountReference: "foreign-account" },
    { receivedAt: "invalid" },
  ])(
    "rejects invalid normalized event or mismatched stored binding %j",
    async (change) => {
      const values = fixture();
      const input = { ...event(), ...change } as AsaasInboxEvent;
      if (!("payloadHash" in change))
        input.payloadHash = createHash("sha256")
          .update(
            JSON.stringify([
              input.providerEventId,
              input.eventType,
              input.providerAccountReference,
              Object.keys(input.payload)
                .sort()
                .map((key) => [key, input.payload[key]]),
            ]),
          )
          .digest("hex");
      await expect(values.repository.append(input)).rejects.toMatchObject({
        code: "WEBHOOK_UNAVAILABLE",
      });
      expect(
        values.queries.some((query) => query.sql.startsWith("insert")),
      ).toBe(false);
    },
  );
});
