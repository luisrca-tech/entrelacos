import {
  adminRsvpWriteInputSchema,
  familyRsvpResponseSchema,
  familyRsvpWriteInputSchema,
  rsvpDeadlineSchema,
  rsvpHistoryQuerySchema,
  rsvpHistoryResponseSchema,
  rsvpWriteResponseSchema,
  siteRsvpQuerySchema,
  siteRsvpResponseSchema,
} from "@entrelacos/contracts";
import { familySession, siteOrigin } from "@entrelacos/database/schema";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { AuthHttpOptions } from "./authHttp";
import { AdminSessionRequiredError, requireAdminSession } from "./authHttp";
import { hashFamilySessionToken } from "./familySession";
import { allowsLocalPublicOrigin } from "./localPublicOrigin";
import {
  listRsvpHistory,
  type RsvpAdminActor,
  RsvpServiceError,
  readFamilyRsvp,
  readRsvpDeadline,
  readSiteRsvp,
  updateRsvpDeadline,
  writeAdminRsvp,
  writeFamilyRsvp,
} from "./rsvp";

function problem(
  status: number,
  code: string,
  title: string,
  details?: Record<string, unknown>,
): Response {
  const body: Record<string, unknown> = {
    type: "about:blank",
    title,
    status,
    code,
  };
  if (details !== undefined) body.details = details;
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/problem+json",
    },
  });
}

function trustedAdminOrigin(request: Request, adminOrigin: string): boolean {
  return request.headers.get("origin") === adminOrigin;
}

async function readObject(request: Request): Promise<unknown> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    return undefined;
  }
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function queryObject(request: Request): Record<string, string> {
  return Object.fromEntries(new URL(request.url).searchParams.entries());
}

async function requireAdminActor(
  request: Request,
  options: AuthHttpOptions,
): Promise<Response | RsvpAdminActor> {
  if (!trustedAdminOrigin(request, options.adminOrigin)) {
    return problem(403, "FORBIDDEN", "Forbidden");
  }
  try {
    const actor = await requireAdminSession(request, options);
    return { userId: actor.user.id, role: actor.user.role };
  } catch (error) {
    if (error instanceof AdminSessionRequiredError) {
      return problem(401, "UNAUTHORIZED", "Authentication required");
    }
    throw error;
  }
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

function serviceError(error: unknown): Response | undefined {
  if (error instanceof RsvpServiceError) {
    return problem(error.status, error.code, error.title, error.details);
  }
  if (error instanceof Error && error.name === "ZodError") {
    return problem(400, "VALIDATION_ERROR", "Invalid RSVP request");
  }
  return undefined;
}

function responseOrThrow(error: unknown, origin?: string): Response {
  const response = serviceError(error);
  if (!response) throw error;
  return origin ? withCors(response, origin) : response;
}

function bearerToken(request: Request): string | undefined {
  const value = request.headers.get("authorization");
  if (!value) return undefined;
  const [scheme, token, ...extra] = value.trim().split(/\s+/);
  if (scheme !== "Bearer" || !token || extra.length > 0) return undefined;
  return token;
}

async function sessionSiteId(
  options: AuthHttpOptions,
  token: string | undefined,
): Promise<string | undefined> {
  if (!token) return undefined;
  const rows = await options.db
    .select({ siteId: familySession.siteId })
    .from(familySession)
    .where(eq(familySession.tokenHash, hashFamilySessionToken(token)))
    .limit(1);
  return rows[0]?.siteId;
}

async function isRegisteredOrigin(
  options: AuthHttpOptions,
  request: Request,
  origin: string | undefined,
  siteId?: string,
): Promise<boolean> {
  if (!origin) return false;
  if (allowsLocalPublicOrigin(request.url, origin)) return true;
  const rows = await options.db
    .select({ origin: siteOrigin.origin })
    .from(siteOrigin)
    .where(siteId ? eq(siteOrigin.siteId, siteId) : undefined);
  return rows.some((row) => row.origin === origin);
}

function setCors(context: Context, origin: string): void {
  context.header("Access-Control-Allow-Origin", origin);
  context.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  context.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
  context.header("Access-Control-Max-Age", "600");
  context.header("Vary", "Origin");
  context.header("Cache-Control", "no-store");
}

function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  headers.set("Access-Control-Max-Age", "600");
  headers.set("Vary", "Origin");
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function preflight(context: Context, origin: string): Response {
  setCors(context, origin);
  return new Response(null, { status: 204, headers: context.res.headers });
}

async function requireFamilyRequest(
  request: Request,
  options: AuthHttpOptions,
): Promise<Response | { origin: string; token: string }> {
  const origin = request.headers.get("origin") ?? undefined;
  const token = bearerToken(request);
  const siteId = await sessionSiteId(options, token);
  if (!siteId) {
    if (await isRegisteredOrigin(options, request, origin)) {
      return withCors(
        problem(401, "SESSION_INVALID", "Family session is invalid"),
        origin as string,
      );
    }
    return problem(403, "FORBIDDEN", "Forbidden");
  }
  if (!(await isRegisteredOrigin(options, request, origin, siteId))) {
    return problem(403, "FORBIDDEN", "Forbidden");
  }
  return { origin: origin as string, token: token as string };
}

function familyResponse(
  context: Context,
  value: unknown,
  origin: string,
): Response {
  return withCors(context.json(value, 200), origin);
}

export function createRsvpHttpRouter(options: AuthHttpOptions): Hono {
  const router = new Hono();
  router.onError(
    (error) =>
      serviceError(error) ??
      problem(503, "SERVICE_UNAVAILABLE", "Service unavailable"),
  );

  router.get("/v1/sites/:siteId/rsvp", async (context) => {
    const actor = await requireAdminActor(context.req.raw, options);
    if (isResponse(actor)) return actor;
    try {
      const result = await readSiteRsvp(
        options.db,
        actor,
        context.req.param("siteId"),
        siteRsvpQuerySchema.parse(queryObject(context.req.raw)),
      );
      return context.json(siteRsvpResponseSchema.parse(result), 200, {
        "Cache-Control": "no-store",
      });
    } catch (error) {
      return responseOrThrow(error);
    }
  });

  router.post("/v1/sites/:siteId/rsvp", async (context) => {
    const actor = await requireAdminActor(context.req.raw, options);
    if (isResponse(actor)) return actor;
    try {
      const result = await writeAdminRsvp(
        options.db,
        actor,
        context.req.param("siteId"),
        adminRsvpWriteInputSchema.parse(await readObject(context.req.raw)),
        options.now?.(),
      );
      return context.json(rsvpWriteResponseSchema.parse(result), 200, {
        "Cache-Control": "no-store",
      });
    } catch (error) {
      return responseOrThrow(error);
    }
  });

  router.get("/v1/sites/:siteId/rsvp/deadline", async (context) => {
    const actor = await requireAdminActor(context.req.raw, options);
    if (isResponse(actor)) return actor;
    try {
      const result = await readRsvpDeadline(
        options.db,
        actor,
        context.req.param("siteId"),
      );
      return context.json(rsvpDeadlineSchema.parse(result), 200, {
        "Cache-Control": "no-store",
      });
    } catch (error) {
      return responseOrThrow(error);
    }
  });

  router.patch("/v1/sites/:siteId/rsvp/deadline", async (context) => {
    const actor = await requireAdminActor(context.req.raw, options);
    if (isResponse(actor)) return actor;
    try {
      const result = await updateRsvpDeadline(
        options.db,
        actor,
        context.req.param("siteId"),
        rsvpDeadlineSchema.parse(await readObject(context.req.raw)),
        options.now?.(),
      );
      return context.json(rsvpDeadlineSchema.parse(result), 200, {
        "Cache-Control": "no-store",
      });
    } catch (error) {
      return responseOrThrow(error);
    }
  });

  router.get("/v1/sites/:siteId/rsvp/history", async (context) => {
    const actor = await requireAdminActor(context.req.raw, options);
    if (isResponse(actor)) return actor;
    try {
      const result = await listRsvpHistory(
        options.db,
        actor,
        context.req.param("siteId"),
        rsvpHistoryQuerySchema.parse(queryObject(context.req.raw)),
      );
      return context.json(rsvpHistoryResponseSchema.parse(result), 200, {
        "Cache-Control": "no-store",
      });
    } catch (error) {
      return responseOrThrow(error);
    }
  });

  router.options("/v1/public/family/rsvp", async (context) => {
    const origin = context.req.header("Origin");
    if (!(await isRegisteredOrigin(options, context.req.raw, origin))) {
      return problem(403, "FORBIDDEN", "Forbidden");
    }
    return preflight(context, origin as string);
  });

  router.get("/v1/public/family/rsvp", async (context) => {
    const access = await requireFamilyRequest(context.req.raw, options);
    if (isResponse(access)) return access;
    try {
      const result = await readFamilyRsvp(
        options.db,
        access.token,
        options.now?.(),
      );
      return familyResponse(
        context,
        familyRsvpResponseSchema.parse(result),
        access.origin,
      );
    } catch (error) {
      return responseOrThrow(error, access.origin);
    }
  });

  router.post("/v1/public/family/rsvp", async (context) => {
    const access = await requireFamilyRequest(context.req.raw, options);
    if (isResponse(access)) return access;
    try {
      const result = await writeFamilyRsvp(
        options.db,
        access.token,
        familyRsvpWriteInputSchema.parse(await readObject(context.req.raw)),
        options.now?.(),
      );
      return familyResponse(
        context,
        rsvpWriteResponseSchema.parse(result),
        access.origin,
      );
    } catch (error) {
      return responseOrThrow(error, access.origin);
    }
  });

  router.notFound(() => problem(404, "NOT_FOUND", "Not Found"));
  return router;
}
