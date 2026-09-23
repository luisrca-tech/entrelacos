import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  invitationGuest,
  rsvpHistory,
  rsvpRequestReceipt,
  site,
} from "./schema";

const migrationsDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

function migrationSql(): string {
  const migrationNames = readdirSync(migrationsDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  if (migrationNames.length === 0)
    throw new Error("Block 4 migration was not generated");
  return migrationNames
    .map((migrationName) =>
      readFileSync(join(migrationsDirectory, migrationName), "utf8"),
    )
    .join("\n");
}

describe("Block 4 database schema and migration", () => {
  it("declares RSVP state, revision, and paired site deadline columns", () => {
    expect(invitationGuest.rsvpState).toBeDefined();
    expect(invitationGuest.rsvpRevision).toBeDefined();
    expect(site.rsvpDeadlineAt).toBeDefined();
    expect(site.rsvpDeadlineTimezone).toBeDefined();
  });

  it("generates tenant-scoped history and replay receipt persistence", () => {
    expect(rsvpHistory.siteId).toBeDefined();
    expect(rsvpHistory.invitationId).toBeDefined();
    expect(rsvpHistory.guestId).toBeDefined();
    expect(rsvpHistory.beforeState).toBeDefined();
    expect(rsvpHistory.afterState).toBeDefined();
    expect(rsvpHistory.actorType).toBeDefined();
    expect(rsvpHistory.actorId).toBeDefined();
    expect(rsvpHistory.actorDisplayName).toBeDefined();
    expect(rsvpHistory.occurredAt).toBeDefined();
    expect(rsvpRequestReceipt.scope).toBeDefined();
    expect(rsvpRequestReceipt.actorType).toBeDefined();
    expect(rsvpRequestReceipt.actorId).toBeDefined();
    expect(rsvpRequestReceipt.requestId).toBeDefined();
    expect(rsvpRequestReceipt.requestHash).toBeDefined();
    expect(rsvpRequestReceipt.responseStatus).toBeDefined();
    expect(rsvpRequestReceipt.responseBody).toBeDefined();

    const sql = migrationSql();
    expect(sql).toContain('CREATE TYPE "public"."rsvp_state"');
    expect(sql).toContain('CREATE TYPE "public"."rsvp_actor_type"');
    expect(sql).toContain('ALTER TABLE "site" ADD COLUMN "rsvp_deadline_at"');
    expect(sql).toContain(
      'ALTER TABLE "site" ADD COLUMN "rsvp_deadline_timezone"',
    );
    expect(sql).toContain('CREATE TABLE "rsvp_history"');
    expect(sql).toContain('CREATE TABLE "rsvp_request_receipt"');
    expect(sql).toContain("rsvp_history_site_invitation_guest_fk");
    expect(sql).toContain("rsvp_request_receipt_site_scope_actor_request_idx");
    expect(sql).toContain("ON DELETE cascade");
  });
});
