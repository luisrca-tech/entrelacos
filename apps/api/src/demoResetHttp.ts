import {
  demoResetInputSchema,
  demoResetResponseSchema,
} from "@entrelacos/contracts";
import { Hono } from "hono";
import {
  AdminSessionRequiredError,
  type AuthHttpOptions,
  requireAdminSession,
} from "./authHttp";
import { DemoResetServiceError, resetDemoSite } from "./demoReset";
import type {
  ObservabilityEvent,
  ObservabilityVariables,
} from "./observability";

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

function trustedAdminOrigin(request: Request, adminOrigin: string): boolean {
  return request.headers.get("origin") === adminOrigin;
}

async function readResetBody(request: Request): Promise<unknown> {
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

function emitResetEvent(
  context: {
    get(key: "observabilityEmit"): ObservabilityVariables["observabilityEmit"];
  },
  event: Omit<ObservabilityEvent, "requestId">,
): void {
  context.get("observabilityEmit")?.(event);
}

function serviceProblem(error: unknown): Response | undefined {
  if (error instanceof DemoResetServiceError) {
    return problem(error.status, error.code, error.title);
  }
  return undefined;
}

export function createDemoResetHttpRouter(
  options: AuthHttpOptions,
): Hono<{ Variables: ObservabilityVariables }> {
  const router = new Hono<{ Variables: ObservabilityVariables }>();

  router.onError(() =>
    problem(503, "SERVICE_UNAVAILABLE", "Service unavailable"),
  );

  router.post("/v1/owner/sites/:siteId/demo/reset", async (context) => {
    const request = context.req.raw;
    const siteId = context.req.param("siteId");

    if (!trustedAdminOrigin(request, options.adminOrigin)) {
      emitResetEvent(context, {
        event: "demo.reset",
        routeTemplate: "/v1/owner/sites/:siteId/demo/reset",
        method: "POST",
        operation: "demo_reset",
        result: "failure",
        siteId,
        mode: "manual",
        errorCode: "FORBIDDEN",
      });
      return problem(403, "FORBIDDEN", "Forbidden");
    }

    let actor: Awaited<ReturnType<typeof requireAdminSession>>;
    try {
      actor = await requireAdminSession(request, options);
    } catch (error) {
      if (error instanceof AdminSessionRequiredError) {
        emitResetEvent(context, {
          event: "demo.reset",
          routeTemplate: "/v1/owner/sites/:siteId/demo/reset",
          method: "POST",
          operation: "demo_reset",
          result: "failure",
          siteId,
          mode: "manual",
          errorCode: "UNAUTHORIZED",
        });
        return problem(401, "UNAUTHORIZED", "Authentication required");
      }
      throw error;
    }

    if (actor.user.role !== "OWNER") {
      emitResetEvent(context, {
        event: "demo.reset",
        routeTemplate: "/v1/owner/sites/:siteId/demo/reset",
        method: "POST",
        operation: "demo_reset",
        result: "failure",
        siteId,
        actorRole: actor.user.role,
        mode: "manual",
        errorCode: "FORBIDDEN",
      });
      return problem(403, "FORBIDDEN", "Forbidden");
    }

    if (new URL(request.url).searchParams.size > 0) {
      emitResetEvent(context, {
        event: "demo.reset",
        routeTemplate: "/v1/owner/sites/:siteId/demo/reset",
        method: "POST",
        operation: "demo_reset",
        result: "failure",
        siteId,
        actorRole: "OWNER",
        mode: "manual",
        errorCode: "VALIDATION_ERROR",
      });
      return problem(400, "VALIDATION_ERROR", "Invalid demo reset payload");
    }

    const input = demoResetInputSchema.safeParse(await readResetBody(request));
    if (!input.success) {
      emitResetEvent(context, {
        event: "demo.reset",
        routeTemplate: "/v1/owner/sites/:siteId/demo/reset",
        method: "POST",
        operation: "demo_reset",
        result: "failure",
        siteId,
        actorRole: "OWNER",
        mode: "manual",
        errorCode: "VALIDATION_ERROR",
      });
      return problem(400, "VALIDATION_ERROR", "Invalid demo reset payload");
    }

    try {
      const response = demoResetResponseSchema.parse(
        await resetDemoSite(
          options.db,
          { userId: actor.user.id, role: "OWNER" },
          siteId,
          { clock: { now: () => options.now?.() ?? new Date() } },
        ),
      );
      emitResetEvent(context, {
        event: "demo.reset",
        routeTemplate: "/v1/owner/sites/:siteId/demo/reset",
        method: "POST",
        status: 200,
        operation: "demo_reset",
        result: "success",
        siteId: response.siteId,
        actorRole: "OWNER",
        mode: "manual",
        datasetVersion: input.data.datasetVersion,
        count:
          response.counts.groups +
          response.counts.members +
          response.counts.messages,
      });
      return context.json(response, 200, { "Cache-Control": "no-store" });
    } catch (error) {
      const response = serviceProblem(error);
      if (response) {
        emitResetEvent(context, {
          event: "demo.reset",
          routeTemplate: "/v1/owner/sites/:siteId/demo/reset",
          method: "POST",
          status: response.status,
          operation: "demo_reset",
          result: "failure",
          siteId,
          actorRole: "OWNER",
          mode: "manual",
          datasetVersion: input.data.datasetVersion,
          errorCode:
            error instanceof DemoResetServiceError ? error.code : undefined,
        });
        return response;
      }
      emitResetEvent(context, {
        event: "demo.reset",
        routeTemplate: "/v1/owner/sites/:siteId/demo/reset",
        method: "POST",
        status: 503,
        operation: "demo_reset",
        result: "failure",
        siteId,
        actorRole: "OWNER",
        mode: "manual",
        datasetVersion: input.data.datasetVersion,
        errorCode: "SERVICE_UNAVAILABLE",
      });
      throw error;
    }
  });

  return router;
}
