CREATE TYPE "public"."rsvp_actor_type" AS ENUM('ADMIN', 'FAMILY');--> statement-breakpoint
CREATE TYPE "public"."rsvp_request_scope" AS ENUM('PUBLIC', 'ADMIN');--> statement-breakpoint
CREATE TYPE "public"."rsvp_state" AS ENUM('PENDING', 'CONFIRMED', 'DECLINED');--> statement-breakpoint
CREATE TABLE "rsvp_history" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"group_id" text NOT NULL,
	"member_id" text NOT NULL,
	"group_name" text NOT NULL,
	"member_display_name" text NOT NULL,
	"before_state" "rsvp_state" NOT NULL,
	"after_state" "rsvp_state" NOT NULL,
	"actor_type" "rsvp_actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"actor_display_name" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rsvp_history_transition_check" CHECK ("rsvp_history"."before_state" <> "rsvp_history"."after_state")
);
--> statement-breakpoint
CREATE TABLE "rsvp_request_receipt" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"group_id" text,
	"scope" "rsvp_request_scope" NOT NULL,
	"actor_type" "rsvp_actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"request_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" text NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rsvp_request_receipt_request_hash_check" CHECK ("rsvp_request_receipt"."request_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "rsvp_request_receipt_group_scope_check" CHECK (("rsvp_request_receipt"."scope" = 'PUBLIC' AND "rsvp_request_receipt"."group_id" IS NOT NULL) OR ("rsvp_request_receipt"."scope" = 'ADMIN'))
);
--> statement-breakpoint
ALTER TABLE "guest_member" ADD COLUMN "rsvp_state" "rsvp_state" DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "guest_member" ADD COLUMN "rsvp_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "rsvp_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "rsvp_deadline_timezone" text;--> statement-breakpoint
ALTER TABLE "rsvp_history" ADD CONSTRAINT "rsvp_history_site_group_fk" FOREIGN KEY ("site_id","group_id") REFERENCES "public"."guest_group"("site_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rsvp_history" ADD CONSTRAINT "rsvp_history_site_group_member_fk" FOREIGN KEY ("site_id","group_id","member_id") REFERENCES "public"."guest_member"("site_id","group_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rsvp_request_receipt" ADD CONSTRAINT "rsvp_request_receipt_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rsvp_request_receipt" ADD CONSTRAINT "rsvp_request_receipt_site_group_fk" FOREIGN KEY ("site_id","group_id") REFERENCES "public"."guest_group"("site_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rsvp_history_site_occurred_idx" ON "rsvp_history" USING btree ("site_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "rsvp_history_site_group_idx" ON "rsvp_history" USING btree ("site_id","group_id");--> statement-breakpoint
CREATE INDEX "rsvp_history_site_member_idx" ON "rsvp_history" USING btree ("site_id","member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rsvp_request_receipt_scope_actor_request_idx" ON "rsvp_request_receipt" USING btree ("scope","actor_type","actor_id","request_id");--> statement-breakpoint
CREATE INDEX "rsvp_request_receipt_site_created_idx" ON "rsvp_request_receipt" USING btree ("site_id","created_at");--> statement-breakpoint
ALTER TABLE "guest_member" ADD CONSTRAINT "guest_member_rsvp_revision_check" CHECK ("guest_member"."rsvp_revision" >= 0);--> statement-breakpoint
ALTER TABLE "site" ADD CONSTRAINT "site_rsvp_deadline_pair_check" CHECK (("site"."rsvp_deadline_at" IS NULL) = ("site"."rsvp_deadline_timezone" IS NULL));