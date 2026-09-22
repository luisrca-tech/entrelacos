import {
  emptyMutationInputSchema,
  invitationSessionLeaveResponseSchema,
} from "@entrelacos/contracts";
import { site, siteOrigin } from "@entrelacos/database/schema";
import { getConnInfo } from "@hono/node-server/conninfo";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { AuthHttpOptions } from "./authHttp";
import {
  GuestVerificationServiceError,
  invitationSessionSiteId,
  leaveInvitationSession,
  readInvitationSession,
  startInvitationSession,
} from "./guestVerification";
import { allowsLocalPublicOrigin } from "./localPublicOrigin";

const INVALID_JSON_BODY = Symbol("invalid-json-body");

function problem(
  status: number,
  code: string,
  title: string,
  retryAfterSeconds?: number,
): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/problem+json",
  });
  if (retryAfterSeconds !== undefined) {
    headers.set("Retry-After", String(Math.max(1, retryAfterSeconds)));
  }
  return new Response(
    JSON.stringify({ type: "about:blank", title, status, code }),
    { status, headers },
  );
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
    return INVALID_JSON_BODY;
  }
}

function originOfPublicUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

async function isAuthorizedOrigin(
  options: AuthHttpOptions,
  request: Request,
  origin: string | undefined,
  siteId?: string,
): Promise<boolean> {
  if (!origin) return false;
  if (allowsLocalPublicOrigin(request.url, origin)) return true;
  const rows = await options.db
    .select({ publicUrl: site.publicUrl, origin: siteOrigin.origin })
    .from(site)
    .leftJoin(siteOrigin, eq(siteOrigin.siteId, site.id))
    .where(siteId ? eq(site.id, siteId) : undefined);
  return rows.some(
    (row) =>
      row.origin === origin || originOfPublicUrl(row.publicUrl) === origin,
  );
}

function bearerToken(request: Request): string | undefined {
  const value = request.headers.get("authorization");
  if (!value) return undefined;
  const [scheme, token, ...extra] = value.trim().split(/\s+/);
  if (scheme !== "Bearer" || !token || extra.length > 0) return undefined;
  return token;
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

function serviceError(error: unknown): Response | undefined {
  if (error instanceof GuestVerificationServiceError) {
    return problem(
      error.status,
      error.code,
      error.title,
      error.retryAfterSeconds,
    );
  }
  if (error instanceof Error && error.name === "ZodError") {
    return problem(
      400,
      "VALIDATION_ERROR",
      "Invalid invitation access request",
    );
  }
  return undefined;
}

function responseOrThrow(error: unknown, origin?: string): Response {
  const response = serviceError(error);
  if (response) return origin ? withCors(response, origin) : response;
  throw error;
}

export function forwardedClientIp(headers: Headers): string | undefined {
  const forwarded =
    headers.get("x-real-ip")?.trim() ||
    headers.get("cf-connecting-ip")?.trim() ||
    headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || undefined;
}

function resolveClientIp(
  options: AuthHttpOptions,
  request: Request,
  context: Context,
): string {
  const resolved = options.guestResolveClientIp?.(request);
  if (resolved?.trim()) return resolved.trim();
  if (options.guestTrustProxyHeaders) {
    const forwarded = forwardedClientIp(request.headers);
    if (forwarded) return forwarded;
  }
  try {
    const remote = getConnInfo(context).remote.address?.trim();
    if (remote) return remote;
  } catch {
    // Unit adapters do not have a socket; production requests do.
  }
  throw new GuestVerificationServiceError(
    503,
    "CLIENT_IP_UNAVAILABLE",
    "Client address is unavailable",
  );
}

function verificationOptions(
  options: AuthHttpOptions,
  request: Request,
  context: Context,
) {
  return {
    ipAddress: resolveClientIp(options, request, context),
    fingerprintSecret: options.guestFingerprintSecret ?? "",
    now: options.now?.(),
    sessionTokenGenerator: options.guestSessionTokenGenerator,
    attemptIdGenerator: options.guestChallengeIdGenerator,
  };
}

async function authorizedOriginForSession(
  options: AuthHttpOptions,
  request: Request,
  token: string | undefined,
): Promise<{ origin: string; siteId?: string } | undefined> {
  const origin = request.headers.get("Origin") ?? undefined;
  const siteId = await invitationSessionSiteId(options.db, token);
  if (siteId) {
    if (await isAuthorizedOrigin(options, request, origin, siteId)) {
      return { origin: origin as string, siteId };
    }
    return undefined;
  }
  if (await isAuthorizedOrigin(options, request, origin)) {
    return { origin: origin as string };
  }
  return undefined;
}

export function createGuestVerificationHttpRouter(
  options: AuthHttpOptions,
): Hono {
  const router = new Hono();
  router.onError(
    (error) =>
      serviceError(error) ??
      problem(503, "SERVICE_UNAVAILABLE", "Service unavailable"),
  );

  const accessPath = "/v1/public/sites/:siteId/invitation/access";
  router.options(accessPath, async (context) => {
    const origin = context.req.header("Origin");
    if (
      !(await isAuthorizedOrigin(
        options,
        context.req.raw,
        origin,
        context.req.param("siteId"),
      ))
    ) {
      return problem(403, "FORBIDDEN", "Forbidden");
    }
    return preflight(context, origin as string);
  });

  router.post(accessPath, async (context) => {
    const origin = context.req.header("Origin");
    if (
      !(await isAuthorizedOrigin(
        options,
        context.req.raw,
        origin,
        context.req.param("siteId"),
      ))
    ) {
      return problem(403, "FORBIDDEN", "Forbidden");
    }
    setCors(context, origin as string);
    try {
      const result = await startInvitationSession(
        options.db,
        context.req.param("siteId"),
        await readObject(context.req.raw),
        verificationOptions(options, context.req.raw, context),
      );
      return context.json(result, 200);
    } catch (error) {
      return responseOrThrow(error, origin);
    }
  });

  const sessionPath = "/v1/public/invitation/session";
  router.options(sessionPath, async (context) => {
    const origin = context.req.header("Origin");
    if (!(await isAuthorizedOrigin(options, context.req.raw, origin))) {
      return problem(403, "FORBIDDEN", "Forbidden");
    }
    return preflight(context, origin as string);
  });

  router.get(sessionPath, async (context) => {
    const token = bearerToken(context.req.raw);
    const authorized = await authorizedOriginForSession(
      options,
      context.req.raw,
      token,
    );
    if (!authorized) return problem(403, "FORBIDDEN", "Forbidden");
    setCors(context, authorized.origin);
    try {
      const result = await readInvitationSession(
        options.db,
        token ?? "",
        options.now?.(),
      );
      if (authorized.siteId && authorized.siteId !== result.siteId) {
        return withCors(
          problem(401, "SESSION_INVALID", "Invitation session is invalid"),
          authorized.origin,
        );
      }
      return context.json(result, 200);
    } catch (error) {
      return responseOrThrow(error, authorized.origin);
    }
  });

  const leavePath = "/v1/public/invitation/session/leave";
  router.options(leavePath, async (context) => {
    const origin = context.req.header("Origin");
    if (!(await isAuthorizedOrigin(options, context.req.raw, origin))) {
      return problem(403, "FORBIDDEN", "Forbidden");
    }
    return preflight(context, origin as string);
  });

  router.post(leavePath, async (context) => {
    const token = bearerToken(context.req.raw);
    const authorized = await authorizedOriginForSession(
      options,
      context.req.raw,
      token,
    );
    if (!authorized) return problem(403, "FORBIDDEN", "Forbidden");
    setCors(context, authorized.origin);
    try {
      emptyMutationInputSchema.parse((await readObject(context.req.raw)) ?? {});
      const result = await leaveInvitationSession(
        options.db,
        token ?? "",
        options.now?.(),
      );
      return context.json(
        invitationSessionLeaveResponseSchema.parse(result),
        200,
      );
    } catch (error) {
      return responseOrThrow(error, authorized.origin);
    }
  });

  router.notFound(() => problem(404, "NOT_FOUND", "Not Found"));
  return router;
}
