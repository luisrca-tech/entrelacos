CREATE TYPE "public"."gift_media_publication_intent_state" AS ENUM('REQUESTED', 'PUBLISHED', 'ASSOCIATED', 'UNKNOWN', 'ORPHANED', 'CLEANED');--> statement-breakpoint
CREATE TYPE "public"."financial_environment" AS ENUM('sandbox', 'live');--> statement-breakpoint
CREATE TYPE "public"."financial_evidence_provenance" AS ENUM('PROVIDER', 'SIMULATION');--> statement-breakpoint
CREATE TYPE "public"."financial_inbox_state" AS ENUM('RECEIVED', 'CLAIMED', 'PROCESSED', 'RETRY', 'DEAD_LETTER');--> statement-breakpoint
CREATE TYPE "public"."financial_ledger_direction" AS ENUM('CREDIT', 'DEBIT');--> statement-breakpoint
CREATE TYPE "public"."financial_operation_kind" AS ENUM('ACCOUNT_CREATE', 'CHECKOUT_CREATE', 'WITHDRAWAL', 'REFUND');--> statement-breakpoint
CREATE TYPE "public"."financial_operation_state" AS ENUM('REQUESTED', 'CLAIMED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."financial_verification_status" AS ENUM('UNVERIFIED', 'VERIFIED');--> statement-breakpoint
CREATE TYPE "public"."gift_payment_method" AS ENUM('PIX', 'CREDIT_CARD');--> statement-breakpoint
CREATE TYPE "public"."receiving_bank_state" AS ENUM('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."receiving_provider_account_state" AS ENUM('UNVERIFIED', 'ONBOARDING', 'UNDER_REVIEW', 'APPROVED', 'BLOCKED', 'SUSPENDED');--> statement-breakpoint
CREATE TYPE "public"."withdrawal_intent_state" AS ENUM('REQUESTED', 'AWAITING_AUTHORIZATION', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."withdrawal_reservation_state" AS ENUM('HELD', 'RELEASED', 'CONSUMED');--> statement-breakpoint
ALTER TYPE "public"."gift_media_state" ADD VALUE 'PROCESSING' BEFORE 'FINALIZED';--> statement-breakpoint
CREATE TABLE "gift_media_publication_intent" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"processing_id" text NOT NULL,
	"storage_namespace" text NOT NULL,
	"derivative_key" text NOT NULL,
	"state" "gift_media_publication_intent_state" DEFAULT 'REQUESTED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"observed_at" timestamp with time zone,
	CONSTRAINT "gift_media_publication_claim_key" UNIQUE("site_id","asset_id","processing_id"),
	CONSTRAINT "gift_media_publication_object_key" UNIQUE("storage_namespace","derivative_key"),
	CONSTRAINT "gift_media_publication_claim_check" CHECK (length(trim("gift_media_publication_intent"."processing_id")) BETWEEN 1 AND 128),
	CONSTRAINT "gift_media_publication_namespace_check" CHECK ("gift_media_publication_intent"."storage_namespace" ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'),
	CONSTRAINT "gift_media_publication_key_check" CHECK ("gift_media_publication_intent"."derivative_key" = 'gifts/' || "gift_media_publication_intent"."site_id" || '/' || "gift_media_publication_intent"."asset_id" || '/' || "gift_media_publication_intent"."processing_id" || '.webp' AND length("gift_media_publication_intent"."derivative_key") <= 512 AND "gift_media_publication_intent"."processing_id" ~ '^[A-Za-z0-9_-]+$'),
	CONSTRAINT "gift_media_publication_observation_check" CHECK (("gift_media_publication_intent"."observed_at" IS NULL OR "gift_media_publication_intent"."observed_at" >= "gift_media_publication_intent"."created_at") AND ("gift_media_publication_intent"."state" = 'REQUESTED' OR "gift_media_publication_intent"."observed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "financial_event_inbox" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"account_id" text NOT NULL,
	"environment" "financial_environment" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivery_id" text NOT NULL,
	"provider_event_reference" text,
	"event_type" text NOT NULL,
	"payload_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"authenticated_at" timestamp with time zone NOT NULL,
	"payment_id" text,
	"state" "financial_inbox_state" DEFAULT 'RECEIVED' NOT NULL,
	"lease_owner" text,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_code" text,
	"processed_at" timestamp with time zone,
	CONSTRAINT "financial_event_scope_key" UNIQUE("site_id","account_id","environment","id"),
	CONSTRAINT "financial_event_delivery_key" UNIQUE("site_id","account_id","environment","delivery_id"),
	CONSTRAINT "financial_event_provider_key" UNIQUE("site_id","account_id","environment","provider_event_reference"),
	CONSTRAINT "financial_event_hash_check" CHECK ("financial_event_inbox"."payload_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "financial_event_delivery_check" CHECK (length(trim("financial_event_inbox"."delivery_id")) BETWEEN 1 AND 256),
	CONSTRAINT "financial_event_provider_reference_check" CHECK ("financial_event_inbox"."provider_event_reference" IS NULL OR ("financial_event_inbox"."provider_event_reference" ~ '^[ -~]{1,256}$' AND length(trim("financial_event_inbox"."provider_event_reference")) > 0)),
	CONSTRAINT "financial_event_type_check" CHECK (length(trim("financial_event_inbox"."event_type")) BETWEEN 1 AND 128),
	CONSTRAINT "financial_event_payload_check" CHECK (jsonb_typeof("financial_event_inbox"."payload") = 'object' AND octet_length("financial_event_inbox"."payload"::text) <= 262144),
	CONSTRAINT "financial_event_lease_check" CHECK ((num_nonnulls("financial_event_inbox"."lease_owner", "financial_event_inbox"."lease_token", "financial_event_inbox"."lease_expires_at") = 0 OR (num_nonnulls("financial_event_inbox"."lease_owner", "financial_event_inbox"."lease_token", "financial_event_inbox"."lease_expires_at") = 3 AND length(trim("financial_event_inbox"."lease_owner")) BETWEEN 1 AND 128 AND length(trim("financial_event_inbox"."lease_token")) BETWEEN 1 AND 128)) AND ("financial_event_inbox"."state" <> 'CLAIMED' OR num_nonnulls("financial_event_inbox"."lease_owner", "financial_event_inbox"."lease_token", "financial_event_inbox"."lease_expires_at") = 3)),
	CONSTRAINT "financial_event_attempts_check" CHECK ("financial_event_inbox"."attempts" >= 0),
	CONSTRAINT "financial_event_error_check" CHECK ("financial_event_inbox"."last_error_code" IS NULL OR "financial_event_inbox"."last_error_code" ~ '^[A-Z0-9_]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "financial_ledger_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"account_id" text NOT NULL,
	"environment" "financial_environment" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"effect_key" text NOT NULL,
	"kind" text NOT NULL,
	"direction" "financial_ledger_direction" NOT NULL,
	"currency" text DEFAULT 'BRL' NOT NULL,
	"amount_cents" integer NOT NULL,
	"payment_id" text,
	"withdrawal_intent_id" text,
	"operation_id" text,
	"event_id" text,
	"compensates_entry_id" text,
	CONSTRAINT "financial_ledger_scope_key" UNIQUE("site_id","account_id","environment","id"),
	CONSTRAINT "financial_ledger_effect_key" UNIQUE("site_id","account_id","environment","effect_key"),
	CONSTRAINT "financial_ledger_currency_check" CHECK ("financial_ledger_entry"."currency" = 'BRL'),
	CONSTRAINT "financial_ledger_amount_check" CHECK ("financial_ledger_entry"."amount_cents" BETWEEN 1 AND 2147483647),
	CONSTRAINT "financial_ledger_identity_check" CHECK (length(trim("financial_ledger_entry"."effect_key")) BETWEEN 1 AND 256 AND "financial_ledger_entry"."kind" ~ '^[A-Z0-9_]{1,64}$'),
	CONSTRAINT "financial_ledger_source_check" CHECK ("financial_ledger_entry"."payment_id" IS NOT NULL OR "financial_ledger_entry"."withdrawal_intent_id" IS NOT NULL OR "financial_ledger_entry"."compensates_entry_id" IS NOT NULL),
	CONSTRAINT "financial_ledger_compensation_check" CHECK ("financial_ledger_entry"."compensates_entry_id" IS NULL OR "financial_ledger_entry"."compensates_entry_id" <> "financial_ledger_entry"."id")
);
--> statement-breakpoint
CREATE TABLE "financial_operation" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"account_id" text NOT NULL,
	"environment" "financial_environment" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" "financial_operation_kind" NOT NULL,
	"order_id" text,
	"withdrawal_intent_id" text,
	"payment_id" text,
	"state" "financial_operation_state" DEFAULT 'REQUESTED' NOT NULL,
	"request_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"request_snapshot" jsonb NOT NULL,
	"provider_operation_reference" text,
	"lease_owner" text,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_code" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_operation_scope_key" UNIQUE("site_id","account_id","environment","id"),
	CONSTRAINT "financial_operation_order_key" UNIQUE("site_id","account_id","environment","id","order_id","kind"),
	CONSTRAINT "financial_operation_request_key" UNIQUE("site_id","kind","request_id"),
	CONSTRAINT "financial_operation_provider_key" UNIQUE("site_id","account_id","environment","provider_operation_reference"),
	CONSTRAINT "financial_operation_target_check" CHECK (("financial_operation"."kind" = 'ACCOUNT_CREATE' AND "financial_operation"."order_id" IS NULL AND "financial_operation"."withdrawal_intent_id" IS NULL AND "financial_operation"."payment_id" IS NULL) OR ("financial_operation"."kind" = 'CHECKOUT_CREATE' AND "financial_operation"."order_id" IS NOT NULL AND "financial_operation"."withdrawal_intent_id" IS NULL AND "financial_operation"."payment_id" IS NULL) OR ("financial_operation"."kind" = 'WITHDRAWAL' AND "financial_operation"."order_id" IS NULL AND "financial_operation"."withdrawal_intent_id" IS NOT NULL AND "financial_operation"."payment_id" IS NULL) OR ("financial_operation"."kind" = 'REFUND' AND "financial_operation"."order_id" IS NOT NULL AND "financial_operation"."payment_id" IS NOT NULL AND "financial_operation"."withdrawal_intent_id" IS NULL)),
	CONSTRAINT "financial_operation_request_hash_check" CHECK ("financial_operation"."request_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "financial_operation_request_check" CHECK (length(trim("financial_operation"."request_id")) BETWEEN 1 AND 128 AND jsonb_typeof("financial_operation"."request_snapshot") = 'object'),
	CONSTRAINT "financial_operation_lease_check" CHECK ((num_nonnulls("financial_operation"."lease_owner", "financial_operation"."lease_token", "financial_operation"."lease_expires_at") = 0 OR (num_nonnulls("financial_operation"."lease_owner", "financial_operation"."lease_token", "financial_operation"."lease_expires_at") = 3 AND length(trim("financial_operation"."lease_owner")) BETWEEN 1 AND 128 AND length(trim("financial_operation"."lease_token")) BETWEEN 1 AND 128)) AND ("financial_operation"."state" NOT IN ('CLAIMED', 'PROCESSING') OR num_nonnulls("financial_operation"."lease_owner", "financial_operation"."lease_token", "financial_operation"."lease_expires_at") = 3)),
	CONSTRAINT "financial_operation_attempts_check" CHECK ("financial_operation"."attempts" >= 0),
	CONSTRAINT "financial_operation_error_check" CHECK ("financial_operation"."last_error_code" IS NULL OR "financial_operation"."last_error_code" ~ '^[A-Z0-9_]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "gift_checkout_attempt" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"account_id" text NOT NULL,
	"environment" "financial_environment" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"order_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"operation_kind" "financial_operation_kind" DEFAULT 'CHECKOUT_CREATE' NOT NULL,
	"attempt_number" integer NOT NULL,
	"provider_reference" text,
	"hosted_url" text,
	"expires_at" timestamp with time zone,
	CONSTRAINT "gift_checkout_attempt_scope_key" UNIQUE("site_id","account_id","environment","id"),
	CONSTRAINT "gift_checkout_attempt_order_key" UNIQUE("site_id","account_id","environment","id","order_id"),
	CONSTRAINT "gift_checkout_attempt_number_key" UNIQUE("site_id","account_id","environment","order_id","attempt_number"),
	CONSTRAINT "gift_checkout_attempt_operation_key" UNIQUE("site_id","account_id","environment","operation_id"),
	CONSTRAINT "gift_checkout_attempt_provider_key" UNIQUE("site_id","account_id","environment","provider_reference"),
	CONSTRAINT "gift_checkout_attempt_number_check" CHECK ("gift_checkout_attempt"."attempt_number" > 0),
	CONSTRAINT "gift_checkout_attempt_operation_kind_check" CHECK ("gift_checkout_attempt"."operation_kind" = 'CHECKOUT_CREATE')
);
--> statement-breakpoint
CREATE TABLE "gift_order" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"account_id" text NOT NULL,
	"environment" "financial_environment" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"quote_id" text NOT NULL,
	"request_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"recovery_token_hash" text NOT NULL,
	CONSTRAINT "gift_order_scope_key" UNIQUE("site_id","account_id","environment","id"),
	CONSTRAINT "gift_order_quote_key" UNIQUE("site_id","account_id","environment","quote_id"),
	CONSTRAINT "gift_order_request_key" UNIQUE("site_id","request_id"),
	CONSTRAINT "gift_order_request_hash_check" CHECK ("gift_order"."request_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "gift_order_recovery_hash_check" CHECK ("gift_order"."recovery_token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "gift_order_request_check" CHECK (length(trim("gift_order"."request_id")) BETWEEN 1 AND 128)
);
--> statement-breakpoint
CREATE TABLE "gift_payment_record" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"account_id" text NOT NULL,
	"environment" "financial_environment" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"order_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"provider_payment_reference" text NOT NULL,
	"provider_status" text,
	"verification_status" "financial_verification_status" DEFAULT 'UNVERIFIED' NOT NULL,
	"observed_at" timestamp with time zone,
	"currency" text DEFAULT 'BRL' NOT NULL,
	"gross_cents" integer,
	"processing_cents" integer,
	"commission_cents" integer,
	"recipient_net_cents" integer,
	"split_provider_reference" text,
	"split_fixed_cents" integer,
	CONSTRAINT "gift_payment_scope_key" UNIQUE("site_id","account_id","environment","id"),
	CONSTRAINT "gift_payment_order_key" UNIQUE("site_id","account_id","environment","id","order_id"),
	CONSTRAINT "gift_payment_provider_key" UNIQUE("site_id","account_id","environment","provider_payment_reference"),
	CONSTRAINT "gift_payment_reference_check" CHECK (length(trim("gift_payment_record"."provider_payment_reference")) > 0),
	CONSTRAINT "gift_payment_currency_check" CHECK ("gift_payment_record"."currency" = 'BRL'),
	CONSTRAINT "gift_payment_amounts_check" CHECK (("gift_payment_record"."gross_cents" IS NULL OR "gift_payment_record"."gross_cents" BETWEEN 1 AND 2147483647) AND ("gift_payment_record"."processing_cents" IS NULL OR "gift_payment_record"."processing_cents" BETWEEN 0 AND 2147483647) AND ("gift_payment_record"."commission_cents" IS NULL OR "gift_payment_record"."commission_cents" BETWEEN 0 AND 2147483647) AND ("gift_payment_record"."recipient_net_cents" IS NULL OR "gift_payment_record"."recipient_net_cents" BETWEEN 0 AND 2147483647) AND ("gift_payment_record"."split_fixed_cents" IS NULL OR "gift_payment_record"."split_fixed_cents" BETWEEN 0 AND 2147483647)),
	CONSTRAINT "gift_payment_allocation_check" CHECK (num_nonnulls("gift_payment_record"."processing_cents", "gift_payment_record"."commission_cents", "gift_payment_record"."recipient_net_cents") < 3 OR ("gift_payment_record"."gross_cents" IS NOT NULL AND "gift_payment_record"."gross_cents"::bigint = "gift_payment_record"."processing_cents"::bigint + "gift_payment_record"."commission_cents"::bigint + "gift_payment_record"."recipient_net_cents"::bigint)),
	CONSTRAINT "gift_payment_verified_check" CHECK ("gift_payment_record"."verification_status" <> 'VERIFIED' OR ("gift_payment_record"."observed_at" IS NOT NULL AND "gift_payment_record"."provider_status" IS NOT NULL AND "gift_payment_record"."gross_cents" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "gift_quote_record" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"account_id" text NOT NULL,
	"environment" "financial_environment" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"gift_id" text NOT NULL,
	"destination_version" integer NOT NULL,
	"method" "gift_payment_method" NOT NULL,
	"currency" text DEFAULT 'BRL' NOT NULL,
	"nominal_cents" integer NOT NULL,
	"commission_basis_points" integer DEFAULT 200 NOT NULL,
	"commission_cents" integer NOT NULL,
	"processing_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"policy_version" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gift_quote_scope_key" UNIQUE("site_id","account_id","environment","id"),
	CONSTRAINT "gift_quote_currency_check" CHECK ("gift_quote_record"."currency" = 'BRL'),
	CONSTRAINT "gift_quote_amounts_check" CHECK ("gift_quote_record"."nominal_cents" BETWEEN 1 AND 2147483647 AND "gift_quote_record"."commission_cents" BETWEEN 0 AND 2147483647 AND "gift_quote_record"."processing_cents" BETWEEN 0 AND 2147483647 AND "gift_quote_record"."total_cents" BETWEEN 1 AND 2147483647),
	CONSTRAINT "gift_quote_allocation_check" CHECK ("gift_quote_record"."total_cents"::bigint = "gift_quote_record"."nominal_cents"::bigint + "gift_quote_record"."commission_cents"::bigint + "gift_quote_record"."processing_cents"::bigint),
	CONSTRAINT "gift_quote_commission_check" CHECK ("gift_quote_record"."commission_basis_points" = 200 AND "gift_quote_record"."commission_cents"::bigint = ("gift_quote_record"."nominal_cents"::bigint * 200 + 5000) / 10000),
	CONSTRAINT "gift_quote_expiry_check" CHECK ("gift_quote_record"."expires_at" > "gift_quote_record"."created_at"),
	CONSTRAINT "gift_quote_snapshot_check" CHECK (jsonb_typeof("gift_quote_record"."snapshot") = 'object' AND "gift_quote_record"."snapshot" ?& ARRAY['quote', 'gift', 'receiving', 'pricing', 'createdAt', 'expiresAt']),
	CONSTRAINT "gift_quote_policy_check" CHECK (length(trim("gift_quote_record"."policy_version")) BETWEEN 1 AND 128)
);
--> statement-breakpoint
CREATE TABLE "receiving_account" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"environment" "financial_environment" NOT NULL,
	"provider" text NOT NULL,
	"operator_user_id" text,
	"operator_reference" text,
	"account_reference" text,
	"recipient_reference" text,
	"provider_account_state" "receiving_provider_account_state" DEFAULT 'UNVERIFIED' NOT NULL,
	"receiving_capability" boolean DEFAULT false NOT NULL,
	"withdrawal_capability" boolean DEFAULT false NOT NULL,
	"commercial_enabled" boolean DEFAULT false NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"credential_version" integer,
	"credential_key_id" text,
	"credential_nonce" text,
	"credential_ciphertext" text,
	"credential_tag" text,
	"webhook_token_hash" text,
	"observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receiving_account_scope_key" UNIQUE("site_id","id","environment"),
	CONSTRAINT "receiving_account_provider_key" UNIQUE("provider","environment","account_reference"),
	CONSTRAINT "receiving_account_webhook_hash_key" UNIQUE("webhook_token_hash"),
	CONSTRAINT "receiving_account_provider_check" CHECK (length(trim("receiving_account"."provider")) BETWEEN 1 AND 64),
	CONSTRAINT "receiving_account_references_check" CHECK (("receiving_account"."operator_reference" IS NULL OR length(trim("receiving_account"."operator_reference")) > 0) AND ("receiving_account"."account_reference" IS NULL OR length(trim("receiving_account"."account_reference")) > 0) AND ("receiving_account"."recipient_reference" IS NULL OR length(trim("receiving_account"."recipient_reference")) > 0)),
	CONSTRAINT "receiving_account_credentials_check" CHECK (num_nonnulls("receiving_account"."credential_version", "receiving_account"."credential_key_id", "receiving_account"."credential_nonce", "receiving_account"."credential_ciphertext", "receiving_account"."credential_tag") = 0 OR (num_nonnulls("receiving_account"."credential_version", "receiving_account"."credential_key_id", "receiving_account"."credential_nonce", "receiving_account"."credential_ciphertext", "receiving_account"."credential_tag") = 5 AND "receiving_account"."credential_version" = 1 AND length(trim("receiving_account"."credential_key_id")) > 0 AND length("receiving_account"."credential_nonce") > 0 AND length("receiving_account"."credential_ciphertext") > 0 AND length("receiving_account"."credential_tag") > 0)),
	CONSTRAINT "receiving_account_webhook_hash_check" CHECK ("receiving_account"."webhook_token_hash" IS NULL OR "receiving_account"."webhook_token_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "receiving_destination" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"account_id" text NOT NULL,
	"environment" "financial_environment" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer NOT NULL,
	"bank_reference" text,
	"masked_descriptor" text,
	"bank_state" "receiving_bank_state" DEFAULT 'UNVERIFIED' NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	CONSTRAINT "receiving_destination_scope_key" UNIQUE("site_id","account_id","environment","id"),
	CONSTRAINT "receiving_destination_version_key" UNIQUE("site_id","account_id","environment","version"),
	CONSTRAINT "receiving_destination_version_check" CHECK ("receiving_destination"."version" > 0),
	CONSTRAINT "receiving_destination_reference_check" CHECK ("receiving_destination"."bank_reference" IS NULL OR length(trim("receiving_destination"."bank_reference")) > 0),
	CONSTRAINT "receiving_destination_mask_check" CHECK ("receiving_destination"."masked_descriptor" IS NULL OR length("receiving_destination"."masked_descriptor") <= 120)
);
--> statement-breakpoint
CREATE TABLE "receiving_verification_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"account_id" text NOT NULL,
	"environment" "financial_environment" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"destination_version" integer NOT NULL,
	"account_reference" text,
	"recipient_reference" text,
	"operator_reference" text,
	"bank_reference" text,
	"verification_status" "financial_verification_status" DEFAULT 'UNVERIFIED' NOT NULL,
	"provenance" "financial_evidence_provenance",
	"verification_reference" text,
	"provider_account_state" "receiving_provider_account_state" DEFAULT 'UNVERIFIED' NOT NULL,
	"bank_state" "receiving_bank_state" DEFAULT 'UNVERIFIED' NOT NULL,
	"receiving_capability" boolean DEFAULT false NOT NULL,
	"withdrawal_capability" boolean DEFAULT false NOT NULL,
	"commercial_enabled" boolean DEFAULT false NOT NULL,
	"observed_at" timestamp with time zone,
	"bank_observed_at" timestamp with time zone,
	CONSTRAINT "receiving_evidence_scope_key" UNIQUE("site_id","account_id","environment","id"),
	CONSTRAINT "receiving_evidence_verified_check" CHECK ("receiving_verification_evidence"."verification_status" <> 'VERIFIED' OR ("receiving_verification_evidence"."provenance" IS NOT NULL AND "receiving_verification_evidence"."observed_at" IS NOT NULL AND "receiving_verification_evidence"."verification_reference" IS NOT NULL AND length(trim("receiving_verification_evidence"."verification_reference")) > 0)),
	CONSTRAINT "receiving_evidence_bank_check" CHECK ("receiving_verification_evidence"."bank_state" <> 'VERIFIED' OR ("receiving_verification_evidence"."verification_status" = 'VERIFIED' AND "receiving_verification_evidence"."bank_observed_at" IS NOT NULL AND "receiving_verification_evidence"."bank_reference" IS NOT NULL AND length(trim("receiving_verification_evidence"."bank_reference")) > 0)),
	CONSTRAINT "receiving_evidence_environment_check" CHECK ("receiving_verification_evidence"."provenance" <> 'SIMULATION' OR "receiving_verification_evidence"."environment" = 'sandbox'),
	CONSTRAINT "receiving_evidence_time_check" CHECK (("receiving_verification_evidence"."observed_at" IS NULL OR "receiving_verification_evidence"."observed_at" <= "receiving_verification_evidence"."created_at") AND ("receiving_verification_evidence"."bank_observed_at" IS NULL OR "receiving_verification_evidence"."bank_observed_at" <= "receiving_verification_evidence"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "withdrawal_intent" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"account_id" text NOT NULL,
	"environment" "financial_environment" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"operator_user_id" text NOT NULL,
	"destination_version" integer NOT NULL,
	"request_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"authorization_reference" text NOT NULL,
	"policy_version" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"fee_cents" integer NOT NULL,
	"net_cents" integer NOT NULL,
	"currency" text DEFAULT 'BRL' NOT NULL,
	"state" "withdrawal_intent_state" DEFAULT 'REQUESTED' NOT NULL,
	"reservation_state" "withdrawal_reservation_state" DEFAULT 'HELD' NOT NULL,
	"reserved_cents" integer NOT NULL,
	"provider_reference" text,
	"receipt_reference" text,
	"resolution_observed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withdrawal_intent_scope_key" UNIQUE("site_id","account_id","environment","id"),
	CONSTRAINT "withdrawal_intent_request_key" UNIQUE("site_id","request_id"),
	CONSTRAINT "withdrawal_intent_provider_key" UNIQUE("site_id","account_id","environment","provider_reference"),
	CONSTRAINT "withdrawal_intent_request_hash_check" CHECK ("withdrawal_intent"."request_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "withdrawal_intent_request_check" CHECK (length(trim("withdrawal_intent"."request_id")) BETWEEN 1 AND 128 AND length(trim("withdrawal_intent"."policy_version")) BETWEEN 1 AND 128 AND length(trim("withdrawal_intent"."authorization_reference")) > 0),
	CONSTRAINT "withdrawal_intent_currency_check" CHECK ("withdrawal_intent"."currency" = 'BRL'),
	CONSTRAINT "withdrawal_intent_amounts_check" CHECK ("withdrawal_intent"."amount_cents" BETWEEN 1 AND 2147483647 AND "withdrawal_intent"."fee_cents" BETWEEN 0 AND 2147483647 AND "withdrawal_intent"."net_cents" BETWEEN 1 AND 2147483647 AND "withdrawal_intent"."reserved_cents" BETWEEN 0 AND 2147483647),
	CONSTRAINT "withdrawal_intent_allocation_check" CHECK ("withdrawal_intent"."amount_cents"::bigint = "withdrawal_intent"."fee_cents"::bigint + "withdrawal_intent"."net_cents"::bigint),
	CONSTRAINT "withdrawal_intent_reservation_check" CHECK (("withdrawal_intent"."state" IN ('REQUESTED', 'AWAITING_AUTHORIZATION', 'PROCESSING', 'UNKNOWN') AND "withdrawal_intent"."reservation_state" = 'HELD' AND "withdrawal_intent"."reserved_cents" = "withdrawal_intent"."amount_cents") OR ("withdrawal_intent"."state" = 'COMPLETED' AND "withdrawal_intent"."reservation_state" = 'CONSUMED' AND "withdrawal_intent"."reserved_cents" = 0) OR ("withdrawal_intent"."state" IN ('FAILED', 'CANCELLED') AND "withdrawal_intent"."reservation_state" = 'RELEASED' AND "withdrawal_intent"."reserved_cents" = 0)),
	CONSTRAINT "withdrawal_intent_resolution_check" CHECK ("withdrawal_intent"."state" NOT IN ('COMPLETED', 'FAILED', 'CANCELLED') OR "withdrawal_intent"."resolution_observed_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "gift_media_asset" ADD COLUMN "declared_content_type" text;--> statement-breakpoint
ALTER TABLE "gift_media_asset" ADD COLUMN "declared_byte_length" integer;--> statement-breakpoint
ALTER TABLE "gift_media_asset" ADD COLUMN "processing_id" text;--> statement-breakpoint
ALTER TABLE "gift_media_asset" ADD COLUMN "processing_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gift_media_publication_intent" ADD CONSTRAINT "gift_media_publication_intent_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_media_publication_intent" ADD CONSTRAINT "gift_media_publication_asset_fk" FOREIGN KEY ("site_id","asset_id") REFERENCES "public"."gift_media_asset"("site_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "financial_event_inbox" ADD CONSTRAINT "financial_event_inbox_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_event_inbox" ADD CONSTRAINT "financial_event_account_fk" FOREIGN KEY ("site_id","account_id","environment") REFERENCES "public"."receiving_account"("site_id","id","environment") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "financial_event_inbox" ADD CONSTRAINT "financial_event_payment_fk" FOREIGN KEY ("site_id","account_id","environment","payment_id") REFERENCES "public"."gift_payment_record"("site_id","account_id","environment","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "financial_ledger_entry" ADD CONSTRAINT "financial_ledger_entry_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_ledger_entry" ADD CONSTRAINT "financial_ledger_account_fk" FOREIGN KEY ("site_id","account_id","environment") REFERENCES "public"."receiving_account"("site_id","id","environment") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "financial_ledger_entry" ADD CONSTRAINT "financial_ledger_payment_fk" FOREIGN KEY ("site_id","account_id","environment","payment_id") REFERENCES "public"."gift_payment_record"("site_id","account_id","environment","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "financial_ledger_entry" ADD CONSTRAINT "financial_ledger_withdrawal_fk" FOREIGN KEY ("site_id","account_id","environment","withdrawal_intent_id") REFERENCES "public"."withdrawal_intent"("site_id","account_id","environment","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "financial_ledger_entry" ADD CONSTRAINT "financial_ledger_operation_fk" FOREIGN KEY ("site_id","account_id","environment","operation_id") REFERENCES "public"."financial_operation"("site_id","account_id","environment","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "financial_ledger_entry" ADD CONSTRAINT "financial_ledger_event_fk" FOREIGN KEY ("site_id","account_id","environment","event_id") REFERENCES "public"."financial_event_inbox"("site_id","account_id","environment","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "financial_ledger_entry" ADD CONSTRAINT "financial_ledger_compensation_fk" FOREIGN KEY ("site_id","account_id","environment","compensates_entry_id") REFERENCES "public"."financial_ledger_entry"("site_id","account_id","environment","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "financial_operation" ADD CONSTRAINT "financial_operation_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_operation" ADD CONSTRAINT "financial_operation_account_fk" FOREIGN KEY ("site_id","account_id","environment") REFERENCES "public"."receiving_account"("site_id","id","environment") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "financial_operation" ADD CONSTRAINT "financial_operation_order_fk" FOREIGN KEY ("site_id","account_id","environment","order_id") REFERENCES "public"."gift_order"("site_id","account_id","environment","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "financial_operation" ADD CONSTRAINT "financial_operation_withdrawal_fk" FOREIGN KEY ("site_id","account_id","environment","withdrawal_intent_id") REFERENCES "public"."withdrawal_intent"("site_id","account_id","environment","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "financial_operation" ADD CONSTRAINT "financial_operation_payment_fk" FOREIGN KEY ("site_id","account_id","environment","payment_id","order_id") REFERENCES "public"."gift_payment_record"("site_id","account_id","environment","id","order_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "gift_checkout_attempt" ADD CONSTRAINT "gift_checkout_attempt_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_checkout_attempt" ADD CONSTRAINT "gift_checkout_attempt_account_fk" FOREIGN KEY ("site_id","account_id","environment") REFERENCES "public"."receiving_account"("site_id","id","environment") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "gift_checkout_attempt" ADD CONSTRAINT "gift_checkout_attempt_order_fk" FOREIGN KEY ("site_id","account_id","environment","order_id") REFERENCES "public"."gift_order"("site_id","account_id","environment","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "gift_checkout_attempt" ADD CONSTRAINT "gift_checkout_attempt_operation_fk" FOREIGN KEY ("site_id","account_id","environment","operation_id","order_id","operation_kind") REFERENCES "public"."financial_operation"("site_id","account_id","environment","id","order_id","kind") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "gift_order" ADD CONSTRAINT "gift_order_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_order" ADD CONSTRAINT "gift_order_account_fk" FOREIGN KEY ("site_id","account_id","environment") REFERENCES "public"."receiving_account"("site_id","id","environment") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "gift_order" ADD CONSTRAINT "gift_order_quote_fk" FOREIGN KEY ("site_id","account_id","environment","quote_id") REFERENCES "public"."gift_quote_record"("site_id","account_id","environment","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "gift_payment_record" ADD CONSTRAINT "gift_payment_record_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_payment_record" ADD CONSTRAINT "gift_payment_account_fk" FOREIGN KEY ("site_id","account_id","environment") REFERENCES "public"."receiving_account"("site_id","id","environment") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "gift_payment_record" ADD CONSTRAINT "gift_payment_attempt_fk" FOREIGN KEY ("site_id","account_id","environment","attempt_id","order_id") REFERENCES "public"."gift_checkout_attempt"("site_id","account_id","environment","id","order_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "gift_quote_record" ADD CONSTRAINT "gift_quote_record_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_quote_record" ADD CONSTRAINT "gift_quote_account_fk" FOREIGN KEY ("site_id","account_id","environment") REFERENCES "public"."receiving_account"("site_id","id","environment") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "gift_quote_record" ADD CONSTRAINT "gift_quote_destination_fk" FOREIGN KEY ("site_id","account_id","environment","destination_version") REFERENCES "public"."receiving_destination"("site_id","account_id","environment","version") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "gift_quote_record" ADD CONSTRAINT "gift_quote_gift_fk" FOREIGN KEY ("site_id","gift_id") REFERENCES "public"."gift_item"("site_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "receiving_account" ADD CONSTRAINT "receiving_account_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_account" ADD CONSTRAINT "receiving_account_operator_user_id_user_id_fk" FOREIGN KEY ("operator_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_destination" ADD CONSTRAINT "receiving_destination_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_destination" ADD CONSTRAINT "receiving_destination_account_fk" FOREIGN KEY ("site_id","account_id","environment") REFERENCES "public"."receiving_account"("site_id","id","environment") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "receiving_verification_evidence" ADD CONSTRAINT "receiving_verification_evidence_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_verification_evidence" ADD CONSTRAINT "receiving_evidence_account_fk" FOREIGN KEY ("site_id","account_id","environment") REFERENCES "public"."receiving_account"("site_id","id","environment") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "receiving_verification_evidence" ADD CONSTRAINT "receiving_evidence_destination_fk" FOREIGN KEY ("site_id","account_id","environment","destination_version") REFERENCES "public"."receiving_destination"("site_id","account_id","environment","version") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "withdrawal_intent" ADD CONSTRAINT "withdrawal_intent_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawal_intent" ADD CONSTRAINT "withdrawal_intent_operator_user_id_user_id_fk" FOREIGN KEY ("operator_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawal_intent" ADD CONSTRAINT "withdrawal_intent_account_fk" FOREIGN KEY ("site_id","account_id","environment") REFERENCES "public"."receiving_account"("site_id","id","environment") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "withdrawal_intent" ADD CONSTRAINT "withdrawal_intent_destination_fk" FOREIGN KEY ("site_id","account_id","environment","destination_version") REFERENCES "public"."receiving_destination"("site_id","account_id","environment","version") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "financial_event_retry_idx" ON "financial_event_inbox" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "financial_operation_retry_idx" ON "financial_operation" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "receiving_account_current_idx" ON "receiving_account" USING btree ("site_id","environment") WHERE "receiving_account"."is_current" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "receiving_destination_current_idx" ON "receiving_destination" USING btree ("site_id","account_id","environment") WHERE "receiving_destination"."is_current" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "gift_media_asset_processing_id_idx" ON "gift_media_asset" USING btree ("processing_id");--> statement-breakpoint
ALTER TABLE "gift_media_asset" ADD CONSTRAINT "gift_media_asset_declared_content_check" CHECK (("gift_media_asset"."declared_content_type" IS NULL AND "gift_media_asset"."declared_byte_length" IS NULL) OR ("gift_media_asset"."declared_content_type" IS NOT NULL AND "gift_media_asset"."declared_byte_length" IS NOT NULL AND "gift_media_asset"."declared_content_type" IN ('image/jpeg', 'image/png', 'image/webp') AND "gift_media_asset"."declared_byte_length" BETWEEN 1 AND 5242880));--> statement-breakpoint
ALTER TABLE "gift_media_asset" ADD CONSTRAINT "gift_media_asset_processing_pair_check" CHECK (("gift_media_asset"."processing_id" IS NULL AND "gift_media_asset"."processing_expires_at" IS NULL) OR ("gift_media_asset"."processing_id" IS NOT NULL AND "gift_media_asset"."processing_expires_at" IS NOT NULL AND "gift_media_asset"."processing_expires_at" > "gift_media_asset"."created_at"));--> statement-breakpoint
ALTER TABLE "gift_media_asset" ADD CONSTRAINT "gift_media_asset_processing_claim_check" CHECK ("gift_media_asset"."state"::text <> 'PROCESSING' OR ("gift_media_asset"."processing_id" IS NOT NULL AND "gift_media_asset"."processing_expires_at" IS NOT NULL AND "gift_media_asset"."declared_content_type" IS NOT NULL AND "gift_media_asset"."declared_byte_length" IS NOT NULL));