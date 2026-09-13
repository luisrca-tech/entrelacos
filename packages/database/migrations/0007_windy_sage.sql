CREATE TYPE "public"."message_request_result" AS ENUM('APPLIED', 'NO_CHANGE', 'REMOVED');--> statement-breakpoint
CREATE TYPE "public"."sms_reservation_status" AS ENUM('RESERVED', 'PROVIDER_ACCEPTED', 'FAILED_FINAL', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."sms_usage_mode" AS ENUM('SIMULATED', 'REAL_SMS');--> statement-breakpoint
CREATE TABLE "family_message" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"group_id" text NOT NULL,
	"author_member_id" text NOT NULL,
	"author_name" text NOT NULL,
	"group_name" text NOT NULL,
	"text" text NOT NULL,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "family_message_revision_check" CHECK ("family_message"."revision" > 0),
	CONSTRAINT "family_message_author_name_not_blank_check" CHECK (length(trim("family_message"."author_name")) > 0),
	CONSTRAINT "family_message_group_name_not_blank_check" CHECK (length(trim("family_message"."group_name")) > 0),
	CONSTRAINT "family_message_text_not_blank_check" CHECK (length(regexp_replace("family_message"."text", '[[:space:]]', '', 'g')) > 0),
	CONSTRAINT "family_message_text_length_check" CHECK (char_length("family_message"."text") BETWEEN 1 AND 1000),
	CONSTRAINT "family_message_text_no_angle_brackets_check" CHECK (position('<' in "family_message"."text") = 0 AND position('>' in "family_message"."text") = 0),
	CONSTRAINT "family_message_text_control_chars_check" CHECK (regexp_replace("family_message"."text", E'\n', '', 'g') !~ '[[:cntrl:]]' AND "family_message"."text" !~ (E'[' || chr(127) || '-' || chr(159) || ']'))
);
--> statement-breakpoint
CREATE TABLE "message_request_receipt" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"group_id" text NOT NULL,
	"session_id" text NOT NULL,
	"request_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"revision" integer NOT NULL,
	"result" "message_request_result" NOT NULL,
	"response_body" jsonb,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_request_receipt_request_hash_check" CHECK ("message_request_receipt"."request_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "message_request_receipt_revision_check" CHECK ("message_request_receipt"."revision" >= 0),
	CONSTRAINT "message_request_receipt_removal_check" CHECK (("message_request_receipt"."result" = 'REMOVED' AND "message_request_receipt"."removed_at" IS NOT NULL AND "message_request_receipt"."response_body" IS NULL) OR ("message_request_receipt"."result" <> 'REMOVED' AND "message_request_receipt"."removed_at" IS NULL AND "message_request_receipt"."response_body" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "rsvp_request_receipt_group" (
	"site_id" text NOT NULL,
	"receipt_id" text NOT NULL,
	"group_id" text NOT NULL,
	CONSTRAINT "rsvp_request_receipt_group_pk" PRIMARY KEY("site_id","receipt_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "sms_send_reservation" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"usage_id" text NOT NULL,
	"mode" "sms_usage_mode" NOT NULL,
	"status" "sms_reservation_status" DEFAULT 'RESERVED' NOT NULL,
	"provider_reference" text,
	"failure_code" text,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_send_reservation_site_id_key" UNIQUE("site_id","id")
);
--> statement-breakpoint
CREATE TABLE "sms_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"mode" "sms_usage_mode" NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"provider_accepted" integer DEFAULT 0 NOT NULL,
	"failed_final" integer DEFAULT 0 NOT NULL,
	"unknown" integer DEFAULT 0 NOT NULL,
	"consumed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_usage_site_id_mode_key" UNIQUE("site_id","id","mode"),
	CONSTRAINT "sms_usage_period_check" CHECK ("sms_usage"."period_end" > "sms_usage"."period_start"),
	CONSTRAINT "sms_usage_reserved_check" CHECK ("sms_usage"."reserved" >= 0),
	CONSTRAINT "sms_usage_provider_accepted_check" CHECK ("sms_usage"."provider_accepted" >= 0),
	CONSTRAINT "sms_usage_failed_final_check" CHECK ("sms_usage"."failed_final" >= 0),
	CONSTRAINT "sms_usage_unknown_check" CHECK ("sms_usage"."unknown" >= 0),
	CONSTRAINT "sms_usage_consumed_check" CHECK ("sms_usage"."consumed" >= 0),
	CONSTRAINT "sms_usage_consumed_total_check" CHECK ("sms_usage"."consumed" = "sms_usage"."reserved" + "sms_usage"."provider_accepted" + "sms_usage"."failed_final" + "sms_usage"."unknown")
);
--> statement-breakpoint
ALTER TABLE "rsvp_request_receipt" ALTER COLUMN "response_body" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "guest_group" ADD COLUMN "message_blocked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "guest_group" ADD COLUMN "message_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "guest_verification_send" ADD COLUMN "sms_reservation_id" text;--> statement-breakpoint
ALTER TABLE "rsvp_request_receipt" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "mural_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "sms_monthly_limit" integer;--> statement-breakpoint
ALTER TABLE "rsvp_request_receipt" ADD CONSTRAINT "rsvp_request_receipt_site_id_key" UNIQUE("site_id","id");--> statement-breakpoint
ALTER TABLE "family_message" ADD CONSTRAINT "family_message_site_group_fk" FOREIGN KEY ("site_id","group_id") REFERENCES "public"."guest_group"("site_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_request_receipt" ADD CONSTRAINT "message_request_receipt_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rsvp_request_receipt_group" ADD CONSTRAINT "rsvp_request_receipt_group_receipt_fk" FOREIGN KEY ("site_id","receipt_id") REFERENCES "public"."rsvp_request_receipt"("site_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rsvp_request_receipt_group" ADD CONSTRAINT "rsvp_request_receipt_group_site_group_fk" FOREIGN KEY ("site_id","group_id") REFERENCES "public"."guest_group"("site_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
UPDATE "rsvp_request_receipt" AS receipt
SET
	"response_status" = 'REMOVED',
	"response_body" = NULL,
	"removed_at" = CURRENT_TIMESTAMP
WHERE receipt."scope" = 'ADMIN'
	AND receipt."response_status" <> 'REMOVED'
	AND EXISTS (
		SELECT 1
		FROM jsonb_array_elements(receipt."response_body" -> 'members') AS response_member
		WHERE NOT EXISTS (
			SELECT 1
			FROM "guest_member" AS member
			WHERE member."site_id" = receipt."site_id"
				AND member."id" = response_member ->> 'id'
		)
	);--> statement-breakpoint
INSERT INTO "rsvp_request_receipt_group" ("site_id", "receipt_id", "group_id")
SELECT DISTINCT receipt."site_id", receipt."id", member."group_id"
FROM "rsvp_request_receipt" AS receipt
CROSS JOIN LATERAL jsonb_array_elements(receipt."response_body" -> 'members') AS response_member
INNER JOIN "guest_member" AS member
	ON member."site_id" = receipt."site_id"
	AND member."id" = response_member ->> 'id'
WHERE receipt."scope" = 'ADMIN'
	AND receipt."response_status" <> 'REMOVED'
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "sms_send_reservation" ADD CONSTRAINT "sms_send_reservation_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_send_reservation" ADD CONSTRAINT "sms_send_reservation_site_usage_mode_fk" FOREIGN KEY ("site_id","usage_id","mode") REFERENCES "public"."sms_usage"("site_id","id","mode") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_usage" ADD CONSTRAINT "sms_usage_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "family_message_site_group_idx" ON "family_message" USING btree ("site_id","group_id");--> statement-breakpoint
CREATE INDEX "family_message_mural_order_idx" ON "family_message" USING btree ("site_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_request_receipt_site_group_session_request_idx" ON "message_request_receipt" USING btree ("site_id","group_id","session_id","request_id");--> statement-breakpoint
CREATE INDEX "message_request_receipt_site_group_created_idx" ON "message_request_receipt" USING btree ("site_id","group_id","created_at");--> statement-breakpoint
CREATE INDEX "rsvp_request_receipt_group_lookup_idx" ON "rsvp_request_receipt_group" USING btree ("site_id","group_id","receipt_id");--> statement-breakpoint
CREATE INDEX "sms_send_reservation_site_usage_idx" ON "sms_send_reservation" USING btree ("site_id","usage_id");--> statement-breakpoint
CREATE INDEX "sms_send_reservation_site_status_idx" ON "sms_send_reservation" USING btree ("site_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_usage_site_period_mode_idx" ON "sms_usage" USING btree ("site_id","period_start","mode");--> statement-breakpoint
CREATE INDEX "sms_usage_site_period_idx" ON "sms_usage" USING btree ("site_id","period_start");--> statement-breakpoint
ALTER TABLE "guest_verification_send" ADD CONSTRAINT "guest_verification_send_sms_reservation_fk" FOREIGN KEY ("site_id","sms_reservation_id") REFERENCES "public"."sms_send_reservation"("site_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guest_verification_send_site_reservation_idx" ON "guest_verification_send" USING btree ("site_id","sms_reservation_id");--> statement-breakpoint
ALTER TABLE "guest_group" ADD CONSTRAINT "guest_group_message_revision_check" CHECK ("guest_group"."message_revision" >= 0);--> statement-breakpoint
ALTER TABLE "rsvp_request_receipt" ADD CONSTRAINT "rsvp_request_receipt_removal_check" CHECK (("rsvp_request_receipt"."response_status" = 'REMOVED' AND "rsvp_request_receipt"."removed_at" IS NOT NULL AND "rsvp_request_receipt"."response_body" IS NULL) OR ("rsvp_request_receipt"."response_status" <> 'REMOVED' AND "rsvp_request_receipt"."removed_at" IS NULL AND "rsvp_request_receipt"."response_body" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "site" ADD CONSTRAINT "site_sms_monthly_limit_check" CHECK ("site"."sms_monthly_limit" IS NULL OR "site"."sms_monthly_limit" BETWEEN 0 AND 1000000);
