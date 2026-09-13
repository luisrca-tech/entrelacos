import {
  groupDeleteConfirmationSchema,
  guestAccessPinResponseSchema,
  guestGroupCreateInputSchema,
  guestGroupDeleteResponseSchema,
  guestGroupListResponseSchema,
  guestGroupResponseSchema,
} from "@entrelacos/contracts";
import { Hono } from "hono";
import type { AuthHttpOptions } from "./authHttp";
import { AdminSessionRequiredError, requireAdminSession } from "./authHttp";
import {
  createGuestGroup,
  deleteGuestGroup,
  type GuestGroupActor,
  GuestGroupServiceError,
  getGuestGroupAccessPin,
  listGuestGroups,
  rotateGuestGroupAccessPin,
  updateGuestGroup,
} from "./guestGroups";

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

async function requireActor(
  request: Request,
  options: AuthHttpOptions,
): Promise<Response | GuestGroupActor> {
  if (!trustedOrigin(request, options.adminOrigin)) {
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

function isResponse(value: Response | GuestGroupActor): value is Response {
  return value instanceof Response;
}

function serviceError(error: unknown): Response | undefined {
  if (error instanceof GuestGroupServiceError) {
    return problem(error.status, error.code, error.title);
  }
  if (error instanceof Error && error.name === "ZodError") {
    return problem(400, "VALIDATION_ERROR", "Invalid guest group request");
  }
  return undefined;
}

function responseOrThrow(error: unknown): Response {
  const response = serviceError(error);
  if (response) return response;
  throw error;
}

export function createGuestGroupsHttpRouter(options: AuthHttpOptions): Hono {
  const router = new Hono();
  router.onError((error) => {
    return (
      serviceError(error) ??
      problem(503, "SERVICE_UNAVAILABLE", "Service unavailable")
    );
  });

  router.get("/v1/sites/:siteId/groups", async (context) => {
    const actor = await requireActor(context.req.raw, options);
    if (isResponse(actor)) return actor;
    try {
      const groups = await listGuestGroups(
        options.db,
        actor,
        context.req.param("siteId"),
      );
      return context.json(guestGroupListResponseSchema.parse({ groups }), 200, {
        "Cache-Control": "no-store",
      });
    } catch (error) {
      return responseOrThrow(error);
    }
  });

  router.post("/v1/sites/:siteId/groups", async (context) => {
    const actor = await requireActor(context.req.raw, options);
    if (isResponse(actor)) return actor;
    try {
      const group = await createGuestGroup(
        options.db,
        actor,
        context.req.param("siteId"),
        guestGroupCreateInputSchema.parse(await readObject(context.req.raw)),
        options.now?.(),
      );
      return context.json(guestGroupResponseSchema.parse({ group }), 201, {
        "Cache-Control": "no-store",
      });
    } catch (error) {
      return responseOrThrow(error);
    }
  });

  router.patch("/v1/sites/:siteId/groups/:groupId", async (context) => {
    const actor = await requireActor(context.req.raw, options);
    if (isResponse(actor)) return actor;
    try {
      const group = await updateGuestGroup(
        options.db,
        actor,
        context.req.param("siteId"),
        context.req.param("groupId"),
        await readObject(context.req.raw),
        options.now?.(),
      );
      return context.json(guestGroupResponseSchema.parse({ group }), 200, {
        "Cache-Control": "no-store",
      });
    } catch (error) {
      return responseOrThrow(error);
    }
  });

  router.get(
    "/v1/sites/:siteId/groups/:groupId/access-pin",
    async (context) => {
      const actor = await requireActor(context.req.raw, options);
      if (isResponse(actor)) return actor;
      try {
        const result = await getGuestGroupAccessPin(
          options.db,
          actor,
          context.req.param("siteId"),
          context.req.param("groupId"),
          options.guestFingerprintSecret ?? "",
        );
        return context.json(guestAccessPinResponseSchema.parse(result), 200, {
          "Cache-Control": "no-store",
        });
      } catch (error) {
        return responseOrThrow(error);
      }
    },
  );

  router.post(
    "/v1/sites/:siteId/groups/:groupId/access-pin/rotate",
    async (context) => {
      const actor = await requireActor(context.req.raw, options);
      if (isResponse(actor)) return actor;
      try {
        const result = await rotateGuestGroupAccessPin(
          options.db,
          actor,
          context.req.param("siteId"),
          context.req.param("groupId"),
          options.guestFingerprintSecret ?? "",
          options.now?.(),
        );
        return context.json(guestAccessPinResponseSchema.parse(result), 200, {
          "Cache-Control": "no-store",
        });
      } catch (error) {
        return responseOrThrow(error);
      }
    },
  );

  router.delete("/v1/sites/:siteId/groups/:groupId", async (context) => {
    const actor = await requireActor(context.req.raw, options);
    if (isResponse(actor)) return actor;
    try {
      const result = await deleteGuestGroup(
        options.db,
        actor,
        context.req.param("siteId"),
        context.req.param("groupId"),
        groupDeleteConfirmationSchema.parse(await readObject(context.req.raw)),
        options.now?.(),
      );
      return context.json(guestGroupDeleteResponseSchema.parse(result), 200, {
        "Cache-Control": "no-store",
      });
    } catch (error) {
      return responseOrThrow(error);
    }
  });

  router.notFound(() => problem(404, "NOT_FOUND", "Not Found"));
  return router;
}
