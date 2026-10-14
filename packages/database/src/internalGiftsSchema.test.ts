import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as registeredSchema from "./schema";
import {
  adminRole,
  giftItem,
  giftMediaAsset,
  giftMediaState,
  siteAssessorInvitation,
  siteMembership,
} from "./schema";

describe("internal gifts access schema", () => {
  it("preserves every immutable derivative publication intent across claim takeover", () => {
    const intent = registeredSchema.giftMediaPublicationIntent;
    expect(intent).toBeDefined();
    expect(intent.siteId.notNull).toBe(true);
    expect(intent.assetId.notNull).toBe(true);
    expect(intent.processingId.notNull).toBe(true);
    expect(intent.storageNamespace.notNull).toBe(true);
    expect(intent.derivativeKey.notNull).toBe(true);
    expect(intent.state.default).toBe("REQUESTED");
    expect(intent.observedAt.notNull).toBe(false);
    expect(intent.createdAt.notNull).toBe(true);
    const config = getTableConfig(intent);
    expect(config.foreignKeys.every((key) => key.onDelete === "restrict")).toBe(
      true,
    );
    expect(
      config.foreignKeys
        .find(
          (key) => key.reference().name === "gift_media_publication_asset_fk",
        )
        ?.reference()
        .columns.map((column) => column.name),
    ).toEqual(["site_id", "asset_id"]);
    expect(
      config.uniqueConstraints
        .find((key) => key.name === "gift_media_publication_claim_key")
        ?.columns.map((column) => column.name),
    ).toEqual(["site_id", "asset_id", "processing_id"]);
    expect(
      config.uniqueConstraints
        .find((key) => key.name === "gift_media_publication_object_key")
        ?.columns.map((column) => column.name),
    ).toEqual(["storage_namespace", "derivative_key"]);
    expect(config.checks.map((check) => check.name)).toContain(
      "gift_media_publication_observation_check",
    );
  });
  it("exposes reviewed financial tables through the actual schema entrypoint", () => {
    for (const name of [
      "receivingAccount",
      "receivingDestination",
      "receivingVerificationEvidence",
      "giftQuoteRecord",
      "giftOrder",
      "giftCheckoutAttempt",
      "giftPaymentRecord",
      "financialOperation",
      "financialEventInbox",
      "financialLedgerEntry",
      "withdrawalIntent",
    ]) {
      expect(registeredSchema).toHaveProperty(name);
    }
  });
  it("supports site assistants without granting legacy users recipient authority", () => {
    expect(adminRole.enumValues).toContain("SITE_ASSISTANT");
    expect(siteMembership.role.notNull).toBe(true);
    expect(siteMembership.role.default).toBe("SITE_ADMIN");
    expect(siteMembership.revokedAt.notNull).toBe(false);
    expect(siteMembership.invitedByUserId.notNull).toBe(false);
    expect(Object.hasOwn(siteMembership, "designatedRecipient")).toBe(false);
  });

  it("keeps per-site membership uniqueness while allowing another wedding", () => {
    const indexes = getTableConfig(siteMembership).indexes.map(
      (index) => index.config.name,
    );
    expect(indexes).toContain("site_membership_site_id_user_id_idx");
    expect(indexes).not.toContain("site_membership_user_id_idx");
  });

  it("binds restricted invitation tokens to the server-selected site and issuer", () => {
    expect(siteAssessorInvitation.siteId.notNull).toBe(true);
    expect(siteAssessorInvitation.invitedByUserId.notNull).toBe(true);
    expect(siteAssessorInvitation.role.default).toBe("SITE_ASSISTANT");
    expect(siteAssessorInvitation.inviteeName.notNull).toBe(true);
    const config = getTableConfig(siteAssessorInvitation);
    expect(config.indexes.map((index) => index.config.name)).toContain(
      "site_assessor_invitation_token_hash_idx",
    );
    expect(config.checks.map((check) => check.name)).toContain(
      "site_assessor_invitation_role_check",
    );
  });

  it("keeps catalog media site-bound and private staging distinct from immutable derivatives", () => {
    expect(giftItem.nominalCents.notNull).toBe(true);
    expect(giftItem.currency.default).toBe("BRL");
    expect(giftItem.publicationState.default).toBe("DRAFT");
    const config = getTableConfig(giftItem);
    const mediaKey = config.foreignKeys.find(
      (key) => key.reference().name === "gift_item_site_media_fk",
    );
    expect(mediaKey?.reference().columns.map((column) => column.name)).toEqual([
      "site_id",
      "media_asset_id",
    ]);
    expect(mediaKey?.onDelete).toBe("restrict");
    expect(giftMediaAsset.stagingKey.notNull).toBe(true);
    expect(giftMediaAsset.derivativeKey.notNull).toBe(false);
    expect(giftMediaAsset.stableObjectVersion.notNull).toBe(false);
    expect(
      getTableConfig(giftMediaAsset).checks.map((check) => check.name),
    ).toContain("gift_media_asset_finalized_check");
  });

  it("separates declarations from decoded metadata and requires a durable processing claim", () => {
    expect(giftMediaState.enumValues).toContain("PROCESSING");
    expect(giftMediaAsset.declaredContentType).toBeDefined();
    expect(giftMediaAsset.declaredByteLength).toBeDefined();
    expect(giftMediaAsset.processingId).toBeDefined();
    expect(giftMediaAsset.processingExpiresAt).toBeDefined();
    expect(
      getTableConfig(giftMediaAsset).checks.map((check) => check.name),
    ).toContain("gift_media_asset_processing_claim_check");
  });

  it("orders the referenced composite unique index before its new foreign key", () => {
    const sql = readFileSync(
      new URL(
        "../migrations/0012_internal_gifts_foundation.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const mediaUnique = sql.indexOf(
      'CREATE UNIQUE INDEX "gift_media_asset_site_id_id_idx"',
    );
    const mediaReference = sql.indexOf(
      'ADD CONSTRAINT "gift_item_site_media_fk"',
    );
    expect(mediaUnique).toBeGreaterThanOrEqual(0);
    expect(mediaReference).toBeGreaterThan(mediaUnique);
    expect(sql).toContain(
      'ADD COLUMN "role" "site_membership_role" DEFAULT \'SITE_ADMIN\' NOT NULL',
    );
    expect(sql).not.toMatch(
      /DROP\s+(?:TABLE|COLUMN|TYPE)|DELETE\s+FROM|TRUNCATE/i,
    );
    expect(sql.match(/DROP INDEX[^;]+/g)).toEqual([
      'DROP INDEX "site_membership_user_id_idx"',
    ]);
    const snapshot = JSON.parse(
      readFileSync(
        new URL("../migrations/meta/0012_snapshot.json", import.meta.url),
        "utf8",
      ),
    );
    expect(snapshot.tables["public.site_membership"].indexes).toHaveProperty(
      "site_membership_site_id_user_id_idx",
    );
    expect(
      snapshot.tables["public.site_membership"].indexes,
    ).not.toHaveProperty("site_membership_user_id_idx");
  });
});
