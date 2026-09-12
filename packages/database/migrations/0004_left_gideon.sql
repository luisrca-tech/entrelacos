CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
ALTER TYPE "public"."guest_verification_mode" ADD VALUE 'MANUAL' BEFORE 'MOCK';--> statement-breakpoint
ALTER TYPE "public"."guest_verification_send_status" ADD VALUE 'MANUAL' BEFORE 'RESERVED';--> statement-breakpoint
ALTER TABLE "guest_group" ADD COLUMN "manual_pin_seed" text DEFAULT encode(gen_random_bytes(32), 'hex') NOT NULL;--> statement-breakpoint
ALTER TABLE "guest_group" ADD CONSTRAINT "guest_group_manual_pin_seed_check" CHECK ("guest_group"."manual_pin_seed" ~ '^[a-f0-9]{64}$');
