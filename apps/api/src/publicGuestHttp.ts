import {
  emptyMutationInputSchema,
  familySessionReadResponseSchema,
  familySessionResponseSchema,
  guestChallengeResendInputSchema,
  guestChallengeStartResponseSchema,
  guestChallengeVerifyInputSchema,
  guestLookupInputSchema,
} from "@entrelacos/contracts";
import {
  familySession,
  guestVerificationChallenge,
  site,
  siteOrigin,
} from "@entrelacos/database/schema";
import { getConnInfo } from "@hono/node-server/conninfo";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { AuthHttpOptions } from "./authHttp";
import {
  DEMO_GUEST_GRANT_HEADER,
  DemoGuestGrantError,
  verifyDemoGuestGrant,
} from "./demoGuestGrant";
import {
  FamilySessionServiceError,
  hashFamilySessionToken,
  leaveFamilySession,
  readFamilySession,
} from "./familySession";
import { GuestLookupServiceError } from "./guestLookup";
import {
  GuestVerificationServiceError,
  resendGuestChallenge,
  startGuestChallenge,
  verifyGuestChallenge,
} from "./guestVerification";

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
    {
      status,
      headers,
    },
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
    const parsed = new URL(value);
    return parsed.origin;
  } catch {
    return undefined;
  }
}

async function isAuthorizedOrigin(
  options: AuthHttpOptions,
  origin: string | undefined,
  siteId?: string,
): Promise<boolean> {
  if (!origin) return false;
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

async function challengeIdentity(
  options: AuthHttpOptions,
  challengeId: string,
): Promise<{ siteId: string; phoneE164: string } | undefined> {
  const rows = await options.db
    .select({
      siteId: guestVerificationChallenge.siteId,
      phoneE164: guestVerificationChallenge.phoneE164,
    })
    .from(guestVerificationChallenge)
    .where(eq(guestVerificationChallenge.id, challengeId))
    .limit(1);
  return rows[0];
}

async function authorizeDemoGrant(
  options: AuthHttpOptions,
  request: Request,
  siteId: string,
  phoneE164: string,
): Promise<boolean> {
  const token = request.headers.get(DEMO_GUEST_GRANT_HEADER);
  if (token === null) return false;
  const [siteRecord] = await options.db
    .select({ isDemo: site.isDemo })
    .from(site)
    .where(eq(site.id, siteId))
    .limit(1);
  if (!siteRecord) throw new DemoGuestGrantError(404, "NOT_FOUND", "Not Found");
  if (!siteRecord.isDemo) {
    throw new DemoGuestGrantError(
      403,
      "DEMO_SITE_REQUIRED",
      "Demo access is not enabled for this site",
    );
  }
  verifyDemoGuestGrant(token, {
    siteId,
    phoneE164,
    secret:
      options.guestDemoGrantSecret ?? options.guestFingerprintSecret ?? "",
    now: options.now?.(),
  });
  return true;
}

function bearerToken(request: Request): string | undefined {
  const value = request.headers.get("authorization");
  if (!value) return undefined;
  const [scheme, token, ...extra] = value.trim().split(/\s+/);
  if (scheme !== "Bearer" || !token || extra.length > 0) return undefined;
  return token;
}

async function siteIdForSession(
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

function setCors(context: Context, origin: string): void {
  context.header("Access-Control-Allow-Origin", origin);
  context.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  context.header(
    "Access-Control-Allow-Headers",
    `Authorization, Content-Type, ${DEMO_GUEST_GRANT_HEADER}`,
  );
  context.header("Access-Control-Max-Age", "600");
  context.header("Vary", "Origin");
  context.header("Cache-Control", "no-store");
}

function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    `Authorization, Content-Type, ${DEMO_GUEST_GRANT_HEADER}`,
  );
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
  if (
    error instanceof GuestVerificationServiceError ||
    error instanceof GuestLookupServiceError ||
    error instanceof FamilySessionServiceError ||
    error instanceof DemoGuestGrantError
  ) {
    return problem(
      error.status,
      error.code,
      error.title,
      error.retryAfterSeconds,
    );
  }
  if (error instanceof Error && error.name === "ZodError") {
    return problem(400, "VALIDATION_ERROR", "Invalid verification request");
  }
  return undefined;
}

function responseOrThrow(error: unknown, origin?: string): Response {
  const response = serviceError(error);
  if (response) return origin ? withCors(response, origin) : response;
  throw error;
}

function guestOptions(
  options: AuthHttpOptions,
  request: Request,
  context: Context,
  exposeSimulationCode = false,
) {
  const ipAddress = resolveClientIp(options, request, context);
  return {
    ipAddress,
    fingerprintSecret: options.guestFingerprintSecret ?? "",
    smsMode: options.guestSmsMode,
    now: options.now?.(),
    provider: options.guestVerificationProvider,
    codeGenerator: options.guestCodeGenerator,
    challengeIdGenerator: options.guestChallengeIdGenerator,
    sessionTokenGenerator: options.guestSessionTokenGenerator,
    exposeSimulationCode:
      exposeSimulationCode && options.guestExposeSimulationCode === true,
  };
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
    const info = getConnInfo(context);
    const remote = info.remote.address?.trim();
    if (remote) return remote;
  } catch {
    // In unit adapters there is no socket; production Node requests have one.
  }
  throw new GuestVerificationServiceError(
    503,
    "CLIENT_IP_UNAVAILABLE",
    "Client address is unavailable",
  );
}

export function createPublicGuestHttpRouter(options: AuthHttpOptions): Hono {
  const router = new Hono();
  router.onError(
    (error) =>
      serviceError(error) ??
      problem(503, "SERVICE_UNAVAILABLE", "Service unavailable"),
  );

  router.options(
    "/v1/public/sites/:siteId/guest/challenge",
    async (context) => {
      const origin = context.req.header("Origin");
      if (
        !(await isAuthorizedOrigin(
          options,
          origin,
          context.req.param("siteId"),
        ))
      ) {
        return problem(403, "FORBIDDEN", "Forbidden");
      }
      return preflight(context, origin as string);
    },
  );

  router.post("/v1/public/sites/:siteId/guest/challenge", async (context) => {
    const origin = context.req.header("Origin");
    if (
      !(await isAuthorizedOrigin(options, origin, context.req.param("siteId")))
    ) {
      return problem(403, "FORBIDDEN", "Forbidden");
    }
    setCors(context, origin as string);
    try {
      const input = guestLookupInputSchema.parse(
        await readObject(context.req.raw),
      );
      const demoGrantAuthorized = await authorizeDemoGrant(
        options,
        context.req.raw,
        context.req.param("siteId"),
        input.phone,
      );
      const result = await startGuestChallenge(
        options.db,
        context.req.param("siteId"),
        input,
        guestOptions(options, context.req.raw, context, demoGrantAuthorized),
      );
      return context.json(guestChallengeStartResponseSchema.parse(result), 201);
    } catch (error) {
      return responseOrThrow(error, origin);
    }
  });

  for (const operation of ["resend", "verify"] as const) {
    const path = `/v1/public/guest/challenge/:challengeId/${operation}`;
    router.options(path, async (context) => {
      const challengeId = context.req.param("challengeId") ?? "";
      const identity = await challengeIdentity(options, challengeId);
      const siteId = identity?.siteId;
      const origin = context.req.header("Origin");
      if (!siteId || !(await isAuthorizedOrigin(options, origin, siteId))) {
        return problem(403, "FORBIDDEN", "Forbidden");
      }
      return preflight(context, origin as string);
    });
    router.post(path, async (context) => {
      const challengeId = context.req.param("challengeId") ?? "";
      const identity = await challengeIdentity(options, challengeId);
      const siteId = identity?.siteId;
      const origin = context.req.header("Origin");
      if (!siteId || !(await isAuthorizedOrigin(options, origin, siteId))) {
        return problem(403, "FORBIDDEN", "Forbidden");
      }
      setCors(context, origin as string);
      try {
        const body = await readObject(context.req.raw);
        if (operation === "resend") {
          const input = guestChallengeResendInputSchema.parse(body);
          const demoGrantAuthorized = await authorizeDemoGrant(
            options,
            context.req.raw,
            siteId as string,
            identity?.phoneE164 as string,
          );
          const result = await resendGuestChallenge(
            options.db,
            challengeId,
            input,
            guestOptions(
              options,
              context.req.raw,
              context,
              demoGrantAuthorized,
            ),
          );
          return context.json(
            guestChallengeStartResponseSchema.parse(result),
            200,
          );
        }
        const input = guestChallengeVerifyInputSchema.parse(body);
        if (context.req.raw.headers.has(DEMO_GUEST_GRANT_HEADER)) {
          await authorizeDemoGrant(
            options,
            context.req.raw,
            siteId as string,
            identity?.phoneE164 as string,
          );
        }
        const result = await verifyGuestChallenge(
          options.db,
          challengeId,
          input,
          guestOptions(options, context.req.raw, context),
        );
        return context.json(familySessionResponseSchema.parse(result), 200);
      } catch (error) {
        return responseOrThrow(error, origin);
      }
    });
  }

  router.options("/v1/public/family/session", async (context) => {
    const origin = context.req.header("Origin");
    if (!(await isAuthorizedOrigin(options, origin))) {
      return problem(403, "FORBIDDEN", "Forbidden");
    }
    return preflight(context, origin as string);
  });

  router.get("/v1/public/family/session", async (context) => {
    const token = bearerToken(context.req.raw);
    const siteId = await siteIdForSession(options, token);
    const origin = context.req.header("Origin");
    if (!siteId) {
      if (await isAuthorizedOrigin(options, origin)) {
        setCors(context, origin as string);
        return withCors(
          problem(401, "SESSION_INVALID", "Family session is invalid"),
          origin as string,
        );
      }
      return problem(403, "FORBIDDEN", "Forbidden");
    }
    if (!(await isAuthorizedOrigin(options, origin, siteId))) {
      return problem(403, "FORBIDDEN", "Forbidden");
    }
    setCors(context, origin as string);
    try {
      const result = await readFamilySession(
        options.db,
        token as string,
        options.now?.(),
      );
      return context.json(familySessionReadResponseSchema.parse(result), 200);
    } catch (error) {
      return responseOrThrow(error, origin);
    }
  });

  router.options("/v1/public/family/session/leave", async (context) => {
    const origin = context.req.header("Origin");
    if (!(await isAuthorizedOrigin(options, origin))) {
      return problem(403, "FORBIDDEN", "Forbidden");
    }
    return preflight(context, origin as string);
  });

  router.post("/v1/public/family/session/leave", async (context) => {
    const token = bearerToken(context.req.raw);
    const siteId = await siteIdForSession(options, token);
    const origin = context.req.header("Origin");
    if (!siteId) {
      if (await isAuthorizedOrigin(options, origin)) {
        setCors(context, origin as string);
        return withCors(
          problem(401, "SESSION_INVALID", "Family session is invalid"),
          origin as string,
        );
      }
      return problem(403, "FORBIDDEN", "Forbidden");
    }
    if (!(await isAuthorizedOrigin(options, origin, siteId))) {
      return problem(403, "FORBIDDEN", "Forbidden");
    }
    setCors(context, origin as string);
    try {
      emptyMutationInputSchema.parse((await readObject(context.req.raw)) ?? {});
      const result = await leaveFamilySession(
        options.db,
        token as string,
        options.now?.(),
      );
      return context.json(result, 200);
    } catch (error) {
      return responseOrThrow(error, origin);
    }
  });

  router.notFound(() => problem(404, "NOT_FOUND", "Not Found"));
  return router;
}
