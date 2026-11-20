ALTER TABLE "financial_operator_alert" DROP CONSTRAINT "financial_operator_alert_kind_check";--> statement-breakpoint
ALTER TABLE "financial_operator_alert" ADD CONSTRAINT "financial_operator_alert_kind_check" CHECK ("financial_operator_alert"."kind" IN ('SPLIT_DIVERGENCE_BLOCK','SPLIT_CANCELLED','ANTICIPATION_DENIED','PAYMENT_RESTRICTION','UNROUTABLE_PLATFORM_EVENT','SPLIT_SETUP_FAILED','GIFT_REFUNDED','GIFT_CHARGEBACK','ORDER_MISMATCH','WITHDRAWAL_UNRESOLVED'));--> statement-breakpoint
-- Restores the Asaas-era objects on databases that applied an earlier draft
-- of 0031 which dropped them (local development only). Every statement is a
-- no-op where 0031 kept them, as in production. The checks are restored
-- NOT VALID so rows a draft left unchecked do not block the migration; new
-- writes are still checked.
ALTER TABLE "receiving_account" ADD COLUMN IF NOT EXISTS "credential_version" integer;--> statement-breakpoint
ALTER TABLE "receiving_account" ADD COLUMN IF NOT EXISTS "credential_key_id" text;--> statement-breakpoint
ALTER TABLE "receiving_account" ADD COLUMN IF NOT EXISTS "credential_nonce" text;--> statement-breakpoint
ALTER TABLE "receiving_account" ADD COLUMN IF NOT EXISTS "credential_ciphertext" text;--> statement-breakpoint
ALTER TABLE "receiving_account" ADD COLUMN IF NOT EXISTS "credential_tag" text;--> statement-breakpoint
ALTER TABLE "receiving_account" ADD COLUMN IF NOT EXISTS "webhook_token_hash" text;--> statement-breakpoint
ALTER TABLE "receiving_account" ADD COLUMN IF NOT EXISTS "webhook_registration" jsonb;--> statement-breakpoint
ALTER TABLE "receiving_setup_holder" ADD COLUMN IF NOT EXISTS "pix_preparation_consent" jsonb;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receiving_account_webhook_hash_key') THEN
    ALTER TABLE "receiving_account" ADD CONSTRAINT "receiving_account_webhook_hash_key" UNIQUE("webhook_token_hash");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receiving_account_credentials_check') THEN
    ALTER TABLE "receiving_account" ADD CONSTRAINT "receiving_account_credentials_check" CHECK (num_nonnulls("receiving_account"."credential_version", "receiving_account"."credential_key_id", "receiving_account"."credential_nonce", "receiving_account"."credential_ciphertext", "receiving_account"."credential_tag") = 0 OR (num_nonnulls("receiving_account"."credential_version", "receiving_account"."credential_key_id", "receiving_account"."credential_nonce", "receiving_account"."credential_ciphertext", "receiving_account"."credential_tag") = 5 AND "receiving_account"."credential_version" = 1 AND length(trim("receiving_account"."credential_key_id")) > 0 AND length("receiving_account"."credential_nonce") > 0 AND length("receiving_account"."credential_ciphertext") > 0 AND length("receiving_account"."credential_tag") > 0)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receiving_account_webhook_hash_check') THEN
    ALTER TABLE "receiving_account" ADD CONSTRAINT "receiving_account_webhook_hash_check" CHECK ("receiving_account"."webhook_token_hash" IS NULL OR "receiving_account"."webhook_token_hash" ~ '^[a-f0-9]{64}$') NOT VALID;
  END IF;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "withdrawal_authorization_candidate" (
	"environment" "financial_environment" NOT NULL,
	"provider_reference" text NOT NULL,
	"site_id" text NOT NULL,
	"account_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withdrawal_authorization_candidate_environment_provider_reference_pk" PRIMARY KEY("environment","provider_reference"),
	CONSTRAINT "withdrawal_authorization_operation_unique" UNIQUE("environment","operation_id"),
	CONSTRAINT "withdrawal_authorization_candidate_environment_check" CHECK ("withdrawal_authorization_candidate"."environment" IN ('sandbox', 'live')),
	CONSTRAINT "withdrawal_authorization_candidate_hash_check" CHECK ("withdrawal_authorization_candidate"."payload_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "withdrawal_authorization_candidate_provider_check" CHECK ("withdrawal_authorization_candidate"."provider_reference" ~ '^[A-Za-z0-9_-]{1,128}$'),
	CONSTRAINT "withdrawal_authorization_candidate_payload_check" CHECK (jsonb_typeof("withdrawal_authorization_candidate"."payload") = 'object' AND octet_length("withdrawal_authorization_candidate"."payload"::text) <= 32768),
	CONSTRAINT "withdrawal_authorization_operation_fk" FOREIGN KEY ("site_id","account_id","environment","operation_id") REFERENCES "public"."financial_operation"("site_id","account_id","environment","id") ON DELETE restrict ON UPDATE restrict
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "withdrawal_authorization_decision" (
	"environment" "financial_environment" NOT NULL,
	"provider_reference" text NOT NULL,
	"payload_hash" text NOT NULL,
	"status" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withdrawal_authorization_decision_environment_provider_reference_pk" PRIMARY KEY("environment","provider_reference"),
	CONSTRAINT "withdrawal_authorization_decision_hash_check" CHECK ("withdrawal_authorization_decision"."payload_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "withdrawal_authorization_decision_status_check" CHECK ("withdrawal_authorization_decision"."status" = 'APPROVED'),
	CONSTRAINT "withdrawal_authorization_candidate_fk" FOREIGN KEY ("environment","provider_reference") REFERENCES "public"."withdrawal_authorization_candidate"("environment","provider_reference") ON DELETE restrict ON UPDATE restrict
);--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_withdrawal_authorization_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Withdrawal authorization custody is immutable';
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS withdrawal_authorization_candidate_immutable ON withdrawal_authorization_candidate;--> statement-breakpoint
CREATE TRIGGER withdrawal_authorization_candidate_immutable
BEFORE UPDATE OR DELETE ON withdrawal_authorization_candidate
FOR EACH ROW EXECUTE FUNCTION reject_withdrawal_authorization_mutation();--> statement-breakpoint
DROP TRIGGER IF EXISTS withdrawal_authorization_decision_immutable ON withdrawal_authorization_decision;--> statement-breakpoint
CREATE TRIGGER withdrawal_authorization_decision_immutable
BEFORE UPDATE OR DELETE ON withdrawal_authorization_decision
FOR EACH ROW EXECUTE FUNCTION reject_withdrawal_authorization_mutation();--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "receiving_pix_preparation" (
	"account_id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"environment" "financial_environment" NOT NULL,
	"attempt_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"consent_id" text NOT NULL,
	"state" text NOT NULL,
	"attempts" integer NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "receiving_pix_preparation_attempt_id_unique" UNIQUE("attempt_id"),
	CONSTRAINT "receiving_pix_preparation_state_check" CHECK ("receiving_pix_preparation"."state" IN ('ARMED','SUBMITTED','REJECTED','UNKNOWN')),
	CONSTRAINT "receiving_pix_preparation_attempt_check" CHECK ("receiving_pix_preparation"."attempts" > 0 AND "receiving_pix_preparation"."updated_at" >= "receiving_pix_preparation"."attempted_at"),
	CONSTRAINT "receiving_pix_preparation_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "receiving_pix_preparation_account_fk" FOREIGN KEY ("site_id","account_id","environment") REFERENCES "public"."receiving_account"("site_id","id","environment") ON DELETE restrict ON UPDATE restrict
);
