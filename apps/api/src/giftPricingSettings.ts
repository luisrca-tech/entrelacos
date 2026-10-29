import {
  type GiftPricingSettings,
  type GiftPricingSettingsInput,
  giftPricingSettingsInputSchema,
  giftPricingSettingsSchema,
} from "@entrelacos/contracts";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { GiftServiceError } from "./gifts";
import {
  requireSiteCapability,
  type SiteAccessActor,
  type SiteAccessDatabase,
  SiteAccessDeniedError,
} from "./siteAccess";

const blockedReason =
  "Buyer gross-up requires verified provider pricing and settlement evidence before purchases can be enabled.";
function settingsFromRow(row: unknown): GiftPricingSettings {
  const value = row as
    | { site_id: string; fee_allocation: string; revision: number }
    | undefined;
  if (!value)
    throw new GiftServiceError(404, "SITE_NOT_FOUND", "Site unavailable");
  const parsed = giftPricingSettingsSchema.safeParse({
    siteId: value.site_id,
    feeAllocation: value.fee_allocation,
    revision: value.revision,
    buyerGrossUpAvailable: false,
    blockedReason,
  });
  if (!parsed.success)
    throw new GiftServiceError(
      503,
      "SERVICE_UNAVAILABLE",
      "Pricing settings unavailable",
    );
  return parsed.data;
}
export async function readGiftPricingSettings(
  db: SiteAccessDatabase,
  siteId: string,
): Promise<GiftPricingSettings> {
  const result = await db.execute(sql`
    SELECT s.id AS site_id, coalesce(p.fee_allocation, 'RECIPIENT_DEDUCTED') AS fee_allocation,
      coalesce(p.revision, 0) AS revision
    FROM site s LEFT JOIN gift_pricing_settings p ON p.site_id = s.id WHERE s.id = ${siteId}
  `);
  const settings = settingsFromRow(result.rows[0]);
  if (settings.siteId !== siteId)
    throw new GiftServiceError(
      503,
      "SERVICE_UNAVAILABLE",
      "Pricing settings unavailable",
    );
  return settings;
}
async function authorize(
  db: SiteAccessDatabase,
  actor: SiteAccessActor,
  siteId: string,
) {
  const access = await requireSiteCapability(
    db,
    actor,
    siteId,
    "manageCatalog",
  );
  if (!access.capabilities.readFinance) {
    throw new SiteAccessDeniedError();
  }
}
export async function loadGiftPricingSettings(
  db: SiteAccessDatabase,
  actor: SiteAccessActor,
  siteId: string,
) {
  await authorize(db, actor, siteId);
  return { settings: await readGiftPricingSettings(db, siteId) };
}
export async function updateGiftPricingSettings(
  db: Pick<NodePgDatabase<Record<string, never>>, "execute" | "transaction">,
  actor: SiteAccessActor,
  siteId: string,
  input: GiftPricingSettingsInput,
) {
  const parsed = giftPricingSettingsInputSchema.safeParse(input);
  if (!parsed.success)
    throw new GiftServiceError(
      400,
      "VALIDATION_ERROR",
      "Invalid pricing settings",
    );
  await authorize(db, actor, siteId);
  if (parsed.data.revision === 2147483647)
    throw new GiftServiceError(
      409,
      "GIFT_PRICING_SETTINGS_CONFLICT",
      "Pricing settings revision exhausted",
    );
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM site WHERE id = ${siteId} FOR UPDATE`);
    await authorize(tx, actor, siteId);
    const result = await tx.execute(sql`
    INSERT INTO gift_pricing_settings (site_id, fee_allocation, revision)
    SELECT s.id, ${parsed.data.feeAllocation}, ${parsed.data.revision} + 1 FROM site s WHERE s.id = ${siteId}
      AND coalesce((SELECT revision FROM gift_pricing_settings WHERE site_id = s.id), 0) = ${parsed.data.revision}
    ON CONFLICT (site_id) DO UPDATE SET fee_allocation = ${parsed.data.feeAllocation}, revision = gift_pricing_settings.revision + 1
    WHERE gift_pricing_settings.revision = ${parsed.data.revision} AND gift_pricing_settings.revision < 2147483647
    RETURNING site_id, fee_allocation, revision
  `);
    if (!result.rows.length)
      throw new GiftServiceError(
        409,
        "GIFT_PRICING_SETTINGS_CONFLICT",
        "Pricing settings changed; reload before saving",
      );
    const settings = settingsFromRow(result.rows[0]);
    if (settings.siteId !== siteId)
      throw new GiftServiceError(
        503,
        "SERVICE_UNAVAILABLE",
        "Pricing settings unavailable",
      );
    return { settings };
  });
}
