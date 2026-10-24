CREATE TABLE "withdrawal_provider_observation" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"account_id" text NOT NULL,
	"environment" "financial_environment" NOT NULL,
	"operation_id" text NOT NULL,
	"provider_reference" text NOT NULL,
	"payload_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withdrawal_observation_hash_check" CHECK ("withdrawal_provider_observation"."payload_hash" ~ '^[a-f0-9]{64}$' AND "withdrawal_provider_observation"."id" = 'asaas-transfer:' || "withdrawal_provider_observation"."payload_hash"),
	CONSTRAINT "withdrawal_observation_payload_check" CHECK (jsonb_typeof("withdrawal_provider_observation"."payload") = 'object' AND octet_length("withdrawal_provider_observation"."payload"::text) <= 32768),
	CONSTRAINT "withdrawal_observation_time_check" CHECK ("withdrawal_provider_observation"."recorded_at" >= "withdrawal_provider_observation"."observed_at"),
	CONSTRAINT "withdrawal_observation_provider_check" CHECK ("withdrawal_provider_observation"."provider_reference" ~ '^[A-Za-z0-9_-]{1,128}$')
);
--> statement-breakpoint
ALTER TABLE "withdrawal_provider_observation" ADD CONSTRAINT "withdrawal_observation_operation_fk" FOREIGN KEY ("site_id","account_id","environment","operation_id") REFERENCES "public"."financial_operation"("site_id","account_id","environment","id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
CREATE FUNCTION reject_withdrawal_provider_observation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Withdrawal provider observations are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER withdrawal_provider_observation_immutable
BEFORE UPDATE OR DELETE ON withdrawal_provider_observation
FOR EACH ROW EXECUTE FUNCTION reject_withdrawal_provider_observation_mutation();
