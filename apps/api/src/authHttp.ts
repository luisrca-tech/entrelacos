import { session, user } from "@entrelacos/database/schema";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AuthDatabase, createAuth } from "./auth";

export const ADMIN_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const ADMIN_ABSOLUTE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

type AuthInstance = ReturnType<typeof createAuth>;

export interface AuthHttpOptions {
  auth: AuthInstance;
  db: AuthDatabase;
  adminOrigin: string;
  now?: () => Date;
}

export interface AdministrativeActor {
  user: {
    id: string;
    name: string;
    email: string;
    role: "OWNER" | "SITE_ADMIN";
  };
  session: {
    id: string;
    expiresAt: Date;
  };
}

export class AdminSessionRequiredError extends Error {
  readonly status = 401;
  readonly code = "UNAUTHORIZED";

  constructor() {
    super("Authentication required");
    this.name = "AdminSessionRequiredError";
  }
}

type SessionLookup = {
  sessionId: string;
  userId: string;
  sessionCreatedAt: Date;
  sessionExpiresAt: Date;
  lastActiveAt: Date;
  userName: string;
  userEmail: string;
  userRole: "OWNER" | "SITE_ADMIN";
  userState: "PENDING" | "ACTIVE" | "DISABLED";
};

function problem(status: number, code: string, title: string): Response {
  return new Response(
    JSON.stringify({
      type: "about:blank",
      title,
      status,
      code,
    }),
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      },
    },
  );
}

function isTrustedOrigin(request: Request, adminOrigin: string): boolean {
  return request.headers.get("origin") === adminOrigin;
}

function copyResponseHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const name of ["cache-control", "pragma", "vary"]) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }

  const sourceWithCookies = source as Headers & {
    getSetCookie?: () => string[];
  };
  const cookies = sourceWithCookies.getSetCookie?.() ?? [];
  if (cookies.length > 0) {
    for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  } else {
    const cookie = source.get("set-cookie");
    if (cookie) headers.set("Set-Cookie", cookie);
  }
  return headers;
}

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    return null;
  }

  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function nativeRequest(
  request: Request,
  body: Record<string, unknown>,
): Request {
  const headers = new Headers(request.headers);
  headers.set("Content-Type", "application/json");
  return new Request(request.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function handleNativeAuth(
  request: Request,
  auth: AuthInstance,
  body: Record<string, unknown>,
): Promise<Response> {
  try {
    const response = await auth.handler(nativeRequest(request, body));
    if (response.status < 200 || response.status >= 300) {
      if (response.status >= 500) {
        return problem(
          503,
          "UPSTREAM_UNAVAILABLE",
          "Authentication service unavailable",
        );
      }
      return problem(
        response.status >= 400 && response.status < 500 ? response.status : 401,
        response.status === 403 ? "FORBIDDEN" : "UNAUTHORIZED",
        response.status === 403 ? "Forbidden" : "Authentication failed",
      );
    }

    const headers = copyResponseHeaders(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify({ ok: true }), {
      status: response.status,
      headers,
    });
  } catch {
    return problem(
      502,
      "UPSTREAM_UNAVAILABLE",
      "Authentication service unavailable",
    );
  }
}

async function lookupSession(
  request: Request,
  options: AuthHttpOptions,
): Promise<SessionLookup | null> {
  const current = await options.auth.api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true, disableRefresh: true },
  });
  if (!current) return null;

  const [record] = await options.db
    .select({
      sessionId: session.id,
      userId: session.userId,
      sessionCreatedAt: session.createdAt,
      sessionExpiresAt: session.expiresAt,
      lastActiveAt: session.lastActiveAt,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      userState: user.state,
    })
    .from(session)
    .innerJoin(user, eq(session.userId, user.id))
    .where(eq(session.id, current.session.id))
    .limit(1);

  return record ?? null;
}

export async function getAdministrativeSession(
  request: Request,
  options: Pick<AuthHttpOptions, "auth" | "db" | "now">,
): Promise<AdministrativeActor | null> {
  const record = await lookupSession(request, options as AuthHttpOptions);
  if (!record) return null;

  const now = (options.now ?? (() => new Date()))();
  const nowMs = now.getTime();
  if (
    record.userState !== "ACTIVE" ||
    nowMs >= record.sessionExpiresAt.getTime() ||
    nowMs - record.sessionCreatedAt.getTime() >= ADMIN_ABSOLUTE_TIMEOUT_MS ||
    nowMs - record.lastActiveAt.getTime() >= ADMIN_IDLE_TIMEOUT_MS
  ) {
    return null;
  }

  await options.db
    .update(session)
    .set({ lastActiveAt: now, updatedAt: now })
    .where(eq(session.id, record.sessionId));

  return {
    user: {
      id: record.userId,
      name: record.userName,
      email: record.userEmail,
      role: record.userRole,
    },
    session: {
      id: record.sessionId,
      expiresAt: record.sessionExpiresAt,
    },
  };
}

export async function requireAdminSession(
  request: Request,
  options: Pick<AuthHttpOptions, "auth" | "db" | "now">,
): Promise<AdministrativeActor> {
  const actor = await getAdministrativeSession(request, options);
  if (!actor) throw new AdminSessionRequiredError();
  return actor;
}

export function createAuthHttpRouter(options: AuthHttpOptions): Hono {
  const router = new Hono();

  router.onError((_error) =>
    problem(503, "SERVICE_UNAVAILABLE", "Service unavailable"),
  );

  router.post("/v1/auth/sign-in/email", async (context) => {
    if (!isTrustedOrigin(context.req.raw, options.adminOrigin)) {
      return problem(403, "FORBIDDEN", "Forbidden");
    }
    const body = await readJsonObject(context.req.raw);
    if (
      !body ||
      Object.keys(body).some((key) => key !== "email" && key !== "password") ||
      typeof body.email !== "string" ||
      typeof body.password !== "string"
    ) {
      return problem(400, "VALIDATION_ERROR", "Invalid authentication payload");
    }
    return handleNativeAuth(context.req.raw, options.auth, {
      email: body.email,
      password: body.password,
    });
  });

  router.post("/v1/auth/sign-out", async (context) => {
    if (!isTrustedOrigin(context.req.raw, options.adminOrigin)) {
      return problem(403, "FORBIDDEN", "Forbidden");
    }
    const body = await readJsonObject(context.req.raw);
    if (!body || Object.keys(body).length !== 0) {
      return problem(400, "VALIDATION_ERROR", "Invalid authentication payload");
    }
    return handleNativeAuth(context.req.raw, options.auth, {});
  });

  router.get("/v1/me", async (context) => {
    if (!isTrustedOrigin(context.req.raw, options.adminOrigin)) {
      return problem(403, "FORBIDDEN", "Forbidden");
    }
    const actor = await getAdministrativeSession(context.req.raw, options);
    if (!actor) return problem(401, "UNAUTHORIZED", "Authentication required");
    return context.json(actor, 200, { "Cache-Control": "no-store" });
  });

  router.notFound(() => problem(404, "NOT_FOUND", "Not Found"));
  return router;
}
