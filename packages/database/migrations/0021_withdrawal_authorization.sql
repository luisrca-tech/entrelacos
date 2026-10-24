CREATE TABLE "withdrawal_authorization_candidate" (
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
	CONSTRAINT "withdrawal_authorization_candidate_environment_check" CHECK ("withdrawal_authorization_candidate"."environment" = 'sandbox'),
	CONSTRAINT "withdrawal_authorization_candidate_hash_check" CHECK ("withdrawal_authorization_candidate"."payload_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "withdrawal_authorization_candidate_provider_check" CHECK ("withdrawal_authorization_candidate"."provider_reference" ~ '^[A-Za-z0-9_-]{1,128}$'),
	CONSTRAINT "withdrawal_authorization_candidate_payload_check" CHECK (jsonb_typeof("withdrawal_authorization_candidate"."payload") = 'object' AND octet_length("withdrawal_authorization_candidate"."payload"::text) <= 32768)
);
--> statement-breakpoint
CREATE TABLE "withdrawal_authorization_decision" (
	"environment" "financial_environment" NOT NULL,
	"provider_reference" text NOT NULL,
	"payload_hash" text NOT NULL,
	"status" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withdrawal_authorization_decision_environment_provider_reference_pk" PRIMARY KEY("environment","provider_reference"),
	CONSTRAINT "withdrawal_authorization_decision_hash_check" CHECK ("withdrawal_authorization_decision"."payload_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "withdrawal_authorization_decision_status_check" CHECK ("withdrawal_authorization_decision"."status" = 'APPROVED')
);
--> statement-breakpoint
ALTER TABLE "withdrawal_authorization_candidate" ADD CONSTRAINT "withdrawal_authorization_operation_fk" FOREIGN KEY ("site_id","account_id","environment","operation_id") REFERENCES "public"."financial_operation"("site_id","account_id","environment","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "withdrawal_authorization_decision" ADD CONSTRAINT "withdrawal_authorization_candidate_fk" FOREIGN KEY ("environment","provider_reference") REFERENCES "public"."withdrawal_authorization_candidate"("environment","provider_reference") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE FUNCTION reject_withdrawal_authorization_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Withdrawal authorization custody is immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER withdrawal_authorization_candidate_immutable
BEFORE UPDATE OR DELETE ON withdrawal_authorization_candidate
FOR EACH ROW EXECUTE FUNCTION reject_withdrawal_authorization_mutation();
--> statement-breakpoint
CREATE TRIGGER withdrawal_authorization_decision_immutable
BEFORE UPDATE OR DELETE ON withdrawal_authorization_decision
FOR EACH ROW EXECUTE FUNCTION reject_withdrawal_authorization_mutation();
