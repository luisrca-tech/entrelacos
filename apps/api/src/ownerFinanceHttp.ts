import {
  ownerFinanceAlertListQuerySchema,
  ownerFinanceAlertListResponseSchema,
  ownerFinanceAlertResolveInputSchema,
  ownerFinanceGiftListQuerySchema,
  ownerFinanceGiftListResponseSchema,
  ownerFinanceSiteListResponseSchema,
  ownerFinanceSummaryQuerySchema,
  ownerFinanceSummarySchema,
} from "@entrelacos/contracts";
import { Hono } from "hono";
import { trustedAdminOrigin } from "./adminOrigin";
import type { AuthHttpOptions } from "./authHttp";
import { AdminSessionRequiredError, requireAdminSession } from "./authHttp";
import {
  listOwnerFinanceAlerts,
  listOwnerFinanceGifts,
  listOwnerFinanceSites,
  readOwnerFinanceSummary,
  resolveOwnerFinanceAlert,
} from "./ownerFinanceRepository";

export const ownerFinanceHttpPaths = {
  summary: "/v1/owner/finance/summary",
  gifts: "/v1/owner/finance/gifts",
  sites: "/v1/owner/finance/sites",
  alerts: "/v1/owner/finance/alerts",
  resolveAlert: "/v1/owner/finance/alerts/:id/resolve",
} as const;

const noStore = { "Cache-Control": "no-store" };

function problem(status: number, code: string, title: string): Response {
  return new Response(
    JSON.stringify({ type: "about:blank", title, status, code }),
    {
      status,
      headers: { ...noStore, "Content-Type": "application/problem+json" },
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

/**
 * Query string as an object for Zod: `siteId` may repeat and stays a list;
 * any other repeated key is kept as a list so the strict schema rejects it.
 */
function queryInput(url: string): Record<string, string | string[]> {
  const params = new URL(url).searchParams;
  const input: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    input[key] = key === "siteId" || values.length > 1 ? values : values[0];
  }
  return input;
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

  router.get(ownerFinanceHttpPaths.summary, async (context) => {
    const denied = await requireOwner(context.req.raw, options);
    if (denied) return denied;
    const query = ownerFinanceSummaryQuerySchema.safeParse(
      queryInput(context.req.url),
    );
    if (!query.success)
      return problem(400, "VALIDATION_ERROR", "Invalid query");
    const summary = await readOwnerFinanceSummary(options.db, query.data);
    return context.json(ownerFinanceSummarySchema.parse(summary), 200, noStore);
  });

  router.get(ownerFinanceHttpPaths.gifts, async (context) => {
    const denied = await requireOwner(context.req.raw, options);
    if (denied) return denied;
    const query = ownerFinanceGiftListQuerySchema.safeParse(
      queryInput(context.req.url),
    );
    if (!query.success)
      return problem(400, "VALIDATION_ERROR", "Invalid query");
    const page = await listOwnerFinanceGifts(options.db, query.data);
    return context.json(
      ownerFinanceGiftListResponseSchema.parse(page),
      200,
      noStore,
    );
  });

  router.get(ownerFinanceHttpPaths.sites, async (context) => {
    const denied = await requireOwner(context.req.raw, options);
    if (denied) return denied;
    if (new URL(context.req.url).search)
      return problem(400, "VALIDATION_ERROR", "Invalid query");
    const sites = await listOwnerFinanceSites(options.db);
    return context.json(
      ownerFinanceSiteListResponseSchema.parse(sites),
      200,
      noStore,
    );
  });

  router.get(ownerFinanceHttpPaths.alerts, async (context) => {
    const denied = await requireOwner(context.req.raw, options);
    if (denied) return denied;
    const query = ownerFinanceAlertListQuerySchema.safeParse(
      queryInput(context.req.url),
    );
    if (!query.success)
      return problem(400, "VALIDATION_ERROR", "Invalid query");
    const page = await listOwnerFinanceAlerts(options.db, query.data);
    return context.json(
      ownerFinanceAlertListResponseSchema.parse(page),
      200,
      noStore,
    );
  });

  router.post(ownerFinanceHttpPaths.resolveAlert, async (context) => {
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
    return context.body(null, 204, noStore);
  });

  return router;
}
