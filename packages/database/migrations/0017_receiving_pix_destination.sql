CREATE TABLE "receiving_pix_destination" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"account_id" text NOT NULL,
	"environment" "financial_environment" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"pix_configuration" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receiving_pix_destination_version_key" UNIQUE("site_id","account_id","environment","version"),
	CONSTRAINT "receiving_pix_destination_version_check" CHECK ("receiving_pix_destination"."version" > 0),
	CONSTRAINT "receiving_pix_destination_pending_check" CHECK ("receiving_pix_destination"."state" = 'PENDING')
);
--> statement-breakpoint
ALTER TABLE "receiving_pix_destination" ADD CONSTRAINT "receiving_pix_destination_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_pix_destination" ADD CONSTRAINT "receiving_pix_destination_account_fk" FOREIGN KEY ("site_id","account_id","environment") REFERENCES "public"."receiving_account"("site_id","id","environment") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "receiving_pix_destination_current_idx" ON "receiving_pix_destination" USING btree ("site_id","account_id","environment") WHERE "receiving_pix_destination"."is_current" = true;