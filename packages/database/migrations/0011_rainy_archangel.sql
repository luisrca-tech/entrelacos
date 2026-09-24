-- Hold legacy tables through the preflight so no message or unredacted receipt can race the check.
LOCK TABLE "invitation_message", "message_request_receipt" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "invitation_message" LIMIT 1) THEN
		RAISE EXCEPTION 'Invitation mural migration stopped: invitation_message contains records that require explicit, reviewed removal';
	END IF;
	IF EXISTS (SELECT 1 FROM "message_request_receipt" WHERE "response_body" IS NOT NULL LIMIT 1) THEN
		RAISE EXCEPTION 'Invitation mural migration stopped: message_request_receipt contains stored responses that require redaction';
	END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "mural_message" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"author_name" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mural_message_author_name_check" CHECK ("mural_message"."author_name" = regexp_replace(trim("mural_message"."author_name"), '[[:space:]]+', ' ', 'g') AND char_length("mural_message"."author_name") BETWEEN 1 AND 160 AND position('<' in "mural_message"."author_name") = 0 AND position('>' in "mural_message"."author_name") = 0 AND "mural_message"."author_name" !~ '[[:cntrl:]]'),
	CONSTRAINT "mural_message_text_not_blank_check" CHECK (length(regexp_replace("mural_message"."text", '[[:space:]]', '', 'g')) > 0),
	CONSTRAINT "mural_message_text_length_check" CHECK (char_length("mural_message"."text") BETWEEN 1 AND 1000),
	CONSTRAINT "mural_message_text_no_angle_brackets_check" CHECK (position('<' in "mural_message"."text") = 0 AND position('>' in "mural_message"."text") = 0),
	CONSTRAINT "mural_message_text_control_chars_check" CHECK (regexp_replace("mural_message"."text", E'\n', '', 'g') !~ '[[:cntrl:]]' AND "mural_message"."text" !~ (E'[' || chr(127) || '-' || chr(159) || ']'))
);
--> statement-breakpoint
CREATE TABLE "mural_message_rate_limit_event" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"ip_fingerprint" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mural_message_rate_limit_ip_fingerprint_check" CHECK ("mural_message_rate_limit_event"."ip_fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "mural_message_request_receipt" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"request_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"message_id" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mural_message_request_receipt_request_hash_check" CHECK ("mural_message_request_receipt"."request_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
DROP TABLE "invitation_message";--> statement-breakpoint
DROP TABLE "message_request_receipt";--> statement-breakpoint
ALTER TABLE "invitation" DROP CONSTRAINT "invitation_message_revision_check";--> statement-breakpoint
ALTER TABLE "mural_message" ADD CONSTRAINT "mural_message_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mural_message_rate_limit_event" ADD CONSTRAINT "mural_message_rate_limit_event_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mural_message_request_receipt" ADD CONSTRAINT "mural_message_request_receipt_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mural_message_site_order_idx" ON "mural_message" USING btree ("site_id","created_at","id");--> statement-breakpoint
CREATE INDEX "mural_message_rate_limit_site_ip_time_idx" ON "mural_message_rate_limit_event" USING btree ("site_id","ip_fingerprint","occurred_at");--> statement-breakpoint
CREATE INDEX "mural_message_rate_limit_occurred_at_idx" ON "mural_message_rate_limit_event" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mural_message_request_receipt_site_request_idx" ON "mural_message_request_receipt" USING btree ("site_id","request_id");--> statement-breakpoint
ALTER TABLE "invitation" DROP COLUMN "message_blocked";--> statement-breakpoint
ALTER TABLE "invitation" DROP COLUMN "message_revision";--> statement-breakpoint
DROP TYPE "public"."message_request_result";
