import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  createDatabaseConnection,
  verifyDatabaseConnection,
} from "../../../packages/database/src/connection";
import {
  readGiftPricingSettings,
  updateGiftPricingSettings,
} from "./giftPricingSettings";

it("applies the migration and persists isolated preferences with PostgreSQL revision comparison", async () => {
  const connection = createDatabaseConnection({ target: "test" });
  try {
    await verifyDatabaseConnection(connection);
    await connection.db.transaction(async (tx) => {
      await tx.execute(
        sql.raw(`CREATE TEMP TABLE site (id text PRIMARY KEY) ON COMMIT DROP;
        INSERT INTO site VALUES ('site-a'), ('site-b');
        CREATE TEMP TABLE "user" (id text, role text, state text) ON COMMIT DROP;
        INSERT INTO "user" VALUES ('owner', 'OWNER', 'ACTIVE');
        CREATE TEMP TABLE site_membership (id text, user_id text, site_id text, role text, revoked_at timestamptz) ON COMMIT DROP;`),
      );
      const migration = readFileSync(
        new URL(
          "../../../packages/database/migrations/0025_gift_pricing_settings.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await tx.execute(
        sql.raw(
          migration
            .replace(
              'CREATE TABLE "gift_pricing_settings"',
              'CREATE TEMP TABLE "gift_pricing_settings"',
            )
            .replace("\n);", "\n) ON COMMIT DROP;")
            .replace('REFERENCES "public"."site"', 'REFERENCES "site"'),
        ),
      );
      expect(await readGiftPricingSettings(tx, "site-a")).toMatchObject({
        feeAllocation: "RECIPIENT_DEDUCTED",
        revision: 0,
      });
      const actor = { userId: "owner", role: "OWNER" as const };
      expect(
        await updateGiftPricingSettings(tx, actor, "site-a", {
          feeAllocation: "BUYER_GROSS_UP",
          revision: 0,
        }),
      ).toMatchObject({
        settings: { revision: 1, feeAllocation: "BUYER_GROSS_UP" },
      });
      expect(
        await updateGiftPricingSettings(tx, actor, "site-a", {
          feeAllocation: "RECIPIENT_DEDUCTED",
          revision: 1,
        }),
      ).toMatchObject({ settings: { revision: 2 } });
      await expect(
        updateGiftPricingSettings(tx, actor, "site-a", {
          feeAllocation: "BUYER_GROSS_UP",
          revision: 0,
        }),
      ).rejects.toMatchObject({ code: "GIFT_PRICING_SETTINGS_CONFLICT" });
      expect(await readGiftPricingSettings(tx, "site-b")).toMatchObject({
        feeAllocation: "RECIPIENT_DEDUCTED",
        revision: 0,
      });
    });
  } finally {
    await connection.close();
  }
});
