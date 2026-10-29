CREATE TABLE "gift_pricing_settings" (
	"site_id" text PRIMARY KEY NOT NULL,
	"fee_allocation" text DEFAULT 'RECIPIENT_DEDUCTED' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "gift_pricing_settings_allocation_check" CHECK ("gift_pricing_settings"."fee_allocation" IN ('RECIPIENT_DEDUCTED', 'BUYER_GROSS_UP')),
	CONSTRAINT "gift_pricing_settings_revision_check" CHECK ("gift_pricing_settings"."revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "gift_pricing_settings" ADD CONSTRAINT "gift_pricing_settings_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;