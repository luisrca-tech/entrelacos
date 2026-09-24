import { createHmac } from "node:crypto";
import {
  createPublicSiteMessageRequestSchema,
  createPublicSiteMessageResponseSchema,
  muralConfigurationResponseSchema,
  muralConfigurationSchema,
  publicMuralQuerySchema,
  publicMuralResponseSchema,
  siteMessagesQuerySchema,
  siteMessagesResponseSchema,
} from "@entrelacos/contracts";
import { site, siteOrigin } from "@entrelacos/database/schema";
import { getConnInfo } from "@hono/node-server/conninfo";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { AuthHttpOptions } from "./authHttp";
import { AdminSessionRequiredError, requireAdminSession } from "./authHttp";
import { forwardedClientIp } from "./guestVerificationHttp";
import { allowsLocalPublicOrigin } from "./localPublicOrigin";
import {
  createPublicSiteMessage,
  deleteSiteMessage,
  listSiteMessages,
  MessagesServiceError,
  readMuralConfiguration,
  readPublicMural,
  updateMuralConfiguration,
} from "./messages";
import { PublicMessageRequestRateLimiter } from "./publicMessageRequestRateLimit";

const MAX_PUBLIC_MESSAGE_BODY_BYTES = 4 * 1024;

export type MessagesHttpOptions = AuthHttpOptions & {
  requestRateLimiter?: PublicMessageRequestRateLimiter;
};

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
    headers.set(
      "Retry-After",
      String(Math.max(1, Math.ceil(retryAfterSeconds))),
    );
  }
  return new Response(
    JSON.stringify({ type: "about:blank", title, status, code }),
    { status, headers },
  );
}

async function readJson(request: Request): Promise<unknown> {
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

type BoundedJsonResult =
  | { tooLarge: true }
  | { tooLarge: false; value: unknown };

async function readBoundedJson(
  request: Request,
  maxBytes = MAX_PUBLIC_MESSAGE_BODY_BYTES,
): Promise<BoundedJsonResult> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    return { tooLarge: false, value: undefined };
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { tooLarge: true };
  }
  if (!request.body) return { tooLarge: false, value: undefined };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return { tooLarge: true };
      }
      chunks.push(value);
    }
  } catch {
    return { tooLarge: false, value: undefined };
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      tooLarge: false,
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
    };
  } catch {
    return { tooLarge: false, value: undefined };
  }
}

function queryObject(request: Request): Record<string, string> {
  return Object.fromEntries(new URL(request.url).searchParams.entries());
}

function originOfPublicUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

async function originsForSite(
  options: MessagesHttpOptions,
  siteId: string,
): Promise<string[]> {
  const rows = await options.db
    .select({ publicUrl: site.publicUrl, origin: siteOrigin.origin })
    .from(site)
    .leftJoin(siteOrigin, eq(siteOrigin.siteId, site.id))
    .where(eq(site.id, siteId));
  const origins = new Set<string>();
  for (const row of rows) {
    if (row.origin) origins.add(row.origin);
    const publicOrigin = originOfPublicUrl(row.publicUrl);
    if (publicOrigin) origins.add(publicOrigin);
  }
  return [...origins];
}

async function isRegisteredOrigin(
  options: MessagesHttpOptions,
  request: Request,
  origin: string | undefined,
  siteId?: string,
): Promise<boolean> {
  if (!origin) return false;
  if (allowsLocalPublicOrigin(request.url, origin)) return true;
  if (siteId) return (await originsForSite(options, siteId)).includes(origin);
  const rows = await options.db
    .select({ publicUrl: site.publicUrl, origin: siteOrigin.origin })
    .from(site)
    .leftJoin(siteOrigin, eq(siteOrigin.siteId, site.id));
  return rows.some(
    (row) =>
      row.origin === origin || originOfPublicUrl(row.publicUrl) === origin,
  );
}

function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  headers.set("Access-Control-Expose-Headers", "Retry-After");
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
  context.header("Access-Control-Allow-Origin", origin);
  context.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  context.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
  context.header("Access-Control-Max-Age", "600");
  context.header("Vary", "Origin");
  context.header("Cache-Control", "no-store");
  return new Response(null, { status: 204, headers: context.res.headers });
}

function resolveClientIp(
  options: MessagesHttpOptions,
  request: Request,
  context: Context,
): string | undefined {
  const resolved = options.guestResolveClientIp?.(request)?.trim();
  if (resolved) return resolved;
  if (options.guestTrustProxyHeaders) {
    const forwarded = forwardedClientIp(request.headers);
    if (forwarded) return forwarded;
  }
  try {
    const remote = getConnInfo(context).remote.address?.trim();
    if (remote) return remote;
  } catch {
    // Test adapters do not expose a socket.
  }
  return undefined;
}

function ipFingerprint(
  options: MessagesHttpOptions,
  ipAddress: string,
): string {
  const secret = options.guestFingerprintSecret;
  if (!secret || secret.trim().length < 32) {
    throw new MessagesServiceError(
      503,
      "SERVICE_UNAVAILABLE",
      "Service unavailable",
    );
  }
  return createHmac("sha256", secret)
    .update(`public-mural-ip:${ipAddress}`)
    .digest("hex");
}

async function requireAdminActor(
  request: Request,
  options: MessagesHttpOptions,
): Promise<Response | { userId: string; role: "OWNER" | "SITE_ADMIN" }> {
  if (request.headers.get("origin") !== options.adminOrigin)
    return problem(403, "FORBIDDEN", "Forbidden");
  try {
    const actor = await requireAdminSession(request, options);
    return { userId: actor.user.id, role: actor.user.role };
  } catch (error) {
    if (error instanceof AdminSessionRequiredError)
      return problem(401, "UNAUTHORIZED", "Authentication required");
    throw error;
  }
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

function serviceError(error: unknown): Response | undefined {
  if (error instanceof MessagesServiceError) {
    return problem(
      error.status,
      error.code,
      error.title,
      error.retryAfterSeconds,
    );
  }
  if (error instanceof Error && error.name === "ZodError")
    return problem(400, "VALIDATION_ERROR", "Invalid message request");
  return undefined;
}

function responseOrThrow(error: unknown, origin?: string): Response {
  const response = serviceError(error);
  if (response) return origin ? withCors(response, origin) : response;
  throw error;
}

export function createMessagesHttpRouter(options: MessagesHttpOptions): Hono {
  const router = new Hono();
  const limiter =
    options.requestRateLimiter ?? new PublicMessageRequestRateLimiter();

  router.onError(
    (error) =>
      serviceError(error) ??
      problem(503, "SERVICE_UNAVAILABLE", "Service unavailable"),
  );

  router.options("/v1/public/sites/:siteId/mural", async (context) => {
    const origin = context.req.header("Origin");
    if (
      !(await isRegisteredOrigin(
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

  router.get("/v1/public/sites/:siteId/mural", async (context) => {
    const origin = context.req.header("Origin");
    const siteId = context.req.param("siteId");
    if (!(await isRegisteredOrigin(options, context.req.raw, origin, siteId)))
      return problem(403, "FORBIDDEN", "Forbidden");
    try {
      const result = await readPublicMural(
        options.db,
        siteId,
        origin as string,
        publicMuralQuerySchema.parse(queryObject(context.req.raw)),
        context.req.url,
      );
      return withCors(
        context.json(publicMuralResponseSchema.parse(result), 200),
        origin as string,
      );
    } catch (error) {
      return responseOrThrow(error, origin as string);
    }
  });

  router.post("/v1/public/sites/:siteId/mural", async (context) => {
    const siteId = context.req.param("siteId");
    const ipAddress = resolveClientIp(options, context.req.raw, context);
    if (!ipAddress)
      return problem(
        503,
        "CLIENT_IP_UNAVAILABLE",
        "Client address is unavailable",
      );
    let fingerprint: string;
    try {
      fingerprint = ipFingerprint(options, ipAddress);
    } catch (error) {
      return responseOrThrow(error);
    }
    const origin = context.req.header("Origin");
    if (!(await isRegisteredOrigin(options, context.req.raw, origin, siteId)))
      return problem(403, "FORBIDDEN", "Forbidden");
    const rate = limiter.consume(fingerprint, options.now?.() ?? new Date());
    if (!rate.allowed) {
      return withCors(
        problem(
          429,
          "RATE_LIMITED",
          "Too many public message requests",
          rate.retryAfterSeconds,
        ),
        origin as string,
      );
    }

    const body = await readBoundedJson(context.req.raw);
    if (body.tooLarge) {
      return withCors(
        problem(413, "PAYLOAD_TOO_LARGE", "Message request is too large"),
        origin as string,
      );
    }
    try {
      const input = createPublicSiteMessageRequestSchema.parse(body.value);
      const result = await createPublicSiteMessage(
        options.db,
        siteId,
        input,
        fingerprint,
        options.now?.(),
      );
      return withCors(
        context.json(createPublicSiteMessageResponseSchema.parse(result), 201),
        origin as string,
      );
    } catch (error) {
      return responseOrThrow(error, origin as string);
    }
  });

  router.get("/v1/sites/:siteId/messages", async (context) => {
    const actor = await requireAdminActor(context.req.raw, options);
    if (isResponse(actor)) return actor;
    try {
      const result = await listSiteMessages(
        options.db,
        actor,
        context.req.param("siteId"),
        siteMessagesQuerySchema.parse(queryObject(context.req.raw)),
      );
      return context.json(siteMessagesResponseSchema.parse(result), 200, {
        "Cache-Control": "no-store",
      });
    } catch (error) {
      return responseOrThrow(error);
    }
  });

  router.delete("/v1/sites/:siteId/messages/:messageId", async (context) => {
    const actor = await requireAdminActor(context.req.raw, options);
    if (isResponse(actor)) return actor;
    try {
      await deleteSiteMessage(
        options.db,
        actor,
        context.req.param("siteId"),
        context.req.param("messageId"),
      );
      return context.body(null, 204, { "Cache-Control": "no-store" });
    } catch (error) {
      return responseOrThrow(error);
    }
  });

  router.get("/v1/sites/:siteId/mural", async (context) => {
    const actor = await requireAdminActor(context.req.raw, options);
    if (isResponse(actor)) return actor;
    try {
      const result = await readMuralConfiguration(
        options.db,
        actor,
        context.req.param("siteId"),
      );
      return context.json(muralConfigurationResponseSchema.parse(result), 200, {
        "Cache-Control": "no-store",
      });
    } catch (error) {
      return responseOrThrow(error);
    }
  });

  router.patch("/v1/sites/:siteId/mural", async (context) => {
    const actor = await requireAdminActor(context.req.raw, options);
    if (isResponse(actor)) return actor;
    try {
      const result = await updateMuralConfiguration(
        options.db,
        actor,
        context.req.param("siteId"),
        muralConfigurationSchema.parse(await readJson(context.req.raw)),
        options.now?.(),
      );
      return context.json(muralConfigurationResponseSchema.parse(result), 200, {
        "Cache-Control": "no-store",
      });
    } catch (error) {
      return responseOrThrow(error);
    }
  });

  router.notFound(() => problem(404, "NOT_FOUND", "Not Found"));
  return router;
}
