CREATE TABLE "receiving_setup_holder" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"environment" text NOT NULL,
	"holder_user_id" text NOT NULL,
	"designated_by_user_id" text NOT NULL,
	"designated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consent_id" text,
	"consent_version" text,
	"consent_at" timestamp with time zone,
	"consent_session_id" text,
	"consent_authenticated_at" timestamp with time zone,
	CONSTRAINT "receiving_setup_holder_environment_check" CHECK ("receiving_setup_holder"."environment" IN ('sandbox', 'live')),
	CONSTRAINT "receiving_setup_holder_consent_check" CHECK (("receiving_setup_holder"."consent_id" IS NULL AND "receiving_setup_holder"."consent_version" IS NULL AND "receiving_setup_holder"."consent_at" IS NULL AND "receiving_setup_holder"."consent_session_id" IS NULL AND "receiving_setup_holder"."consent_authenticated_at" IS NULL) OR ("receiving_setup_holder"."consent_id" IS NOT NULL AND "receiving_setup_holder"."consent_version" IS NOT NULL AND "receiving_setup_holder"."consent_at" IS NOT NULL AND "receiving_setup_holder"."consent_session_id" IS NOT NULL AND "receiving_setup_holder"."consent_authenticated_at" IS NOT NULL AND "receiving_setup_holder"."consent_at" >= "receiving_setup_holder"."designated_at" AND "receiving_setup_holder"."consent_authenticated_at" <= "receiving_setup_holder"."consent_at"))
);
--> statement-breakpoint
ALTER TABLE "receiving_setup_holder" ADD CONSTRAINT "receiving_setup_holder_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_setup_holder" ADD CONSTRAINT "receiving_setup_holder_holder_user_id_user_id_fk" FOREIGN KEY ("holder_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_setup_holder" ADD CONSTRAINT "receiving_setup_holder_designated_by_user_id_user_id_fk" FOREIGN KEY ("designated_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "receiving_setup_holder_site_environment_idx" ON "receiving_setup_holder" USING btree ("site_id","environment");