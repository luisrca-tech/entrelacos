CREATE TABLE "receiving_pix_preparation" (
	"account_id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"environment" "financial_environment" NOT NULL,
	"attempt_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"consent_id" text NOT NULL,
	"state" text NOT NULL,
	"attempts" integer NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "receiving_pix_preparation_attempt_id_unique" UNIQUE("attempt_id"),
	CONSTRAINT "receiving_pix_preparation_state_check" CHECK ("receiving_pix_preparation"."state" IN ('ARMED','SUBMITTED','REJECTED','UNKNOWN')),
	CONSTRAINT "receiving_pix_preparation_attempt_check" CHECK ("receiving_pix_preparation"."attempts" > 0 AND "receiving_pix_preparation"."updated_at" >= "receiving_pix_preparation"."attempted_at")
);
--> statement-breakpoint
ALTER TABLE "receiving_pix_preparation" ADD CONSTRAINT "receiving_pix_preparation_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_pix_preparation" ADD CONSTRAINT "receiving_pix_preparation_account_fk" FOREIGN KEY ("site_id","account_id","environment") REFERENCES "public"."receiving_account"("site_id","id","environment") ON DELETE restrict ON UPDATE restrict;