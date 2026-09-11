CREATE TYPE "public"."admin_access_purpose" AS ENUM('ACTIVATION', 'RECOVERY');--> statement-breakpoint
CREATE TYPE "public"."site_domain_state" AS ENUM('NONE', 'PENDING', 'ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "public"."site_lifecycle" AS ENUM('DRAFT', 'IN_REVIEW', 'ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "public"."site_publication_state" AS ENUM('UNPUBLISHED', 'PUBLISHED', 'PLACEHOLDER');--> statement-breakpoint
CREATE TABLE "admin_access_token" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"site_id" text NOT NULL,
	"purpose" "admin_access_purpose" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_access_token_expiry_check" CHECK ("admin_access_token"."expires_at" > "admin_access_token"."created_at"),
	CONSTRAINT "admin_access_token_hash_format_check" CHECK ("admin_access_token"."token_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "site" (
	"id" text PRIMARY KEY NOT NULL,
	"repository_slug" text NOT NULL,
	"provisioning_key" text NOT NULL,
	"display_name" text NOT NULL,
	"partner_one_name" text NOT NULL,
	"partner_two_name" text NOT NULL,
	"event_date" date NOT NULL,
	"lifecycle" "site_lifecycle" DEFAULT 'DRAFT' NOT NULL,
	"previous_lifecycle" "site_lifecycle",
	"publication_state" "site_publication_state" DEFAULT 'UNPUBLISHED' NOT NULL,
	"public_url" text,
	"review_approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_previous_lifecycle_not_inactive_check" CHECK ("site"."previous_lifecycle" IS NULL OR "site"."previous_lifecycle" <> 'INACTIVE'),
	CONSTRAINT "site_inactive_requires_previous_lifecycle_check" CHECK ("site"."lifecycle" <> 'INACTIVE' OR "site"."previous_lifecycle" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "site_domain" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"hostname" text NOT NULL,
	"state" "site_domain_state" DEFAULT 'NONE' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"expires_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_membership" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_origin" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"origin" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_term" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_term_date_order_check" CHECK ("site_term"."ends_on" >= "site_term"."starts_on")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "site_membership_site_id_user_id_idx" ON "site_membership" USING btree ("site_id","user_id");--> statement-breakpoint
ALTER TABLE "admin_access_token" ADD CONSTRAINT "admin_access_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_access_token" ADD CONSTRAINT "admin_access_token_site_membership_fk" FOREIGN KEY ("site_id","user_id") REFERENCES "public"."site_membership"("site_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_domain" ADD CONSTRAINT "site_domain_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_membership" ADD CONSTRAINT "site_membership_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_membership" ADD CONSTRAINT "site_membership_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_origin" ADD CONSTRAINT "site_origin_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_term" ADD CONSTRAINT "site_term_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_access_token_hash_idx" ON "admin_access_token" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "admin_access_token_user_id_idx" ON "admin_access_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "admin_access_token_site_id_idx" ON "admin_access_token" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_access_token_active_issue_idx" ON "admin_access_token" USING btree ("user_id","purpose") WHERE "admin_access_token"."consumed_at" IS NULL AND "admin_access_token"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "site_repository_slug_idx" ON "site" USING btree ("repository_slug");--> statement-breakpoint
CREATE UNIQUE INDEX "site_provisioning_key_idx" ON "site" USING btree ("provisioning_key");--> statement-breakpoint
CREATE UNIQUE INDEX "site_public_url_idx" ON "site" USING btree ("public_url");--> statement-breakpoint
CREATE UNIQUE INDEX "site_domain_hostname_idx" ON "site_domain" USING btree ("hostname");--> statement-breakpoint
CREATE UNIQUE INDEX "site_domain_primary_site_id_idx" ON "site_domain" USING btree ("site_id") WHERE "site_domain"."is_primary" = true;--> statement-breakpoint
CREATE INDEX "site_domain_site_id_idx" ON "site_domain" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "site_membership_user_id_idx" ON "site_membership" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "site_origin_origin_idx" ON "site_origin" USING btree ("origin");--> statement-breakpoint
CREATE UNIQUE INDEX "site_origin_site_id_origin_idx" ON "site_origin" USING btree ("site_id","origin");--> statement-breakpoint
CREATE UNIQUE INDEX "site_term_site_id_idx" ON "site_term" USING btree ("site_id");
