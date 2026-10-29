import {
  giftCatalogLimits,
  giftCatalogResponseSchema,
  giftCreateInputSchema,
  giftItemResponseSchema,
  giftItemSchema,
  giftPublishInputSchema,
  giftReorderInputSchema,
  giftUpdateInputSchema,
  publicGiftCatalogPageResponseSchema,
  publicGiftCatalogQuerySchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import { siteOrigin } from "@entrelacos/database/schema";
import { and, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  type GiftPricingSettings,
  giftPricingPreviewInputSchema,
  giftPricingSettingsInputSchema,
  giftPricingSettingsResponseSchema,
} from "../../../packages/contracts/src/giftPricingSettings";
import { trustedAdminOrigin } from "./adminOrigin";
import {
  AdminSessionRequiredError,
  type AuthHttpOptions,
  requireAdminSession,
} from "./authHttp";
import {
  loadGiftPricingSettings,
  updateGiftPricingSettings,
} from "./giftPricingSettings";
import {
  createSiteGift,
  GiftServiceError,
  type GiftServiceOptions,
  listSiteGifts,
  readPublicGifts,
  reorderSiteGifts,
  updateSiteGift,
  updateSiteGiftPublication,
} from "./gifts";
import { allowsLocalPublicOrigin } from "./localPublicOrigin";
import { type SiteAccessActor, SiteAccessDeniedError } from "./siteAccess";

export type GiftsHttpOptions = AuthHttpOptions & {
  readPricingSettings?: (siteId: string) => Promise<GiftPricingSettings>;
  previewPricing?: (siteId: string, input: unknown) => Promise<unknown>;
} & Pick<
    GiftServiceOptions,
    "readReadiness" | "applicationEnvironment" | "liveDemoSiteId"
  >;

function problem(
  context: Context,
  status: number,
  code: string,
  title: string,
): Response {
  return context.newResponse(
    JSON.stringify({ type: "about:blank", status, code, title }),
    status as ContentfulStatusCode,
    { "Content-Type": "application/problem+json", "Cache-Control": "no-store" },
  );
}
async function readBody(request: Request): Promise<unknown> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    return undefined;
  return request.json().catch(() => undefined);
}

function readCatalogQuery(url: string) {
  const raw = url.includes("?")
    ? url.slice(url.indexOf("?") + 1).split("#")[0]
    : "";
  const invalidQuery = () => {
    throw new GiftServiceError(
      400,
      "VALIDATION_ERROR",
      "Invalid catalog query",
    );
  };
  if (new TextEncoder().encode(raw).byteLength > giftCatalogLimits.queryBytes)
    invalidQuery();
  const input: { page?: number; q?: string } = {};
  const seen = new Set<string>();
  try {
    for (const pair of raw ? raw.split("&") : []) {
      const separator = pair.indexOf("=");
      const key = decodeURIComponent(
        (separator < 0 ? pair : pair.slice(0, separator)).replace(/\+/g, " "),
      );
      const value = separator < 0 ? "" : pair.slice(separator + 1);
      if (!["page", "q"].includes(key) || seen.has(key)) invalidQuery();
      seen.add(key);
      if (key === "page") {
        if (!/^[1-9][0-9]*$/.test(value)) invalidQuery();
        input.page = Number(value);
      } else input.q = decodeURIComponent(value.replace(/\+/g, " "));
    }
    const parsed = publicGiftCatalogQuerySchema.safeParse(input);
    if (!parsed.success) return invalidQuery();
    return parsed.data;
  } catch {
    return invalidQuery();
  }
}
export function createGiftsHttpRouter(options: GiftsHttpOptions) {
  const router = new Hono<{ Variables: { actor: SiteAccessActor } }>();
  const services: GiftServiceOptions = {
    readReadiness: options.readReadiness,
    applicationEnvironment: options.applicationEnvironment,
    liveDemoSiteId: options.liveDemoSiteId,
    now: options.now,
  };
  router.onError((error, context) => {
    if (error instanceof AdminSessionRequiredError)
      return problem(context, 401, "UNAUTHORIZED", "Authentication required");
    if (error instanceof SiteAccessDeniedError)
      return problem(
        context,
        403,
        "MEMBERSHIP_DENIED",
        "Site membership denied",
      );
    if (error instanceof GiftServiceError)
      return problem(
        context,
        error.status,
        error.code,
        "Gift operation rejected",
      );
    return problem(
      context,
      503,
      "SERVICE_UNAVAILABLE",
      "Gift service unavailable",
    );
  });
  router.use("/v1/sites/:siteId/*", async (context, next) => {
    if (!trustedAdminOrigin(context.req.header("origin"), options.adminOrigin))
      return problem(context, 403, "FORBIDDEN", "Forbidden");
    if (!siteIdSchema.safeParse(context.req.param("siteId")).success)
      return problem(
        context,
        400,
        "VALIDATION_ERROR",
        "Invalid site identifier",
      );
    const actor = await requireAdminSession(context.req.raw, options);
    context.set("actor", { userId: actor.user.id, role: actor.user.role });
    context.header("Cache-Control", "no-store");
    await next();
  });
  router.use("/v1/public/sites/:siteId/*", async (context, next) => {
    const siteId = siteIdSchema.safeParse(context.req.param("siteId"));
    if (!siteId.success)
      return problem(
        context,
        400,
        "VALIDATION_ERROR",
        "Invalid site identifier",
      );
    const origin = context.req.header("origin");
    if (!origin) return problem(context, 403, "FORBIDDEN", "Forbidden");
    if (!allowsLocalPublicOrigin(context.req.url, origin)) {
      const rows = await options.db
        .select({ id: siteOrigin.id })
        .from(siteOrigin)
        .where(
          and(
            eq(siteOrigin.siteId, siteId.data),
            eq(siteOrigin.origin, origin),
          ),
        )
        .limit(1);
      if (rows.length !== 1)
        return problem(context, 403, "FORBIDDEN", "Forbidden");
    }
    context.header("Access-Control-Allow-Origin", origin);
    context.header("Vary", "Origin");
    context.header("Cache-Control", "no-store");
    await next();
  });
  router.options("/v1/public/sites/:siteId/gifts", (context) => {
    context.header("Access-Control-Allow-Methods", "GET");
    context.header("Access-Control-Allow-Headers", "Content-Type");
    return context.newResponse(null, 204);
  });
  router.get("/v1/public/sites/:siteId/gifts", async (context) => {
    const siteId = context.req.param("siteId");
    const query = readCatalogQuery(context.req.url);
    const catalog = await readPublicGifts(options.db, siteId, services, query);
    const settings = options.readPricingSettings
      ? await options.readPricingSettings(siteId)
      : undefined;
    const page = publicGiftCatalogPageResponseSchema.safeParse(
      settings
        ? {
            ...catalog,
            gifts: catalog.gifts.map((gift) => ({
              ...gift,
              pricing: {
                feeAllocation: settings.feeAllocation,
                available: settings.feeAllocation === "RECIPIENT_DEDUCTED",
              },
            })),
          }
        : catalog,
    );
    if (
      !page.success ||
      page.data.siteId !== siteId ||
      page.data.page !== query.page ||
      page.data.q !== query.q
    )
      throw new GiftServiceError(
        503,
        "SERVICE_UNAVAILABLE",
        "Gift catalog unavailable",
      );
    const serialized = JSON.stringify(page.data);
    if (
      new TextEncoder().encode(serialized).byteLength >
      giftCatalogLimits.jsonBytes
    )
      throw new GiftServiceError(
        503,
        "SERVICE_UNAVAILABLE",
        "Gift catalog unavailable",
      );
    return context.newResponse(serialized, 200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
  });
  router.get("/v1/sites/:siteId/gifts", async (context) =>
    context.json(
      giftCatalogResponseSchema.parse(
        await listSiteGifts(
          options.db,
          context.get("actor"),
          context.req.param("siteId"),
          services,
        ),
      ),
    ),
  );
  router.post("/v1/sites/:siteId/gifts", async (context) => {
    const body = giftCreateInputSchema.safeParse(
      await readBody(context.req.raw),
    );
    if (!body.success)
      return problem(context, 400, "VALIDATION_ERROR", "Invalid gift payload");
    return context.json(
      giftItemResponseSchema.parse(
        await createSiteGift(
          options.db,
          context.get("actor"),
          context.req.param("siteId"),
          body.data,
          services,
        ),
      ),
      201,
    );
  });
  router.patch("/v1/sites/:siteId/gifts/:giftId", async (context) => {
    const id = giftItemSchema.shape.id.safeParse(context.req.param("giftId"));
    const body = giftUpdateInputSchema.safeParse(
      await readBody(context.req.raw),
    );
    if (!id.success || !body.success)
      return problem(context, 400, "VALIDATION_ERROR", "Invalid gift update");
    return context.json(
      giftItemResponseSchema.parse(
        await updateSiteGift(
          options.db,
          context.get("actor"),
          context.req.param("siteId"),
          id.data,
          body.data,
          services,
        ),
      ),
    );
  });
  router.patch(
    "/v1/sites/:siteId/gifts/:giftId/publication",
    async (context) => {
      const id = giftItemSchema.shape.id.safeParse(context.req.param("giftId"));
      const body = giftPublishInputSchema.safeParse(
        await readBody(context.req.raw),
      );
      if (!id.success || !body.success)
        return problem(
          context,
          400,
          "VALIDATION_ERROR",
          "Invalid gift publication",
        );
      return context.json(
        giftItemResponseSchema.parse(
          await updateSiteGiftPublication(
            options.db,
            context.get("actor"),
            context.req.param("siteId"),
            id.data,
            body.data,
            services,
          ),
        ),
      );
    },
  );
  router.post("/v1/sites/:siteId/gifts/reorder", async (context) => {
    const body = giftReorderInputSchema.safeParse(
      await readBody(context.req.raw),
    );
    if (!body.success)
      return problem(context, 400, "VALIDATION_ERROR", "Invalid gift order");
    return context.json(
      giftCatalogResponseSchema.parse(
        await reorderSiteGifts(
          options.db,
          context.get("actor"),
          context.req.param("siteId"),
          body.data,
          services,
        ),
      ),
    );
  });
  router.get("/v1/sites/:siteId/gift-pricing-settings", async (context) =>
    context.json(
      giftPricingSettingsResponseSchema.parse(
        await loadGiftPricingSettings(
          options.db,
          context.get("actor"),
          context.req.param("siteId"),
        ),
      ),
    ),
  );
  router.patch("/v1/sites/:siteId/gift-pricing-settings", async (context) => {
    const body = giftPricingSettingsInputSchema.safeParse(
      await readBody(context.req.raw),
    );
    if (!body.success)
      return problem(
        context,
        400,
        "VALIDATION_ERROR",
        "Invalid pricing settings",
      );
    return context.json(
      giftPricingSettingsResponseSchema.parse(
        await updateGiftPricingSettings(
          options.db,
          context.get("actor"),
          context.req.param("siteId"),
          body.data,
        ),
      ),
    );
  });
  router.post("/v1/sites/:siteId/gift-pricing-preview", async (context) => {
    const body = giftPricingPreviewInputSchema.safeParse(
      await readBody(context.req.raw),
    );
    if (!body.success)
      return problem(
        context,
        400,
        "VALIDATION_ERROR",
        "Invalid pricing preview",
      );
    const siteId = context.req.param("siteId");
    await loadGiftPricingSettings(options.db, context.get("actor"), siteId);
    if (!options.previewPricing)
      return problem(
        context,
        503,
        "SERVICE_UNAVAILABLE",
        "Pricing preview unavailable",
      );
    return context.json(
      (await options.previewPricing(siteId, body.data)) as Record<
        string,
        unknown
      >,
    );
  });
  return router;
}
