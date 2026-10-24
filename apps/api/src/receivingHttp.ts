import {
  type ReceivingReadiness,
  receivingReadinessResponseSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import { Hono } from "hono";
import { trustedAdminOrigin } from "./adminOrigin";
import { type AuthHttpOptions, requireAdminSession } from "./authHttp";
import { createDefaultReceivingReadiness } from "./receivingReadiness";
import { resolveSiteAccess } from "./siteAccess";

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
  readReadiness?: (siteId: string) => Promise<ReceivingReadiness>;
};

export function createReceivingHttpRouter(options: ReceivingHttpOptions): Hono {
  const router = new Hono();
  router.onError(() =>
    problem(503, "SERVICE_UNAVAILABLE", "Receiving status unavailable"),
  );
  router.get("/v1/sites/:siteId/receiving/readiness", async (context) => {
    if (
      !trustedAdminOrigin(context.req.header("origin"), options.adminOrigin)
    ) {
      return problem(403, "FORBIDDEN", "Forbidden");
    }
    const siteId = siteIdSchema.safeParse(context.req.param("siteId"));
    if (!siteId.success)
      return problem(400, "VALIDATION_ERROR", "Invalid site identifier");
    let actor: Awaited<ReturnType<typeof requireAdminSession>>;
    try {
      actor = await requireAdminSession(context.req.raw, options);
    } catch {
      return problem(401, "UNAUTHORIZED", "Authentication required");
    }
    const access = await resolveSiteAccess(options.db, {
      userId: actor.user.id,
      platformRole: actor.user.role,
      siteId: siteId.data,
    });
    if (!access)
      return problem(403, "MEMBERSHIP_DENIED", "Site membership denied");
    const readiness = options.readReadiness
      ? await options.readReadiness(siteId.data)
      : createDefaultReceivingReadiness(siteId.data);
    const response = receivingReadinessResponseSchema.safeParse({ readiness });
    if (!response.success || response.data.readiness.siteId !== siteId.data) {
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
