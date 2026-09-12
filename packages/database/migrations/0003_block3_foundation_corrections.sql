ALTER TABLE "guest_group" DROP CONSTRAINT "guest_group_phone_e164_check";--> statement-breakpoint
ALTER TABLE "guest_rate_limit_event" DROP CONSTRAINT "guest_rate_limit_event_scope_pair_check";--> statement-breakpoint
ALTER TABLE "guest_verification_challenge" DROP CONSTRAINT "guest_verification_challenge_phone_e164_check";--> statement-breakpoint
ALTER TABLE "guest_verification_challenge" DROP CONSTRAINT "guest_verification_challenge_expiry_check";--> statement-breakpoint
ALTER TABLE "guest_verification_send" DROP CONSTRAINT "guest_verification_send_phone_e164_check";--> statement-breakpoint
DROP INDEX "guest_group_site_id_normalized_name_idx";--> statement-breakpoint
DROP INDEX "guest_member_site_id_group_id_normalized_name_idx";--> statement-breakpoint
ALTER TABLE "guest_group" ADD COLUMN "is_foreign" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "guest_group" ADD CONSTRAINT "guest_group_foreign_phone_check" CHECK ("guest_group"."is_foreign" = ("guest_group"."phone_e164" IS NULL));--> statement-breakpoint
ALTER TABLE "guest_group" ADD CONSTRAINT "guest_group_phone_e164_check" CHECK ("guest_group"."phone_e164" IS NULL OR "guest_group"."phone_e164" ~ '^[+]55[1-9]{2}9[0-9]{8}$');--> statement-breakpoint
ALTER TABLE "guest_rate_limit_event" ADD CONSTRAINT "guest_rate_limit_event_scope_pair_check" CHECK ("guest_rate_limit_event"."group_id" IS NULL OR "guest_rate_limit_event"."site_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "guest_verification_challenge" ADD CONSTRAINT "guest_verification_challenge_phone_e164_check" CHECK ("guest_verification_challenge"."phone_e164" ~ '^[+]55[1-9]{2}9[0-9]{8}$');--> statement-breakpoint
ALTER TABLE "guest_verification_challenge" ADD CONSTRAINT "guest_verification_challenge_expiry_check" CHECK ("guest_verification_challenge"."expires_at" > "guest_verification_challenge"."created_at" AND "guest_verification_challenge"."expires_at" <= "guest_verification_challenge"."created_at" + interval '10 minutes');--> statement-breakpoint
ALTER TABLE "guest_verification_send" ADD CONSTRAINT "guest_verification_send_phone_e164_check" CHECK ("guest_verification_send"."phone_e164" ~ '^[+]55[1-9]{2}9[0-9]{8}$');