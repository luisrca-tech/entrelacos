CREATE TABLE "financial_operator_alert" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"environment" "financial_environment" NOT NULL,
	"site_id" text,
	"account_id" text,
	"payment_reference" text,
	"checkout_attempt_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_note" text,
	CONSTRAINT "financial_operator_alert_kind_check" CHECK ("financial_operator_alert"."kind" IN ('SPLIT_DIVERGENCE_BLOCK','SPLIT_CANCELLED','ANTICIPATION_DENIED','PAYMENT_RESTRICTION','UNROUTABLE_PLATFORM_EVENT','SPLIT_SETUP_FAILED')),
	CONSTRAINT "financial_operator_alert_severity_check" CHECK ("financial_operator_alert"."severity" IN ('warning','critical')),
	CONSTRAINT "financial_operator_alert_resolution_check" CHECK (("financial_operator_alert"."resolved_at" IS NULL AND "financial_operator_alert"."resolved_note" IS NULL) OR ("financial_operator_alert"."resolved_at" IS NOT NULL AND "financial_operator_alert"."resolved_at" >= "financial_operator_alert"."created_at")),
	CONSTRAINT "financial_operator_alert_reference_check" CHECK ("financial_operator_alert"."payment_reference" IS NULL OR length(trim("financial_operator_alert"."payment_reference")) > 0)
);
--> statement-breakpoint
ALTER TABLE "gift_payment_record" ADD COLUMN "anticipation_cents" integer;--> statement-breakpoint
ALTER TABLE "gift_payment_record" ADD COLUMN "anticipation_reference" text;--> statement-breakpoint
ALTER TABLE "gift_payment_record" ADD COLUMN "platform_net_cents" integer;--> statement-breakpoint
ALTER TABLE "gift_payment_record" ADD COLUMN "split_divergence_blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "financial_operator_alert" ADD CONSTRAINT "financial_operator_alert_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "financial_operator_alert_open_key" ON "financial_operator_alert" USING btree ("environment","kind","payment_reference") WHERE "financial_operator_alert"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "financial_operator_alert_open_idx" ON "financial_operator_alert" USING btree ("environment","created_at") WHERE "financial_operator_alert"."resolved_at" IS NULL;--> statement-breakpoint
ALTER TABLE "gift_payment_record" ADD CONSTRAINT "gift_payment_anticipation_check" CHECK (("gift_payment_record"."anticipation_cents" IS NULL OR "gift_payment_record"."anticipation_cents" BETWEEN 0 AND 2147483647) AND ("gift_payment_record"."anticipation_reference" IS NULL OR length(trim("gift_payment_record"."anticipation_reference")) > 0));