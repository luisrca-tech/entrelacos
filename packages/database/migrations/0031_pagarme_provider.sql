DROP TABLE "receiving_pix_preparation";--> statement-breakpoint
DROP TABLE "withdrawal_authorization_decision";--> statement-breakpoint
DROP TABLE "withdrawal_authorization_candidate";--> statement-breakpoint
DROP FUNCTION "reject_withdrawal_authorization_mutation"();--> statement-breakpoint
ALTER TABLE "receiving_account" DROP CONSTRAINT "receiving_account_webhook_hash_key";--> statement-breakpoint
ALTER TABLE "receiving_setup_holder" DROP CONSTRAINT "receiving_setup_holder_pix_consent_check";--> statement-breakpoint
ALTER TABLE "receiving_account" DROP CONSTRAINT "receiving_account_credentials_check";--> statement-breakpoint
ALTER TABLE "receiving_account" DROP CONSTRAINT "receiving_account_webhook_hash_check";--> statement-breakpoint
ALTER TABLE "withdrawal_provider_observation" DROP CONSTRAINT "withdrawal_observation_hash_check";--> statement-breakpoint
ALTER TABLE "receiving_setup_holder" DROP COLUMN "pix_preparation_consent";--> statement-breakpoint
ALTER TABLE "receiving_account" DROP COLUMN "credential_version";--> statement-breakpoint
ALTER TABLE "receiving_account" DROP COLUMN "credential_key_id";--> statement-breakpoint
ALTER TABLE "receiving_account" DROP COLUMN "credential_nonce";--> statement-breakpoint
ALTER TABLE "receiving_account" DROP COLUMN "credential_ciphertext";--> statement-breakpoint
ALTER TABLE "receiving_account" DROP COLUMN "credential_tag";--> statement-breakpoint
ALTER TABLE "receiving_account" DROP COLUMN "webhook_token_hash";--> statement-breakpoint
ALTER TABLE "receiving_account" DROP COLUMN "webhook_registration";--> statement-breakpoint
-- Earlier observations keep their identifiers; NOT VALID checks only new rows.
ALTER TABLE "withdrawal_provider_observation" ADD CONSTRAINT "withdrawal_observation_hash_check" CHECK ("withdrawal_provider_observation"."payload_hash" ~ '^[a-f0-9]{64}$' AND "withdrawal_provider_observation"."id" = 'pagarme-withdrawal:' || "withdrawal_provider_observation"."payload_hash") NOT VALID;
