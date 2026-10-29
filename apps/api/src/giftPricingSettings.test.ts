import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  loadGiftPricingSettings,
  readGiftPricingSettings,
  updateGiftPricingSettings,
} from "./giftPricingSettings";
import { createGiftsHttpRouter } from "./giftsHttp";

function fixture(role = "SITE_ADMIN", siteId = "site-a") {
  let revision = 0;
  let feeAllocation = "RECIPIENT_DEDUCTED";
  const queries: string[] = [];
  const db = {
    execute: vi.fn(async (query: SQL) => {
      const { sql, params } = new PgDialect().sqlToQuery(query);
      queries.push(sql);
      if (sql.includes('FROM "user"'))
        return {
          rows:
            siteId === "site-a"
              ? [
                  {
                    user_id: "admin",
                    account_role: role,
                    account_state: "ACTIVE",
                    site_id: siteId,
                    membership_id: "member",
                    membership_user_id: "admin",
                    membership_role: role,
                    revoked_at: null,
                  },
                ]
              : [],
        };
      if (sql.includes("INSERT INTO gift_pricing_settings")) {
        if (params[params.length - 1] !== revision) return { rows: [] };
        feeAllocation = params[0] as string;
        revision++;
      }
      return {
        rows: [{ site_id: siteId, fee_allocation: feeAllocation, revision }],
      };
    }),
  } as never;
  (db as unknown as { transaction: unknown }).transaction = async (
    run: (tx: unknown) => unknown,
  ) => run(db);
  return { db, queries };
}
const actor = { userId: "admin", role: "SITE_ADMIN" as const };
const input = { feeAllocation: "BUYER_GROSS_UP" as const, revision: 0 };

describe("gift pricing settings", () => {
  it("rechecks revoked access after waiting for the site lock", async () => {
    const f = fixture();
    const execute = (f.db as unknown as { execute: ReturnType<typeof vi.fn> })
      .execute;
    const original = execute.getMockImplementation();
    let reads = 0;
    execute.mockImplementation(async (query: SQL) => {
      if (
        new PgDialect().sqlToQuery(query).sql.includes('FROM "user"') &&
        reads++ > 0
      )
        return { rows: [] };
      return original?.(query);
    });
    await expect(
      updateGiftPricingSettings(f.db, actor, "site-a", input),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.queries.some((query) => query.includes("INSERT"))).toBe(false);
  });
  it("defaults to recipient deducted and saves a blocked buyer preference with revision", async () => {
    const f = fixture();
    expect(await readGiftPricingSettings(f.db, "site-a")).toMatchObject({
      siteId: "site-a",
      feeAllocation: "RECIPIENT_DEDUCTED",
      revision: 0,
      buyerGrossUpAvailable: false,
    });
    expect(
      await updateGiftPricingSettings(f.db, actor, "site-a", input),
    ).toMatchObject({
      settings: {
        feeAllocation: "BUYER_GROSS_UP",
        revision: 1,
        buyerGrossUpAvailable: false,
      },
    });
    expect(
      await updateGiftPricingSettings(f.db, actor, "site-a", {
        feeAllocation: "RECIPIENT_DEDUCTED",
        revision: 1,
      }),
    ).toMatchObject({
      settings: { revision: 2, feeAllocation: "RECIPIENT_DEDUCTED" },
    });
    await expect(
      updateGiftPricingSettings(f.db, actor, "site-a", input),
    ).rejects.toMatchObject({
      status: 409,
      code: "GIFT_PRICING_SETTINGS_CONFLICT",
    });
  });
  it("denies assistants and another site before reading settings", async () => {
    const f = fixture("SITE_ASSISTANT");
    await expect(
      loadGiftPricingSettings(
        f.db,
        { userId: "admin", role: "SITE_ASSISTANT" },
        "site-a",
      ),
    ).rejects.toMatchObject({ status: 403 });
    const other = fixture("SITE_ADMIN", "site-b");
    await expect(
      updateGiftPricingSettings(other.db, actor, "site-b", input),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.queries.some((q) => q.includes("gift_pricing_settings"))).toBe(
      false,
    );
    expect(other.queries.some((q) => q.includes("gift_pricing_settings"))).toBe(
      false,
    );
  });
  it("allows owner access and rejects tampered payloads before any write", async () => {
    const f = fixture("OWNER");
    expect(
      await loadGiftPricingSettings(
        f.db,
        { userId: "admin", role: "OWNER" },
        "site-a",
      ),
    ).toHaveProperty("settings.siteId", "site-a");
    await expect(
      updateGiftPricingSettings(
        f.db,
        { userId: "admin", role: "OWNER" },
        "site-a",
        { ...input, buyerGrossUpAvailable: true } as never,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(f.queries.some((q) => q.includes("INSERT"))).toBe(false);
  });
});

describe("pricing settings HTTP boundaries", () => {
  it("requires a trusted origin and authenticated session for GET and PATCH", async () => {
    const f = fixture();
    const router = createGiftsHttpRouter({
      db: f.db,
      auth: { api: { getSession: async () => null } } as never,
      adminOrigin: "https://panel.example.test",
    });
    for (const method of ["GET", "PATCH"]) {
      expect(
        (
          await router.request("/v1/sites/site-a/gift-pricing-settings", {
            method,
            headers: { origin: "https://attacker.example.test" },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await router.request("/v1/sites/site-a/gift-pricing-settings", {
            method,
            headers: { origin: "https://panel.example.test" },
          })
        ).status,
      ).toBe(401);
    }
    expect(f.queries).toEqual([]);
  });
});

it("locks the site before the atomic preference write", async () => {
  const f = fixture();
  await updateGiftPricingSettings(f.db, actor, "site-a", input);
  const lock = f.queries.findIndex((query) => query.includes("FOR UPDATE"));
  const write = f.queries.findIndex((query) =>
    query.includes("INSERT INTO gift_pricing_settings"),
  );
  expect(lock).toBeGreaterThanOrEqual(0);
  expect(lock).toBeLessThan(write);
});
