ALTER TABLE "guest_group" ADD COLUMN "is_individual" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "guest_group" SET "is_individual" = true
WHERE "id" IN (
	SELECT "group_id" FROM "guest_member" GROUP BY "group_id" HAVING COUNT(*) = 1
);
