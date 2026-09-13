import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  familyMessage,
  guestGroup,
  guestVerificationSend,
  messageRequestReceipt,
  rsvpRequestReceipt,
  rsvpRequestReceiptGroup,
  site,
  smsSendReservation,
  smsUsage,
} from "./schema";

const migrationsDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

function migrationSql(): string {
  return readdirSync(migrationsDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()
    .map((name) => readFileSync(join(migrationsDirectory, name), "utf8"))
    .join("\n");
}

describe("Block 5 Wave 0 database foundation", () => {
  it("declares site mural and SMS configuration plus group message state", () => {
    expect(site.muralEnabled).toBeDefined();
    expect(site.smsMonthlyLimit).toBeDefined();
    expect(guestGroup.messageBlocked).toBeDefined();
    expect(guestGroup.messageRevision).toBeDefined();
  });

  it("declares current messages, durable message receipts, and RSVP redaction", () => {
    expect(familyMessage.authorMemberId).toBeDefined();
    expect(familyMessage.authorName).toBeDefined();
    expect(familyMessage.groupName).toBeDefined();
    expect(familyMessage.text).toBeDefined();
    expect(familyMessage.revision).toBeDefined();
    expect(familyMessage.createdAt).toBeDefined();
    expect(familyMessage.updatedAt).toBeDefined();
    expect(messageRequestReceipt.siteId).toBeDefined();
    expect(messageRequestReceipt.groupId).toBeDefined();
    expect(messageRequestReceipt.sessionId).toBeDefined();
    expect(messageRequestReceipt.requestId).toBeDefined();
    expect(messageRequestReceipt.requestHash).toBeDefined();
    expect(messageRequestReceipt.revision).toBeDefined();
    expect(messageRequestReceipt.result).toBeDefined();
    expect(messageRequestReceipt.responseBody).toBeDefined();
    expect(messageRequestReceipt.removedAt).toBeDefined();
    expect(rsvpRequestReceipt.responseBody).toBeDefined();
    expect(rsvpRequestReceipt.removedAt).toBeDefined();
    expect(rsvpRequestReceiptGroup.receiptId).toBeDefined();
    expect(rsvpRequestReceiptGroup.groupId).toBeDefined();
  });

  it("declares site-owned, mode-separated SMS usage and reservations", () => {
    expect(smsUsage.siteId).toBeDefined();
    expect(smsUsage.periodStart).toBeDefined();
    expect(smsUsage.periodEnd).toBeDefined();
    expect(smsUsage.mode).toBeDefined();
    expect(smsUsage.reserved).toBeDefined();
    expect(smsUsage.providerAccepted).toBeDefined();
    expect(smsUsage.failedFinal).toBeDefined();
    expect(smsUsage.unknown).toBeDefined();
    expect(smsUsage.consumed).toBeDefined();
    expect(smsSendReservation.usageId).toBeDefined();
    expect(smsSendReservation.mode).toBeDefined();
    expect(smsSendReservation.status).toBeDefined();
    expect(guestVerificationSend.smsReservationId).toBeDefined();
  });

  it("generates the Wave 0 migration with tenant-safe indexes and checks", () => {
    const sql = migrationSql();
    expect(sql).toContain('CREATE TYPE "public"."message_request_result"');
    expect(sql).toContain('CREATE TYPE "public"."sms_usage_mode"');
    expect(sql).toContain('CREATE TYPE "public"."sms_reservation_status"');
    expect(sql).toContain('CREATE TABLE "family_message"');
    expect(sql).toContain('CREATE TABLE "message_request_receipt"');
    expect(sql).toContain('CREATE TABLE "rsvp_request_receipt_group"');
    expect(sql).toContain('CREATE TABLE "sms_usage"');
    expect(sql).toContain('CREATE TABLE "sms_send_reservation"');
    expect(sql).toContain("family_message_mural_order_idx");
    expect(sql).toContain(
      "message_request_receipt_site_group_session_request_idx",
    );
    expect(sql).toContain("sms_usage_site_period_mode_idx");
    expect(sql).toContain("family_message_text_control_chars_check");
    expect(sql).toContain("message_request_receipt_site_id_site_id_fk");
    expect(sql).toContain("rsvp_request_receipt_site_id_key");
    expect(sql).toContain('INSERT INTO "rsvp_request_receipt_group"');
    expect(sql).toContain("jsonb_array_elements");
    expect(sql).toContain('UPDATE "rsvp_request_receipt" AS receipt');
    expect(sql).toContain("\"response_status\" = 'REMOVED'");
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain('"response_body" IS NOT NULL');
    expect(sql).not.toContain("family_message_author_site_group_member_fk");
    expect(sql).not.toContain("message_request_receipt_site_group_fk");
    expect(sql).not.toContain("message_request_receipt_site_group_session_fk");
    expect(sql).toContain("ON DELETE cascade");
  });
});
