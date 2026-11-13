import {
  ownerFinanceAlertListQuerySchema,
  ownerFinanceAlertListResponseSchema,
  ownerFinanceAlertResolveInputSchema,
  ownerFinanceSummaryQuerySchema,
  ownerFinanceSummarySchema,
} from "@entrelacos/contracts";
import { Hono } from "hono";
import { trustedAdminOrigin } from "./adminOrigin";
import type { AuthHttpOptions } from "./authHttp";
import { AdminSessionRequiredError, requireAdminSession } from "./authHttp";
import {
  listOwnerFinanceAlerts,
  readOwnerFinanceSummary,
  resolveOwnerFinanceAlert,
} from "./ownerFinanceRepository";

function problem(status: number, code: string, title: string): Response {
  return new Response(
    JSON.stringify({ type: "about:blank", title, status, code }),
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      },
    },
  );
}

// Same guard as adminAccessHttp: trusted origin plus a verified OWNER session.
async function requireOwner(
  request: Request,
  options: AuthHttpOptions,
): Promise<Response | null> {
  if (!trustedAdminOrigin(request.headers.get("origin"), options.adminOrigin))
    return problem(403, "FORBIDDEN", "Forbidden");
  try {
    const actor = await requireAdminSession(request, options);
    return actor.user.role === "OWNER"
      ? null
      : problem(403, "FORBIDDEN", "Forbidden");
  } catch (error) {
    if (error instanceof AdminSessionRequiredError)
      return problem(401, "UNAUTHORIZED", "Authentication required");
    throw error;
  }
}

async function readObject(request: Request): Promise<unknown> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    return undefined;
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export function createOwnerFinanceHttpRouter(options: AuthHttpOptions): Hono {
  const router = new Hono();
  const now = () => options.now?.() ?? new Date();
  router.onError(() =>
    problem(503, "SERVICE_UNAVAILABLE", "Service unavailable"),
  );

  router.get("/v1/owner/finance/summary", async (context) => {
    const denied = await requireOwner(context.req.raw, options);
    if (denied) return denied;
    const query = ownerFinanceSummaryQuerySchema.safeParse(context.req.query());
    if (!query.success)
      return problem(400, "VALIDATION_ERROR", "Invalid query");
    const summary = await readOwnerFinanceSummary(options.db, {
      from: query.data.from ? new Date(query.data.from) : undefined,
      to: query.data.to ? new Date(query.data.to) : undefined,
      now: now(),
    });
    return context.json(ownerFinanceSummarySchema.parse(summary), 200, {
      "Cache-Control": "no-store",
    });
  });

  router.get("/v1/owner/finance/alerts", async (context) => {
    const denied = await requireOwner(context.req.raw, options);
    if (denied) return denied;
    const query = ownerFinanceAlertListQuerySchema.safeParse(
      context.req.query(),
    );
    if (!query.success)
      return problem(400, "VALIDATION_ERROR", "Invalid query");
    const alerts = await listOwnerFinanceAlerts(options.db, query.data.status);
    return context.json(
      ownerFinanceAlertListResponseSchema.parse({ alerts }),
      200,
      { "Cache-Control": "no-store" },
    );
  });

  router.post("/v1/owner/finance/alerts/:id/resolve", async (context) => {
    const denied = await requireOwner(context.req.raw, options);
    if (denied) return denied;
    const body = ownerFinanceAlertResolveInputSchema.safeParse(
      await readObject(context.req.raw),
    );
    if (!body.success) return problem(400, "VALIDATION_ERROR", "Invalid body");
    const resolved = await resolveOwnerFinanceAlert(options.db, {
      id: context.req.param("id"),
      note: body.data.note,
      now: now(),
    });
    if (!resolved) return problem(404, "NOT_FOUND", "Alert not found");
    return context.body(null, 204, { "Cache-Control": "no-store" });
  });

  return router;
}
