CREATE TYPE "public"."guest_verification_mode" AS ENUM('MOCK', 'TWILIO');--> statement-breakpoint
CREATE TYPE "public"."guest_verification_challenge_status" AS ENUM('PENDING', 'VERIFIED', 'EXPIRED', 'LOCKED', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."guest_verification_send_status" AS ENUM('RESERVED', 'PROVIDER_ACCEPTED', 'FAILED_FINAL', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."guest_rate_limit_action" AS ENUM('LOOKUP', 'OTP_SEND', 'OTP_VERIFY');--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "is_demo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE "guest_group" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"phone_e164" text,
	"representative_member_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_group_name_not_blank_check" CHECK (length(trim("name")) > 0),
	CONSTRAINT "guest_group_normalized_name_not_blank_check" CHECK (length(trim("normalized_name")) > 0),
	CONSTRAINT "guest_group_phone_e164_check" CHECK ("phone_e164" IS NULL OR "phone_e164" ~ '^[+]55[1-9]{2}(9[0-9]{8}|[2-5][0-9]{7})$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "guest_group_site_id_id_idx" ON "guest_group" USING btree ("site_id", "id");--> statement-breakpoint
CREATE UNIQUE INDEX "guest_group_site_id_normalized_name_idx" ON "guest_group" USING btree ("site_id", "normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "guest_group_site_id_phone_e164_idx" ON "guest_group" USING btree ("site_id", "phone_e164") WHERE "phone_e164" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "guest_group_site_id_idx" ON "guest_group" USING btree ("site_id");--> statement-breakpoint
ALTER TABLE "guest_group" ADD CONSTRAINT "guest_group_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "guest_member" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"group_id" text NOT NULL,
	"full_name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_member_full_name_not_blank_check" CHECK (length(trim("full_name")) > 0),
	CONSTRAINT "guest_member_normalized_name_not_blank_check" CHECK (length(trim("normalized_name")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "guest_member_site_id_group_id_id_idx" ON "guest_member" USING btree ("site_id", "group_id", "id");--> statement-breakpoint
CREATE UNIQUE INDEX "guest_member_site_id_group_id_normalized_name_idx" ON "guest_member" USING btree ("site_id", "group_id", "normalized_name");--> statement-breakpoint
CREATE INDEX "guest_member_site_id_idx" ON "guest_member" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "guest_member_group_id_idx" ON "guest_member" USING btree ("group_id");--> statement-breakpoint
ALTER TABLE "guest_member" ADD CONSTRAINT "guest_member_site_group_fk" FOREIGN KEY ("site_id", "group_id") REFERENCES "public"."guest_group"("site_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_group" ADD CONSTRAINT "guest_group_representative_member_fk" FOREIGN KEY ("site_id", "id", "representative_member_id") REFERENCES "public"."guest_member"("site_id", "group_id", "id") ON DELETE restrict ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
CREATE TABLE "guest_verification_challenge" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"group_id" text NOT NULL,
	"mode" "guest_verification_mode" DEFAULT 'MOCK' NOT NULL,
	"status" "guest_verification_challenge_status" DEFAULT 'PENDING' NOT NULL,
	"phone_e164" text NOT NULL,
	"code_hash" text,
	"provider_reference" text,
	"expires_at" timestamp with time zone NOT NULL,
	"resend_available_at" timestamp with time zone NOT NULL,
	"wrong_attempts" integer DEFAULT 0 NOT NULL,
	"cooldown_until" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_verification_challenge_phone_e164_check" CHECK ("phone_e164" ~ '^[+]55[1-9]{2}(9[0-9]{8}|[2-5][0-9]{7})$'),
	CONSTRAINT "guest_verification_challenge_wrong_attempts_check" CHECK ("wrong_attempts" BETWEEN 0 AND 5),
	CONSTRAINT "guest_verification_challenge_expiry_check" CHECK ("expires_at" > "created_at"),
	CONSTRAINT "guest_verification_challenge_resend_check" CHECK ("resend_available_at" >= "created_at"),
	CONSTRAINT "guest_verification_challenge_code_hash_check" CHECK ("code_hash" IS NULL OR "code_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "guest_verification_challenge_site_id_id_idx" ON "guest_verification_challenge" USING btree ("site_id", "id");--> statement-breakpoint
CREATE INDEX "guest_verification_challenge_group_status_idx" ON "guest_verification_challenge" USING btree ("group_id", "status");--> statement-breakpoint
CREATE INDEX "guest_verification_challenge_phone_idx" ON "guest_verification_challenge" USING btree ("phone_e164");--> statement-breakpoint
ALTER TABLE "guest_verification_challenge" ADD CONSTRAINT "guest_verification_challenge_site_group_fk" FOREIGN KEY ("site_id", "group_id") REFERENCES "public"."guest_group"("site_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "guest_verification_send" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"group_id" text NOT NULL,
	"challenge_id" text NOT NULL,
	"phone_e164" text NOT NULL,
	"status" "guest_verification_send_status" DEFAULT 'RESERVED' NOT NULL,
	"provider_reference" text,
	"failure_code" text,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_verification_send_phone_e164_check" CHECK ("phone_e164" ~ '^[+]55[1-9]{2}(9[0-9]{8}|[2-5][0-9]{7})$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "guest_verification_send_site_id_id_idx" ON "guest_verification_send" USING btree ("site_id", "id");--> statement-breakpoint
CREATE INDEX "guest_verification_send_challenge_status_idx" ON "guest_verification_send" USING btree ("challenge_id", "status");--> statement-breakpoint
CREATE INDEX "guest_verification_send_site_group_idx" ON "guest_verification_send" USING btree ("site_id", "group_id");--> statement-breakpoint
ALTER TABLE "guest_verification_send" ADD CONSTRAINT "guest_verification_send_site_group_fk" FOREIGN KEY ("site_id", "group_id") REFERENCES "public"."guest_group"("site_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_verification_send" ADD CONSTRAINT "guest_verification_send_challenge_fk" FOREIGN KEY ("site_id", "challenge_id") REFERENCES "public"."guest_verification_challenge"("site_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "guest_rate_limit_event" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text,
	"group_id" text,
	"action" "guest_rate_limit_action" NOT NULL,
	"scope_key" text NOT NULL,
	"ip_fingerprint" text NOT NULL,
	"phone_fingerprint" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_rate_limit_event_scope_pair_check" CHECK (("site_id" IS NULL) = ("group_id" IS NULL)),
	CONSTRAINT "guest_rate_limit_event_scope_key_not_blank_check" CHECK (length(trim("scope_key")) > 0),
	CONSTRAINT "guest_rate_limit_event_ip_fingerprint_check" CHECK ("ip_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "guest_rate_limit_event_phone_fingerprint_check" CHECK ("phone_fingerprint" IS NULL OR "phone_fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE INDEX "guest_rate_limit_event_action_scope_time_idx" ON "guest_rate_limit_event" USING btree ("action", "scope_key", "occurred_at");--> statement-breakpoint
CREATE INDEX "guest_rate_limit_event_site_group_time_idx" ON "guest_rate_limit_event" USING btree ("site_id", "group_id", "occurred_at");--> statement-breakpoint
ALTER TABLE "guest_rate_limit_event" ADD CONSTRAINT "guest_rate_limit_event_site_group_fk" FOREIGN KEY ("site_id", "group_id") REFERENCES "public"."guest_group"("site_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "family_session" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"group_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "family_session_expiry_check" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '7 days'),
	CONSTRAINT "family_session_token_hash_format_check" CHECK ("token_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "family_session_token_hash_idx" ON "family_session" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "family_session_site_group_idx" ON "family_session" USING btree ("site_id", "group_id");--> statement-breakpoint
CREATE INDEX "family_session_active_expiry_idx" ON "family_session" USING btree ("group_id", "expires_at");--> statement-breakpoint
ALTER TABLE "family_session" ADD CONSTRAINT "family_session_site_group_fk" FOREIGN KEY ("site_id", "group_id") REFERENCES "public"."guest_group"("site_id", "id") ON DELETE cascade ON UPDATE no action;
