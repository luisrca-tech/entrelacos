CREATE TABLE "withdrawal_request" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"account_id" text NOT NULL,
	"environment" "financial_environment" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"operator_user_id" text NOT NULL,
	"destination_version" integer NOT NULL,
	"request_id" text NOT NULL,
	"preview_snapshot" jsonb NOT NULL,
	"preview_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"state" text NOT NULL,
	"request_revision" bigint NOT NULL,
	"withdrawal_intent_id" text,
	"sealed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withdrawal_request_identity_key" UNIQUE("site_id","request_id"),
	CONSTRAINT "withdrawal_request_identity_check" CHECK ("withdrawal_request"."request_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND "withdrawal_request"."destination_version" > 0),
	CONSTRAINT "withdrawal_request_preview_hash_check" CHECK ("withdrawal_request"."preview_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "withdrawal_request_preview_check" CHECK (jsonb_typeof("withdrawal_request"."preview_snapshot") = 'object' AND "withdrawal_request"."expires_at" > "withdrawal_request"."created_at" AND "withdrawal_request"."updated_at" >= "withdrawal_request"."created_at"),
	CONSTRAINT "withdrawal_request_lifecycle_check" CHECK (("withdrawal_request"."state" = 'OPEN' AND "withdrawal_request"."request_revision" = 1 AND "withdrawal_request"."withdrawal_intent_id" IS NULL AND "withdrawal_request"."sealed_at" IS NULL) OR ("withdrawal_request"."state" = 'COMMITTED' AND "withdrawal_request"."request_revision" = 2 AND "withdrawal_request"."withdrawal_intent_id" IS NOT NULL AND "withdrawal_request"."sealed_at" IS NULL) OR ("withdrawal_request"."state" = 'SEALED_NOT_CREATED' AND "withdrawal_request"."request_revision" = 2 AND "withdrawal_request"."withdrawal_intent_id" IS NULL AND "withdrawal_request"."sealed_at" IS NOT NULL AND "withdrawal_request"."sealed_at" >= "withdrawal_request"."created_at"))
);
--> statement-breakpoint
ALTER TABLE "withdrawal_request" ADD CONSTRAINT "withdrawal_request_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawal_request" ADD CONSTRAINT "withdrawal_request_operator_user_id_user_id_fk" FOREIGN KEY ("operator_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawal_request" ADD CONSTRAINT "withdrawal_request_account_fk" FOREIGN KEY ("site_id","account_id","environment") REFERENCES "public"."receiving_account"("site_id","id","environment") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "withdrawal_request" ADD CONSTRAINT "withdrawal_request_destination_fk" FOREIGN KEY ("site_id","account_id","environment","destination_version") REFERENCES "public"."receiving_destination"("site_id","account_id","environment","version") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "withdrawal_intent" ADD CONSTRAINT "withdrawal_intent_consent_key" UNIQUE("site_id","account_id","environment","operator_user_id","destination_version","request_id","id");--> statement-breakpoint
ALTER TABLE "withdrawal_request" ADD CONSTRAINT "withdrawal_request_intent_fk" FOREIGN KEY ("site_id","account_id","environment","operator_user_id","destination_version","request_id","withdrawal_intent_id") REFERENCES "public"."withdrawal_intent"("site_id","account_id","environment","operator_user_id","destination_version","request_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "withdrawal_request_open_idx" ON "withdrawal_request" USING btree ("site_id","operator_user_id","environment") WHERE "withdrawal_request"."state" = 'OPEN';--> statement-breakpoint
CREATE INDEX "withdrawal_request_scope_idx" ON "withdrawal_request" USING btree ("site_id","environment","operator_user_id","created_at","request_id");
