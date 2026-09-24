import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  invitation,
  muralMessage,
  muralMessageRateLimitEvent,
  muralMessageRequestReceipt,
} from "./schema";

const migrationsDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

function latestMigrationSql(): string {
  const latest = readdirSync(migrationsDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()
    .at(-1);
  if (!latest) throw new Error("No database migrations found");
  return readFileSync(join(migrationsDirectory, latest), "utf8");
}

describe("public mural database schema", () => {
  it("stores independent site messages, durable receipts, and publish events", () => {
    expect(muralMessage.id.primary).toBe(true);
    expect(muralMessage.siteId.notNull).toBe(true);
    expect(muralMessage.authorName.notNull).toBe(true);
    expect(muralMessage.text.notNull).toBe(true);
    expect(muralMessage.createdAt.notNull).toBe(true);

    expect(muralMessageRequestReceipt.siteId.notNull).toBe(true);
    expect(muralMessageRequestReceipt.requestId.notNull).toBe(true);
    expect(muralMessageRequestReceipt.requestHash.notNull).toBe(true);
    expect(muralMessageRequestReceipt.messageId.notNull).toBe(true);
    expect(muralMessageRequestReceipt.acceptedAt.notNull).toBe(true);

    expect(muralMessageRateLimitEvent.siteId.notNull).toBe(true);
    expect(muralMessageRateLimitEvent.ipFingerprint.notNull).toBe(true);
    expect(muralMessageRateLimitEvent.occurredAt.notNull).toBe(true);
    expect(Object.hasOwn(invitation, "messageBlocked")).toBe(false);
    expect(Object.hasOwn(invitation, "messageRevision")).toBe(false);
  });

  it("locks and refuses legacy messages before dropping their schema", () => {
    const sql = latestMigrationSql();
    const lockPosition = sql.indexOf(
      'LOCK TABLE "invitation_message", "message_request_receipt"',
    );
    const guardBlockPosition = sql.indexOf("DO $$");
    const guardPosition = sql.indexOf(
      'IF EXISTS (SELECT 1 FROM "invitation_message" LIMIT 1)',
    );
    const receiptGuardPosition = sql.indexOf(
      'IF EXISTS (SELECT 1 FROM "message_request_receipt" WHERE "response_body" IS NOT NULL LIMIT 1)',
    );
    const firstCreatePosition = sql.indexOf("CREATE TABLE");
    const firstDropPosition = sql.search(/DROP TABLE "invitation_message"/i);

    expect(lockPosition).toBeGreaterThanOrEqual(0);
    expect(lockPosition).toBeLessThan(guardBlockPosition);
    expect(guardPosition).toBeGreaterThan(guardBlockPosition);
    expect(receiptGuardPosition).toBeGreaterThan(guardPosition);
    expect(receiptGuardPosition).toBeLessThan(firstCreatePosition);
    expect(guardPosition).toBeLessThan(firstDropPosition);
    expect(sql).toContain("Invitation mural migration stopped");
    expect(sql).toContain('DROP TABLE "message_request_receipt"');
    expect(sql).toContain('DROP COLUMN "message_blocked"');
    expect(sql).toContain('DROP COLUMN "message_revision"');
    expect(sql).not.toContain('DELETE FROM "invitation_message"');
    expect(sql).not.toMatch(
      /DROP TABLE "(?:invitation_message|message_request_receipt)" CASCADE/i,
    );
  });
});
