import {
  type ReceivingReadiness,
  receivingReadinessResponseSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import { Hono } from "hono";
import { trustedAdminOrigin } from "./adminOrigin";
import { type AuthHttpOptions, requireAdminSession } from "./authHttp";
import { createDefaultReceivingReadiness } from "./receivingReadiness";
import { readShowcaseCatalogAccess } from "./showcaseCatalog";
import { resolveSiteAccess } from "./siteAccess";
import { readSiteHomeSummary } from "./siteHomeSummary";

function problem(status: number, code: string, title: string): Response {
  return new Response(
    JSON.stringify({ type: "about:blank", status, code, title }),
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      },
    },
  );
}

export type ReceivingHttpOptions = AuthHttpOptions & {
  applicationEnvironment?: "development" | "test" | "production";
  readReadiness?: (siteId: string) => Promise<ReceivingReadiness>;
};

export function createReceivingHttpRouter(options: ReceivingHttpOptions): Hono {
  const router = new Hono();
  router.onError(() =>
    problem(503, "SERVICE_UNAVAILABLE", "Receiving status unavailable"),
  );
  async function resolveReadAccess(request: Request, rawSiteId: string) {
    if (!trustedAdminOrigin(request.headers.get("origin"), options.adminOrigin))
      return problem(403, "FORBIDDEN", "Forbidden");
    const siteId = siteIdSchema.safeParse(rawSiteId);
    if (!siteId.success)
      return problem(400, "VALIDATION_ERROR", "Invalid site identifier");
    let actor: Awaited<ReturnType<typeof requireAdminSession>>;
    try {
      actor = await requireAdminSession(request, options);
    } catch {
      return problem(401, "UNAUTHORIZED", "Authentication required");
    }
    const access = await resolveSiteAccess(options.db, {
      userId: actor.user.id,
      platformRole: actor.user.role,
      siteId: siteId.data,
    });
    return (
      access ?? problem(403, "MEMBERSHIP_DENIED", "Site membership denied")
    );
  }
  const readReadiness =
    options.readReadiness ??
    (async (siteId: string) => createDefaultReceivingReadiness(siteId));

  router.get("/v1/sites/:siteId/home-summary", async (context) => {
    const access = await resolveReadAccess(
      context.req.raw,
      context.req.param("siteId"),
    );
    if (access instanceof Response) return access;
    if (Object.keys(context.req.query()).length)
      return problem(400, "VALIDATION_ERROR", "Invalid home summary query");
    const summary = await readSiteHomeSummary(
      options.db,
      access,
      readReadiness,
    );
    return context.json(summary, 200, { "Cache-Control": "no-store" });
  });
  router.get("/v1/sites/:siteId/receiving/readiness", async (context) => {
    const siteId = context.req.param("siteId");
    const access = await resolveReadAccess(context.req.raw, siteId);
    if (access instanceof Response) return access;
    const readiness = await readReadiness(siteId);
    const catalogAccess =
      !readiness.catalogEligible && access.capabilities?.manageCatalog
        ? await readShowcaseCatalogAccess(
            options.db,
            siteId,
            options.applicationEnvironment,
          )
        : undefined;
    const response = receivingReadinessResponseSchema.safeParse({
      readiness,
      ...(catalogAccess ? { catalogAccess } : {}),
    });
    if (!response.success || response.data.readiness.siteId !== siteId) {
      return problem(
        503,
        "SERVICE_UNAVAILABLE",
        "Receiving status unavailable",
      );
    }
    return context.json(response.data, 200, { "Cache-Control": "no-store" });
  });
  return router;
}
