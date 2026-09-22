ALTER TABLE "guest_verification_send" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sms_send_reservation" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sms_usage" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "guest_verification_send" CASCADE;--> statement-breakpoint
DROP TABLE "sms_send_reservation" CASCADE;--> statement-breakpoint
DROP TABLE "sms_usage" CASCADE;--> statement-breakpoint
ALTER TABLE "guest_verification_challenge" DROP CONSTRAINT "guest_verification_challenge_resend_check";--> statement-breakpoint
ALTER TABLE "guest_verification_challenge" DROP CONSTRAINT "guest_verification_challenge_code_hash_check";--> statement-breakpoint
ALTER TABLE "site" DROP CONSTRAINT "site_sms_monthly_limit_check";--> statement-breakpoint
DELETE FROM "guest_rate_limit_event" WHERE "action" = 'OTP_SEND';--> statement-breakpoint
ALTER TABLE "guest_rate_limit_event" ALTER COLUMN "action" SET DATA TYPE text;--> statement-breakpoint
UPDATE "guest_rate_limit_event" SET "action" = 'PIN_VERIFY' WHERE "action" = 'OTP_VERIFY';--> statement-breakpoint
DROP TYPE "public"."guest_rate_limit_action";--> statement-breakpoint
CREATE TYPE "public"."guest_rate_limit_action" AS ENUM('LOOKUP', 'PIN_VERIFY');--> statement-breakpoint
ALTER TABLE "guest_rate_limit_event" ALTER COLUMN "action" SET DATA TYPE "public"."guest_rate_limit_action" USING "action"::"public"."guest_rate_limit_action";--> statement-breakpoint
ALTER TABLE "guest_verification_challenge" DROP COLUMN "mode";--> statement-breakpoint
ALTER TABLE "guest_verification_challenge" DROP COLUMN "code_hash";--> statement-breakpoint
ALTER TABLE "guest_verification_challenge" DROP COLUMN "provider_reference";--> statement-breakpoint
ALTER TABLE "guest_verification_challenge" DROP COLUMN "resend_available_at";--> statement-breakpoint
ALTER TABLE "site" DROP COLUMN "sms_monthly_limit";--> statement-breakpoint
DROP TYPE "public"."guest_verification_mode";--> statement-breakpoint
DROP TYPE "public"."guest_verification_send_status";--> statement-breakpoint
DROP TYPE "public"."sms_reservation_status";--> statement-breakpoint
DROP TYPE "public"."sms_usage_mode";
