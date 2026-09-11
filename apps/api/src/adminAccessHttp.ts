import {
  adminAccessIssueInputSchema,
  adminAccessIssueResponseSchema,
  adminAccessRevokeInputSchema,
  adminDisableInputSchema,
  adminListResponseSchema,
  adminSummarySchema,
  ownerAdminCreateInputSchema,
  publicAccessConsumeInputSchema,
  publicAccessConsumeResponseSchema,
} from "@entrelacos/contracts";
import { Hono } from "hono";
import {
  AdminAccessRejectedError,
  consumeAdminAccess,
  createSiteAdmin,
  disableAdmin,
  issueAdminAccess,
  listSiteAdmins,
  revokeAdminAccess,
} from "./adminAccess";
import type { AuthHttpOptions } from "./authHttp";
import { AdminSessionRequiredError, requireAdminSession } from "./authHttp";

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

function trustedOrigin(request: Request, adminOrigin: string): boolean {
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

async function requireOwner(
  request: Request,
  options: AuthHttpOptions,
): Promise<Response | { userId: string }> {
  if (!trustedOrigin(request, options.adminOrigin)) {
    return problem(403, "FORBIDDEN", "Forbidden");
  }
  try {
    const actor = await requireAdminSession(request, options);
    if (actor.user.role !== "OWNER") {
      return problem(403, "FORBIDDEN", "Forbidden");
    }
    return { userId: actor.user.id };
  } catch (error) {
    if (error instanceof AdminSessionRequiredError) {
      return problem(401, "UNAUTHORIZED", "Authentication required");
    }
    throw error;
  }
}

function invalidAccess(): Response {
  return problem(400, "INVALID_ACCESS", "Access request rejected");
}

function isResponse(value: Response | object): value is Response {
  return value instanceof Response;
}

function accessError(error: unknown): Response | undefined {
  return error instanceof AdminAccessRejectedError
    ? invalidAccess()
    : undefined;
}

export function createAdminAccessHttpRouter(options: AuthHttpOptions): Hono {
  const router = new Hono();

  router.onError(() =>
    problem(503, "SERVICE_UNAVAILABLE", "Service unavailable"),
  );

  router.post("/v1/owner/sites/:siteId/admins", async (context) => {
    const owner = await requireOwner(context.req.raw, options);
    if (isResponse(owner)) return owner;
    const siteId = context.req.param("siteId");
    const body = ownerAdminCreateInputSchema.safeParse(
      await readObject(context.req.raw),
    );
    if (!body.success) return invalidAccess();

    try {
      const created = await createSiteAdmin(options.db, {
        ...body.data,
        siteId,
        ...(options.now ? { now: options.now() } : {}),
      });
      const response = adminSummarySchema.parse(created);
      return context.json(response, 201, { "Cache-Control": "no-store" });
    } catch (error) {
      const response = accessError(error);
      if (response) return response;
      throw error;
    }
  });

  router.get("/v1/owner/sites/:siteId/admins", async (context) => {
    const owner = await requireOwner(context.req.raw, options);
    if (isResponse(owner)) return owner;
    try {
      const response = adminListResponseSchema.parse({
        admins: await listSiteAdmins(options.db, context.req.param("siteId")),
      });
      return context.json(response, 200, { "Cache-Control": "no-store" });
    } catch (error) {
      const response = accessError(error);
      if (response) return response;
      throw error;
    }
  });

  router.post("/v1/owner/admins/:userId/access", async (context) => {
    const owner = await requireOwner(context.req.raw, options);
    if (isResponse(owner)) return owner;
    const pathUserId = context.req.param("userId");
    const body = adminAccessIssueInputSchema.safeParse(
      await readObject(context.req.raw),
    );
    if (!body.success || body.data.userId !== pathUserId)
      return invalidAccess();

    try {
      const issued = await issueAdminAccess(options.db, {
        userId: pathUserId,
        purpose: body.data.purpose,
        ...(options.now ? { now: options.now() } : {}),
      });
      const response = adminAccessIssueResponseSchema.parse({
        ...issued,
        expiresAt: issued.expiresAt.toISOString(),
      });
      return context.json(response, 200, { "Cache-Control": "no-store" });
    } catch (error) {
      const response = accessError(error);
      if (response) return response;
      throw error;
    }
  });

  router.post("/v1/owner/admins/:userId/access/revoke", async (context) => {
    const owner = await requireOwner(context.req.raw, options);
    if (isResponse(owner)) return owner;
    const pathUserId = context.req.param("userId");
    const body = adminAccessRevokeInputSchema.safeParse(
      await readObject(context.req.raw),
    );
    if (!body.success || body.data.userId !== pathUserId)
      return invalidAccess();

    try {
      await revokeAdminAccess(options.db, {
        userId: pathUserId,
        purpose: body.data.purpose,
        ...(options.now ? { now: options.now() } : {}),
      });
      return context.json({ ok: true }, 200, { "Cache-Control": "no-store" });
    } catch (error) {
      const response = accessError(error);
      if (response) return response;
      throw error;
    }
  });

  router.post("/v1/owner/admins/:userId/disable", async (context) => {
    const owner = await requireOwner(context.req.raw, options);
    if (isResponse(owner)) return owner;
    const pathUserId = context.req.param("userId");
    const body = adminDisableInputSchema.safeParse(
      await readObject(context.req.raw),
    );
    if (!body.success || body.data.userId !== pathUserId)
      return invalidAccess();

    try {
      await disableAdmin(options.db, {
        userId: pathUserId,
        ...(options.now ? { now: options.now() } : {}),
      });
      return context.json({ ok: true }, 200, { "Cache-Control": "no-store" });
    } catch (error) {
      const response = accessError(error);
      if (response) return response;
      throw error;
    }
  });

  for (const [path, purpose] of [
    ["/v1/auth/activation/consume", "ACTIVATION"],
    ["/v1/auth/recovery/consume", "RECOVERY"],
  ] as const) {
    router.post(path, async (context) => {
      if (!trustedOrigin(context.req.raw, options.adminOrigin)) {
        return problem(403, "FORBIDDEN", "Forbidden");
      }
      const body = publicAccessConsumeInputSchema.safeParse(
        await readObject(context.req.raw),
      );
      if (!body.success) return invalidAccess();
      try {
        const consumed = await consumeAdminAccess(options.db, {
          ...body.data,
          purpose,
          ...(options.now ? { now: options.now() } : {}),
        });
        const response = publicAccessConsumeResponseSchema.parse({
          ...consumed,
          requiresExplicitLogin: true,
        });
        return context.json(response, 200, { "Cache-Control": "no-store" });
      } catch (error) {
        const response = accessError(error);
        if (response) return response;
        throw error;
      }
    });
  }

  router.notFound(() => problem(404, "NOT_FOUND", "Not Found"));
  return router;
}
