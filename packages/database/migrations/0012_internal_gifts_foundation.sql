CREATE TYPE "public"."gift_media_state" AS ENUM('PENDING', 'FINALIZED', 'EXPIRED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."gift_publication_state" AS ENUM('DRAFT', 'PUBLISHED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."site_membership_role" AS ENUM('SITE_ADMIN', 'SITE_ASSISTANT');--> statement-breakpoint
ALTER TYPE "public"."admin_role" ADD VALUE 'SITE_ASSISTANT';--> statement-breakpoint
CREATE TABLE "gift_item" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"nominal_cents" integer NOT NULL,
	"currency" text DEFAULT 'BRL' NOT NULL,
	"media_asset_id" text,
	"alt_text" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"publication_state" "gift_publication_state" DEFAULT 'DRAFT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gift_item_nominal_cents_check" CHECK ("gift_item"."nominal_cents" > 0),
	CONSTRAINT "gift_item_currency_check" CHECK ("gift_item"."currency" = 'BRL'),
	CONSTRAINT "gift_item_title_check" CHECK (length(trim("gift_item"."title")) BETWEEN 1 AND 120),
	CONSTRAINT "gift_item_description_check" CHECK (length("gift_item"."description") <= 2000),
	CONSTRAINT "gift_item_alt_text_check" CHECK (length("gift_item"."alt_text") <= 240),
	CONSTRAINT "gift_item_sort_order_check" CHECK ("gift_item"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "gift_media_asset" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"staging_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"stable_object_version" text,
	"state" "gift_media_state" DEFAULT 'PENDING' NOT NULL,
	"derivative_key" text,
	"public_url" text,
	"content_type" text,
	"byte_length" integer,
	"width" integer,
	"height" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gift_media_asset_expiry_check" CHECK ("gift_media_asset"."expires_at" > "gift_media_asset"."created_at"),
	CONSTRAINT "gift_media_asset_dimensions_check" CHECK (("gift_media_asset"."width" IS NULL OR "gift_media_asset"."width" > 0) AND ("gift_media_asset"."height" IS NULL OR "gift_media_asset"."height" > 0) AND ("gift_media_asset"."byte_length" IS NULL OR "gift_media_asset"."byte_length" > 0)),
	CONSTRAINT "gift_media_asset_finalized_check" CHECK ("gift_media_asset"."state" <> 'FINALIZED' OR ("gift_media_asset"."stable_object_version" IS NOT NULL AND "gift_media_asset"."derivative_key" IS NOT NULL AND "gift_media_asset"."derivative_key" <> "gift_media_asset"."staging_key" AND "gift_media_asset"."public_url" IS NOT NULL AND "gift_media_asset"."content_type" IS NOT NULL AND "gift_media_asset"."width" IS NOT NULL AND "gift_media_asset"."height" IS NOT NULL AND "gift_media_asset"."byte_length" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "site_assessor_invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"email" text NOT NULL,
	"invitee_name" text NOT NULL,
	"role" "site_membership_role" DEFAULT 'SITE_ASSISTANT' NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"invited_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_assessor_invitation_role_check" CHECK ("site_assessor_invitation"."role" = 'SITE_ASSISTANT'),
	CONSTRAINT "site_assessor_invitation_name_check" CHECK (length(trim("site_assessor_invitation"."invitee_name")) BETWEEN 1 AND 160),
	CONSTRAINT "site_assessor_invitation_email_check" CHECK ("site_assessor_invitation"."email" = lower(trim("site_assessor_invitation"."email")) AND length("site_assessor_invitation"."email") > 0),
	CONSTRAINT "site_assessor_invitation_expiry_check" CHECK ("site_assessor_invitation"."expires_at" > "site_assessor_invitation"."created_at"),
	CONSTRAINT "site_assessor_invitation_token_hash_check" CHECK ("site_assessor_invitation"."token_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
DROP INDEX "site_membership_user_id_idx";--> statement-breakpoint
ALTER TABLE "site_membership" ADD COLUMN "role" "site_membership_role" DEFAULT 'SITE_ADMIN' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_membership" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "site_membership" ADD COLUMN "invited_by_user_id" text;--> statement-breakpoint
ALTER TABLE "gift_item" ADD CONSTRAINT "gift_item_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gift_media_asset_site_id_id_idx" ON "gift_media_asset" USING btree ("site_id","id");--> statement-breakpoint
ALTER TABLE "gift_item" ADD CONSTRAINT "gift_item_site_media_fk" FOREIGN KEY ("site_id","media_asset_id") REFERENCES "public"."gift_media_asset"("site_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_media_asset" ADD CONSTRAINT "gift_media_asset_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_assessor_invitation" ADD CONSTRAINT "site_assessor_invitation_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_assessor_invitation" ADD CONSTRAINT "site_assessor_invitation_invited_by_user_id_user_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gift_item_site_id_id_idx" ON "gift_item" USING btree ("site_id","id");--> statement-breakpoint
CREATE INDEX "gift_item_site_state_order_idx" ON "gift_item" USING btree ("site_id","publication_state","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "gift_media_asset_staging_key_idx" ON "gift_media_asset" USING btree ("staging_key");--> statement-breakpoint
CREATE UNIQUE INDEX "gift_media_asset_derivative_key_idx" ON "gift_media_asset" USING btree ("derivative_key");--> statement-breakpoint
CREATE UNIQUE INDEX "site_assessor_invitation_token_hash_idx" ON "site_assessor_invitation" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "site_assessor_invitation_site_email_idx" ON "site_assessor_invitation" USING btree ("site_id","email");--> statement-breakpoint
ALTER TABLE "site_membership" ADD CONSTRAINT "site_membership_invited_by_user_id_user_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;