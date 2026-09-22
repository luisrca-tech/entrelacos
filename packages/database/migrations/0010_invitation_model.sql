-- This refactor intentionally does not infer guest types or recover phone numbers.
-- Hold these locks through Drizzle's migration transaction so writes cannot race
-- the data preflight and silently enter the renamed schema.
LOCK TABLE "guest_group", "guest_member", "guest_verification_challenge",
	"guest_rate_limit_event", "family_session", "family_message",
	"message_request_receipt", "rsvp_history", "rsvp_request_receipt",
	"rsvp_request_receipt_group" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
-- Stop before any DDL if any legacy invitation-domain records still exist.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "guest_group" LIMIT 1) THEN
		RAISE EXCEPTION 'Invitation migration stopped: guest_group contains records that require an explicit, reviewed conversion';
	END IF;
	IF EXISTS (SELECT 1 FROM "guest_member" LIMIT 1) THEN
		RAISE EXCEPTION 'Invitation migration stopped: guest_member contains records that require explicit ADULT/CHILD classification';
	END IF;
	IF EXISTS (SELECT 1 FROM "guest_verification_challenge" LIMIT 1) THEN
		RAISE EXCEPTION 'Invitation migration stopped: guest verification challenges are still operational';
	END IF;
	IF EXISTS (SELECT 1 FROM "guest_rate_limit_event" LIMIT 1) THEN
		RAISE EXCEPTION 'Invitation migration stopped: guest rate-limit events require retention review';
	END IF;
	IF EXISTS (SELECT 1 FROM "family_session" LIMIT 1) THEN
		RAISE EXCEPTION 'Invitation migration stopped: family sessions are still operational';
	END IF;
	IF EXISTS (SELECT 1 FROM "family_message" LIMIT 1) THEN
		RAISE EXCEPTION 'Invitation migration stopped: family messages require retention review';
	END IF;
	IF EXISTS (SELECT 1 FROM "message_request_receipt" LIMIT 1) THEN
		RAISE EXCEPTION 'Invitation migration stopped: message request receipts require retention review';
	END IF;
	IF EXISTS (SELECT 1 FROM "rsvp_history" LIMIT 1) THEN
		RAISE EXCEPTION 'Invitation migration stopped: RSVP history requires an explicit conversion';
	END IF;
	IF EXISTS (SELECT 1 FROM "rsvp_request_receipt" LIMIT 1) THEN
		RAISE EXCEPTION 'Invitation migration stopped: RSVP request receipts require retention review';
	END IF;
	IF EXISTS (SELECT 1 FROM "rsvp_request_receipt_group" LIMIT 1) THEN
		RAISE EXCEPTION 'Invitation migration stopped: RSVP receipt associations require an explicit conversion';
	END IF;
END $$;
--> statement-breakpoint
CREATE TYPE "public"."invitation_guest_type" AS ENUM('ADULT', 'CHILD');
--> statement-breakpoint
ALTER TYPE "public"."guest_verification_challenge_status" RENAME TO "invitation_access_challenge_status";
--> statement-breakpoint
ALTER TYPE "public"."guest_rate_limit_action" RENAME TO "invitation_rate_limit_action";
--> statement-breakpoint
ALTER TYPE "public"."rsvp_actor_type" RENAME VALUE 'FAMILY' TO 'INVITATION';
--> statement-breakpoint
ALTER TABLE "guest_group" RENAME TO "invitation";
--> statement-breakpoint
ALTER TABLE "invitation" ADD COLUMN "email" text;
--> statement-breakpoint
ALTER TABLE "invitation" ALTER COLUMN "phone_e164" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "invitation" DROP CONSTRAINT "guest_group_foreign_phone_check";
--> statement-breakpoint
ALTER TABLE "invitation" DROP CONSTRAINT "guest_group_phone_e164_check";
--> statement-breakpoint
ALTER TABLE "invitation" DROP COLUMN "is_individual";
--> statement-breakpoint
ALTER TABLE "invitation" DROP COLUMN "is_foreign";
--> statement-breakpoint
ALTER TABLE "invitation" DROP COLUMN "representative_member_id";
--> statement-breakpoint
ALTER TABLE "invitation" RENAME CONSTRAINT "guest_group_site_id_site_id_fk" TO "invitation_site_id_site_id_fk";
--> statement-breakpoint
ALTER TABLE "invitation" RENAME CONSTRAINT "guest_group_name_not_blank_check" TO "invitation_name_not_blank_check";
--> statement-breakpoint
ALTER TABLE "invitation" RENAME CONSTRAINT "guest_group_normalized_name_not_blank_check" TO "invitation_normalized_name_not_blank_check";
--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_phone_e164_check" CHECK ("phone_e164" ~ '^[+][1-9][0-9]{1,14}$');
--> statement-breakpoint
ALTER TABLE "invitation" RENAME CONSTRAINT "guest_group_manual_pin_seed_check" TO "invitation_manual_pin_seed_check";
--> statement-breakpoint
ALTER TABLE "invitation" RENAME CONSTRAINT "guest_group_message_revision_check" TO "invitation_message_revision_check";
--> statement-breakpoint
ALTER INDEX "guest_group_site_id_id_idx" RENAME TO "invitation_site_id_id_idx";
--> statement-breakpoint
ALTER INDEX "guest_group_site_id_idx" RENAME TO "invitation_site_id_idx";
--> statement-breakpoint
DROP INDEX "guest_group_site_id_phone_e164_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_site_id_phone_e164_idx" ON "invitation" USING btree ("site_id", "phone_e164");
--> statement-breakpoint
ALTER TABLE "guest_member" RENAME TO "invitation_guest";
--> statement-breakpoint
ALTER TABLE "invitation_guest" RENAME COLUMN "group_id" TO "invitation_id";
--> statement-breakpoint
ALTER TABLE "invitation_guest" ADD COLUMN "guest_type" "invitation_guest_type" NOT NULL;
--> statement-breakpoint
ALTER TABLE "invitation_guest" RENAME CONSTRAINT "guest_member_site_group_fk" TO "invitation_guest_site_invitation_fk";
--> statement-breakpoint
ALTER TABLE "invitation_guest" RENAME CONSTRAINT "guest_member_normalized_name_not_blank_check" TO "invitation_guest_normalized_name_not_blank_check";
--> statement-breakpoint
ALTER TABLE "invitation_guest" RENAME CONSTRAINT "guest_member_rsvp_revision_check" TO "invitation_guest_rsvp_revision_check";
--> statement-breakpoint
ALTER INDEX "guest_member_site_id_group_id_id_idx" RENAME TO "invitation_guest_site_id_invitation_id_id_idx";
--> statement-breakpoint
ALTER INDEX "guest_member_site_id_idx" RENAME TO "invitation_guest_site_id_idx";
--> statement-breakpoint
ALTER INDEX "guest_member_group_id_idx" RENAME TO "invitation_guest_invitation_id_idx";
--> statement-breakpoint
ALTER TABLE "guest_verification_challenge" RENAME TO "invitation_access_challenge";
--> statement-breakpoint
ALTER TABLE "invitation_access_challenge" RENAME COLUMN "group_id" TO "invitation_id";
--> statement-breakpoint
ALTER TABLE "invitation_access_challenge" RENAME CONSTRAINT "guest_verification_challenge_site_group_fk" TO "invitation_access_challenge_site_invitation_fk";
--> statement-breakpoint
ALTER TABLE "invitation_access_challenge" DROP CONSTRAINT "guest_verification_challenge_phone_e164_check";
--> statement-breakpoint
ALTER TABLE "invitation_access_challenge" ADD CONSTRAINT "invitation_access_challenge_phone_e164_check" CHECK ("phone_e164" ~ '^[+][1-9][0-9]{1,14}$');
--> statement-breakpoint
ALTER TABLE "invitation_access_challenge" RENAME CONSTRAINT "guest_verification_challenge_wrong_attempts_check" TO "invitation_access_challenge_wrong_attempts_check";
--> statement-breakpoint
ALTER TABLE "invitation_access_challenge" RENAME CONSTRAINT "guest_verification_challenge_expiry_check" TO "invitation_access_challenge_expiry_check";
--> statement-breakpoint
ALTER INDEX "guest_verification_challenge_site_id_id_idx" RENAME TO "invitation_access_challenge_site_id_id_idx";
--> statement-breakpoint
ALTER INDEX "guest_verification_challenge_group_status_idx" RENAME TO "invitation_access_challenge_invitation_status_idx";
--> statement-breakpoint
ALTER INDEX "guest_verification_challenge_phone_idx" RENAME TO "invitation_access_challenge_phone_idx";
--> statement-breakpoint
ALTER TABLE "guest_rate_limit_event" RENAME TO "invitation_rate_limit_event";
--> statement-breakpoint
ALTER TABLE "invitation_rate_limit_event" RENAME COLUMN "group_id" TO "invitation_id";
--> statement-breakpoint
ALTER TABLE "invitation_rate_limit_event" RENAME CONSTRAINT "guest_rate_limit_event_site_group_fk" TO "invitation_rate_limit_event_site_invitation_fk";
--> statement-breakpoint
ALTER TABLE "invitation_rate_limit_event" RENAME CONSTRAINT "guest_rate_limit_event_scope_pair_check" TO "invitation_rate_limit_event_scope_pair_check";
--> statement-breakpoint
ALTER INDEX "guest_rate_limit_event_action_scope_time_idx" RENAME TO "invitation_rate_limit_event_action_scope_time_idx";
--> statement-breakpoint
ALTER INDEX "guest_rate_limit_event_site_group_time_idx" RENAME TO "invitation_rate_limit_event_site_invitation_time_idx";
--> statement-breakpoint
CREATE INDEX "invitation_rate_limit_event_occurred_at_idx" ON "invitation_rate_limit_event" USING btree ("occurred_at");
--> statement-breakpoint
ALTER TABLE "family_session" RENAME TO "invitation_session";
--> statement-breakpoint
ALTER TABLE "invitation_session" RENAME COLUMN "group_id" TO "invitation_id";
--> statement-breakpoint
ALTER TABLE "invitation_session" RENAME CONSTRAINT "family_session_site_group_fk" TO "invitation_session_site_invitation_fk";
--> statement-breakpoint
ALTER TABLE "invitation_session" RENAME CONSTRAINT "family_session_expiry_check" TO "invitation_session_expiry_check";
--> statement-breakpoint
ALTER TABLE "invitation_session" RENAME CONSTRAINT "family_session_token_hash_format_check" TO "invitation_session_token_hash_format_check";
--> statement-breakpoint
ALTER INDEX "family_session_token_hash_idx" RENAME TO "invitation_session_token_hash_idx";
--> statement-breakpoint
ALTER INDEX "family_session_site_group_idx" RENAME TO "invitation_session_site_invitation_idx";
--> statement-breakpoint
ALTER INDEX "family_session_active_expiry_idx" RENAME TO "invitation_session_active_expiry_idx";
--> statement-breakpoint
ALTER TABLE "family_message" RENAME TO "invitation_message";
--> statement-breakpoint
ALTER TABLE "invitation_message" RENAME COLUMN "group_id" TO "invitation_id";
--> statement-breakpoint
ALTER TABLE "invitation_message" DROP COLUMN "author_member_id";
--> statement-breakpoint
ALTER TABLE "invitation_message" RENAME COLUMN "group_name" TO "invitation_name";
--> statement-breakpoint
ALTER TABLE "invitation_message" RENAME CONSTRAINT "family_message_site_group_fk" TO "invitation_message_site_invitation_fk";
--> statement-breakpoint
ALTER TABLE "invitation_message" RENAME CONSTRAINT "family_message_revision_check" TO "invitation_message_revision_check";
--> statement-breakpoint
ALTER TABLE "invitation_message" RENAME CONSTRAINT "family_message_author_name_not_blank_check" TO "invitation_message_author_name_not_blank_check";
--> statement-breakpoint
ALTER TABLE "invitation_message" RENAME CONSTRAINT "family_message_group_name_not_blank_check" TO "invitation_message_invitation_name_not_blank_check";
--> statement-breakpoint
ALTER TABLE "invitation_message" RENAME CONSTRAINT "family_message_text_not_blank_check" TO "invitation_message_text_not_blank_check";
--> statement-breakpoint
ALTER TABLE "invitation_message" RENAME CONSTRAINT "family_message_text_length_check" TO "invitation_message_text_length_check";
--> statement-breakpoint
ALTER TABLE "invitation_message" RENAME CONSTRAINT "family_message_text_no_angle_brackets_check" TO "invitation_message_text_no_angle_brackets_check";
--> statement-breakpoint
ALTER TABLE "invitation_message" RENAME CONSTRAINT "family_message_text_control_chars_check" TO "invitation_message_text_control_chars_check";
--> statement-breakpoint
ALTER INDEX "family_message_site_group_idx" RENAME TO "invitation_message_site_invitation_idx";
--> statement-breakpoint
ALTER INDEX "family_message_mural_order_idx" RENAME TO "invitation_message_mural_order_idx";
--> statement-breakpoint
ALTER TABLE "message_request_receipt" RENAME COLUMN "group_id" TO "invitation_id";
--> statement-breakpoint
ALTER INDEX "message_request_receipt_site_group_session_request_idx" RENAME TO "message_request_receipt_site_invitation_session_request_idx";
--> statement-breakpoint
ALTER INDEX "message_request_receipt_site_group_created_idx" RENAME TO "message_request_receipt_site_invitation_created_idx";
--> statement-breakpoint
ALTER TABLE "rsvp_history" RENAME COLUMN "group_id" TO "invitation_id";
--> statement-breakpoint
ALTER TABLE "rsvp_history" RENAME COLUMN "member_id" TO "guest_id";
--> statement-breakpoint
ALTER TABLE "rsvp_history" RENAME COLUMN "group_name" TO "invitation_name";
--> statement-breakpoint
ALTER TABLE "rsvp_history" RENAME COLUMN "member_display_name" TO "guest_display_name";
--> statement-breakpoint
ALTER TABLE "rsvp_history" RENAME CONSTRAINT "rsvp_history_site_group_fk" TO "rsvp_history_site_invitation_fk";
--> statement-breakpoint
ALTER TABLE "rsvp_history" RENAME CONSTRAINT "rsvp_history_site_group_member_fk" TO "rsvp_history_site_invitation_guest_fk";
--> statement-breakpoint
ALTER INDEX "rsvp_history_site_group_idx" RENAME TO "rsvp_history_site_invitation_idx";
--> statement-breakpoint
ALTER INDEX "rsvp_history_site_member_idx" RENAME TO "rsvp_history_site_guest_idx";
--> statement-breakpoint
ALTER TABLE "rsvp_request_receipt" RENAME COLUMN "group_id" TO "invitation_id";
--> statement-breakpoint
ALTER TABLE "rsvp_request_receipt" RENAME CONSTRAINT "rsvp_request_receipt_site_group_fk" TO "rsvp_request_receipt_site_invitation_fk";
--> statement-breakpoint
ALTER TABLE "rsvp_request_receipt" RENAME CONSTRAINT "rsvp_request_receipt_group_scope_check" TO "rsvp_request_receipt_invitation_scope_check";
--> statement-breakpoint
ALTER TABLE "rsvp_request_receipt_group" RENAME TO "rsvp_request_receipt_invitation";
--> statement-breakpoint
ALTER TABLE "rsvp_request_receipt_invitation" RENAME COLUMN "group_id" TO "invitation_id";
--> statement-breakpoint
ALTER TABLE "rsvp_request_receipt_invitation" RENAME CONSTRAINT "rsvp_request_receipt_group_receipt_fk" TO "rsvp_request_receipt_invitation_receipt_fk";
--> statement-breakpoint
ALTER TABLE "rsvp_request_receipt_invitation" RENAME CONSTRAINT "rsvp_request_receipt_group_site_group_fk" TO "rsvp_request_receipt_invitation_site_invitation_fk";
--> statement-breakpoint
ALTER TABLE "rsvp_request_receipt_invitation" RENAME CONSTRAINT "rsvp_request_receipt_group_pk" TO "rsvp_request_receipt_invitation_pk";
--> statement-breakpoint
ALTER INDEX "rsvp_request_receipt_group_lookup_idx" RENAME TO "rsvp_request_receipt_invitation_lookup_idx";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "lock_invitation_guest_parent"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		PERFORM 1 FROM "invitation" WHERE "site_id" = NEW."site_id" AND "id" = NEW."invitation_id" FOR UPDATE;
		RETURN NEW;
	END IF;
	IF TG_OP = 'DELETE' THEN
		PERFORM 1 FROM "invitation" WHERE "site_id" = OLD."site_id" AND "id" = OLD."invitation_id" FOR UPDATE;
		RETURN OLD;
	END IF;
	IF ROW(OLD."site_id", OLD."invitation_id") <= ROW(NEW."site_id", NEW."invitation_id") THEN
		PERFORM 1 FROM "invitation" WHERE "site_id" = OLD."site_id" AND "id" = OLD."invitation_id" FOR UPDATE;
		PERFORM 1 FROM "invitation" WHERE "site_id" = NEW."site_id" AND "id" = NEW."invitation_id" FOR UPDATE;
	ELSE
		PERFORM 1 FROM "invitation" WHERE "site_id" = NEW."site_id" AND "id" = NEW."invitation_id" FOR UPDATE;
		PERFORM 1 FROM "invitation" WHERE "site_id" = OLD."site_id" AND "id" = OLD."invitation_id" FOR UPDATE;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "invitation_guest_parent_lock" BEFORE INSERT OR UPDATE OR DELETE ON "invitation_guest" FOR EACH ROW EXECUTE FUNCTION "lock_invitation_guest_parent"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_invitation_has_guest"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RETURN NULL;
	END IF;
	IF EXISTS (SELECT 1 FROM "invitation" WHERE "site_id" = NEW."site_id" AND "id" = NEW."id")
		AND NOT EXISTS (SELECT 1 FROM "invitation_guest" WHERE "site_id" = NEW."site_id" AND "invitation_id" = NEW."id") THEN
		RAISE EXCEPTION 'An invitation must have at least one guest' USING ERRCODE = '23514';
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "invitation_requires_guest" AFTER INSERT OR UPDATE OR DELETE ON "invitation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "enforce_invitation_has_guest"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_invitation_guest_requires_parent"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	checked_site_id text;
	checked_invitation_id text;
BEGIN
	IF TG_OP <> 'INSERT' THEN
		checked_site_id := OLD."site_id";
		checked_invitation_id := OLD."invitation_id";
		IF EXISTS (SELECT 1 FROM "invitation" WHERE "site_id" = checked_site_id AND "id" = checked_invitation_id)
			AND NOT EXISTS (SELECT 1 FROM "invitation_guest" WHERE "site_id" = checked_site_id AND "invitation_id" = checked_invitation_id) THEN
			RAISE EXCEPTION 'An invitation must have at least one guest' USING ERRCODE = '23514';
		END IF;
	END IF;
	IF TG_OP <> 'DELETE' THEN
		checked_site_id := NEW."site_id";
		checked_invitation_id := NEW."invitation_id";
		IF EXISTS (SELECT 1 FROM "invitation" WHERE "site_id" = checked_site_id AND "id" = checked_invitation_id)
			AND NOT EXISTS (SELECT 1 FROM "invitation_guest" WHERE "site_id" = checked_site_id AND "invitation_id" = checked_invitation_id) THEN
			RAISE EXCEPTION 'An invitation must have at least one guest' USING ERRCODE = '23514';
		END IF;
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "invitation_guest_requires_parent" AFTER INSERT OR UPDATE OR DELETE ON "invitation_guest" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "enforce_invitation_guest_requires_parent"();
