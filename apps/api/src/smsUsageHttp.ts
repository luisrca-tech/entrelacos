import {
  siteIdSchema,
  smsQuotaInputSchema,
  smsQuotaResponseSchema,
  smsUsageResponseSchema,
} from "@entrelacos/contracts";
import { Hono } from "hono";
import type { AuthHttpOptions } from "./authHttp";
import { AdminSessionRequiredError, requireAdminSession } from "./authHttp";
import {
  readSmsUsage,
  type SmsUsageAdminActor,
  SmsUsageServiceError,
  updateSmsQuota,
} from "./smsUsage";

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

async function requireActor(
  request: Request,
  options: AuthHttpOptions,
): Promise<Response | SmsUsageAdminActor> {
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

function serviceError(error: unknown): Response | undefined {
  if (error instanceof SmsUsageServiceError)
    return problem(error.status, error.code, error.title);
  if (error instanceof Error && error.name === "ZodError")
    return problem(400, "VALIDATION_ERROR", "Invalid SMS usage request");
  return undefined;
}

export function createSmsUsageHttpRouter(options: AuthHttpOptions): Hono {
  const router = new Hono();
  router.onError(
    (error) =>
      serviceError(error) ??
      problem(503, "SERVICE_UNAVAILABLE", "Service unavailable"),
  );

  router.get("/v1/sites/:siteId/sms-usage", async (context) => {
    const actor = await requireActor(context.req.raw, options);
    if (actor instanceof Response) return actor;
    const parsedSiteId = siteIdSchema.safeParse(context.req.param("siteId"));
    if (!parsedSiteId.success)
      return problem(400, "VALIDATION_ERROR", "Invalid SMS usage request");
    try {
      const usage = await readSmsUsage(
        options.db,
        actor,
        parsedSiteId.data,
        options.now?.(),
      );
      return context.json(smsUsageResponseSchema.parse(usage), 200, {
        "Cache-Control": "no-store",
      });
    } catch (error) {
      const response = serviceError(error);
      if (response) return response;
      throw error;
    }
  });

  router.patch("/v1/owner/sites/:siteId/sms-quota", async (context) => {
    const actor = await requireActor(context.req.raw, options);
    if (actor instanceof Response) return actor;
    if (actor.role !== "OWNER") return problem(403, "FORBIDDEN", "Forbidden");
    const parsedSiteId = siteIdSchema.safeParse(context.req.param("siteId"));
    if (!parsedSiteId.success)
      return problem(400, "VALIDATION_ERROR", "Invalid SMS usage request");
    const body = smsQuotaInputSchema.safeParse(
      await readObject(context.req.raw),
    );
    if (!body.success)
      return problem(400, "VALIDATION_ERROR", "Invalid SMS usage request");
    try {
      const result = await updateSmsQuota(
        options.db,
        actor,
        parsedSiteId.data,
        body.data,
        options.now?.(),
      );
      return context.json(smsQuotaResponseSchema.parse(result), 200, {
        "Cache-Control": "no-store",
      });
    } catch (error) {
      const response = serviceError(error);
      if (response) return response;
      throw error;
    }
  });

  return router;
}
