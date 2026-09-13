import {
  familyMessageResponseSchema,
  messageDeletionInputSchema,
  messageDeletionResponseSchema,
  messageMutationInputSchema,
  messageMutationResponseSchema,
  muralConfigurationResponseSchema,
  muralConfigurationSchema,
  publicMuralQuerySchema,
  publicMuralResponseSchema,
  siteMessageBlockInputSchema,
  siteMessageBlockResponseSchema,
  siteMessagesQuerySchema,
  siteMessagesResponseSchema,
} from "@entrelacos/contracts";
import { familySession, site, siteOrigin } from "@entrelacos/database/schema";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { AuthHttpOptions } from "./authHttp";
import { AdminSessionRequiredError, requireAdminSession } from "./authHttp";
import { hashFamilySessionToken } from "./familySession";
import {
  deleteGroupMessage,
  listSiteMessages,
  MessagesServiceError,
  readFamilyMessage,
  readMuralConfiguration,
  readPublicMural,
  updateMessageBlock,
  updateMuralConfiguration,
  writeFamilyMessage,
} from "./messages";

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

function bearerToken(request: Request): string | undefined {
  const value = request.headers.get("authorization");
  if (!value) return undefined;
  const [scheme, token, ...extra] = value.trim().split(/\s+/);
  if (scheme !== "Bearer" || !token || extra.length > 0) return undefined;
  return token;
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
  options: AuthHttpOptions,
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
  options: AuthHttpOptions,
  origin: string | undefined,
  siteId?: string,
): Promise<boolean> {
  if (!origin) return false;
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
  headers.set("Access-Control-Allow-Methods", "GET, PUT, PATCH, OPTIONS");
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
  context.header("Access-Control-Allow-Origin", origin);
  context.header("Access-Control-Allow-Methods", "GET, PUT, PATCH, OPTIONS");
  context.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
  context.header("Access-Control-Max-Age", "600");
  context.header("Vary", "Origin");
  context.header("Cache-Control", "no-store");
  return new Response(null, { status: 204, headers: context.res.headers });
}

async function sessionSiteId(
  options: AuthHttpOptions,
  token: string | undefined,
): Promise<string | undefined> {
  if (!token) return undefined;
  const [row] = await options.db
    .select({ siteId: familySession.siteId })
    .from(familySession)
    .where(eq(familySession.tokenHash, hashFamilySessionToken(token)))
    .limit(1);
  return row?.siteId;
}

async function requireFamilyRequest(
  request: Request,
  options: AuthHttpOptions,
): Promise<Response | { origin: string; token: string }> {
  const origin = request.headers.get("origin") ?? undefined;
  const token = bearerToken(request);
  const siteId = await sessionSiteId(options, token);
  if (!siteId) {
    if (await isRegisteredOrigin(options, origin)) {
      return withCors(
        problem(401, "SESSION_INVALID", "Family session is invalid"),
        origin as string,
      );
    }
    return problem(403, "FORBIDDEN", "Forbidden");
  }
  if (!(await isRegisteredOrigin(options, origin, siteId)))
    return problem(403, "FORBIDDEN", "Forbidden");
  return { origin: origin as string, token: token as string };
}

async function requireAdminActor(
  request: Request,
  options: AuthHttpOptions,
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
  if (error instanceof MessagesServiceError)
    return problem(error.status, error.code, error.title, error.details);
  if (error instanceof Error && error.name === "ZodError")
    return problem(400, "VALIDATION_ERROR", "Invalid message request");
  return undefined;
}

function responseOrThrow(error: unknown, origin?: string): Response {
  const response = serviceError(error);
  if (response) return origin ? withCors(response, origin) : response;
  throw error;
}

export function createMessagesHttpRouter(options: AuthHttpOptions): Hono {
  const router = new Hono();
  router.onError(
    (error) =>
      serviceError(error) ??
      problem(503, "SERVICE_UNAVAILABLE", "Service unavailable"),
  );

  router.options("/v1/public/family/message", async (context) => {
    const origin = context.req.header("Origin");
    if (!(await isRegisteredOrigin(options, origin)))
      return problem(403, "FORBIDDEN", "Forbidden");
    return preflight(context, origin as string);
  });

  router.get("/v1/public/family/message", async (context) => {
    const access = await requireFamilyRequest(context.req.raw, options);
    if (isResponse(access)) return access;
    try {
      const result = await readFamilyMessage(
        options.db,
        access.token,
        options.now?.(),
      );
      return withCors(
        context.json(familyMessageResponseSchema.parse(result), 200),
        access.origin,
      );
    } catch (error) {
      return responseOrThrow(error, access.origin);
    }
  });

  router.put("/v1/public/family/message", async (context) => {
    const access = await requireFamilyRequest(context.req.raw, options);
    if (isResponse(access)) return access;
    try {
      const result = await writeFamilyMessage(
        options.db,
        access.token,
        messageMutationInputSchema.parse(await readObject(context.req.raw)),
        options.now?.(),
      );
      return withCors(
        context.json(messageMutationResponseSchema.parse(result), 200),
        access.origin,
      );
    } catch (error) {
      return responseOrThrow(error, access.origin);
    }
  });

  router.options("/v1/public/sites/:siteId/mural", async (context) => {
    const origin = context.req.header("Origin");
    if (
      !(await isRegisteredOrigin(options, origin, context.req.param("siteId")))
    )
      return problem(403, "FORBIDDEN", "Forbidden");
    return preflight(context, origin as string);
  });

  router.get("/v1/public/sites/:siteId/mural", async (context) => {
    const origin = context.req.header("Origin");
    const siteId = context.req.param("siteId");
    if (!(await isRegisteredOrigin(options, origin, siteId)))
      return problem(403, "FORBIDDEN", "Forbidden");
    try {
      const result = await readPublicMural(
        options.db,
        siteId,
        origin as string,
        publicMuralQuerySchema.parse(queryObject(context.req.raw)),
      );
      return withCors(
        context.json(publicMuralResponseSchema.parse(result), 200),
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
        muralConfigurationSchema.parse(await readObject(context.req.raw)),
        options.now?.(),
      );
      return context.json(muralConfigurationResponseSchema.parse(result), 200, {
        "Cache-Control": "no-store",
      });
    } catch (error) {
      return responseOrThrow(error);
    }
  });

  router.delete(
    "/v1/sites/:siteId/groups/:groupId/message",
    async (context) => {
      const actor = await requireAdminActor(context.req.raw, options);
      if (isResponse(actor)) return actor;
      try {
        const result = await deleteGroupMessage(
          options.db,
          actor,
          context.req.param("siteId"),
          context.req.param("groupId"),
          messageDeletionInputSchema.parse(await readObject(context.req.raw)),
          options.now?.(),
        );
        return context.json(messageDeletionResponseSchema.parse(result), 200, {
          "Cache-Control": "no-store",
        });
      } catch (error) {
        return responseOrThrow(error);
      }
    },
  );

  router.patch(
    "/v1/sites/:siteId/groups/:groupId/message-block",
    async (context) => {
      const actor = await requireAdminActor(context.req.raw, options);
      if (isResponse(actor)) return actor;
      try {
        const result = await updateMessageBlock(
          options.db,
          actor,
          context.req.param("siteId"),
          context.req.param("groupId"),
          siteMessageBlockInputSchema.parse(await readObject(context.req.raw)),
          options.now?.(),
        );
        return context.json(siteMessageBlockResponseSchema.parse(result), 200, {
          "Cache-Control": "no-store",
        });
      } catch (error) {
        return responseOrThrow(error);
      }
    },
  );

  router.notFound(() => problem(404, "NOT_FOUND", "Not Found"));
  return router;
}
