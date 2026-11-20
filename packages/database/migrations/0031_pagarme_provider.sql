-- Asaas-era data is kept: sub-account credentials, webhook state, withdrawal
-- authorization custody and Pix preparation rows stay in place (no DROP of
-- tables or columns). Only constraints that would bind new rows to the
-- previous provider are replaced.
ALTER TABLE "receiving_setup_holder" DROP CONSTRAINT "receiving_setup_holder_pix_consent_check";--> statement-breakpoint
ALTER TABLE "withdrawal_provider_observation" DROP CONSTRAINT "withdrawal_observation_hash_check";--> statement-breakpoint
-- Earlier observations keep their identifiers; NOT VALID checks only new rows.
ALTER TABLE "withdrawal_provider_observation" ADD CONSTRAINT "withdrawal_observation_hash_check" CHECK ("withdrawal_provider_observation"."payload_hash" ~ '^[a-f0-9]{64}$' AND "withdrawal_provider_observation"."id" = 'pagarme-withdrawal:' || "withdrawal_provider_observation"."payload_hash") NOT VALID;
