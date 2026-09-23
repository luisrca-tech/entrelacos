import {
  invitationAccessPinResponseSchema,
  invitationCreateInputSchema,
  invitationDeleteConfirmationSchema,
  invitationDeleteResponseSchema,
  invitationListResponseSchema,
  invitationResponseSchema,
  invitationUpdateInputSchema,
} from "@entrelacos/contracts";
import { Hono } from "hono";
import type { AuthHttpOptions } from "./authHttp";
import { AdminSessionRequiredError, requireAdminSession } from "./authHttp";
import {
  createInvitation,
  deleteInvitation,
  getInvitationAccessPin,
  type InvitationActor,
  InvitationServiceError,
  listInvitations,
  rotateInvitationAccessPin,
  updateInvitation,
} from "./invitations";

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
): Promise<Response | InvitationActor> {
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

function isResponse(value: Response | InvitationActor): value is Response {
  return value instanceof Response;
}

function serviceError(error: unknown): Response | undefined {
  if (error instanceof InvitationServiceError) {
    return problem(error.status, error.code, error.title);
  }
  if (error instanceof Error && error.name === "ZodError") {
    return problem(400, "VALIDATION_ERROR", "Invalid invitation request");
  }
  return undefined;
}

function responseOrThrow(error: unknown): Response {
  const response = serviceError(error);
  if (response) return response;
  throw error;
}

export function createInvitationsHttpRouter(options: AuthHttpOptions): Hono {
  const router = new Hono();
  router.onError((error) => {
    return (
      serviceError(error) ??
      problem(503, "SERVICE_UNAVAILABLE", "Service unavailable")
    );
  });

  router.get("/v1/sites/:siteId/invitations", async (context) => {
    const actor = await requireActor(context.req.raw, options);
    if (isResponse(actor)) return actor;
    try {
      const records = await listInvitations(
        options.db,
        actor,
        context.req.param("siteId"),
      );
      return context.json(
        invitationListResponseSchema.parse({ invitations: records }),
        200,
        { "Cache-Control": "no-store" },
      );
    } catch (error) {
      return responseOrThrow(error);
    }
  });

  router.post("/v1/sites/:siteId/invitations", async (context) => {
    const actor = await requireActor(context.req.raw, options);
    if (isResponse(actor)) return actor;
    try {
      const record = await createInvitation(
        options.db,
        actor,
        context.req.param("siteId"),
        invitationCreateInputSchema.parse(await readObject(context.req.raw)),
        options.now?.(),
      );
      return context.json(
        invitationResponseSchema.parse({ invitation: record }),
        201,
        { "Cache-Control": "no-store" },
      );
    } catch (error) {
      return responseOrThrow(error);
    }
  });

  router.patch(
    "/v1/sites/:siteId/invitations/:invitationId",
    async (context) => {
      const actor = await requireActor(context.req.raw, options);
      if (isResponse(actor)) return actor;
      try {
        const record = await updateInvitation(
          options.db,
          actor,
          context.req.param("siteId"),
          context.req.param("invitationId"),
          invitationUpdateInputSchema.parse(await readObject(context.req.raw)),
          options.now?.(),
        );
        return context.json(
          invitationResponseSchema.parse({ invitation: record }),
          200,
          { "Cache-Control": "no-store" },
        );
      } catch (error) {
        return responseOrThrow(error);
      }
    },
  );

  router.delete(
    "/v1/sites/:siteId/invitations/:invitationId",
    async (context) => {
      const actor = await requireActor(context.req.raw, options);
      if (isResponse(actor)) return actor;
      try {
        const result = await deleteInvitation(
          options.db,
          actor,
          context.req.param("siteId"),
          context.req.param("invitationId"),
          invitationDeleteConfirmationSchema.parse(
            await readObject(context.req.raw),
          ),
          options.now?.(),
        );
        return context.json(invitationDeleteResponseSchema.parse(result), 200, {
          "Cache-Control": "no-store",
        });
      } catch (error) {
        return responseOrThrow(error);
      }
    },
  );

  router.get(
    "/v1/sites/:siteId/invitations/:invitationId/access-pin",
    async (context) => {
      const actor = await requireActor(context.req.raw, options);
      if (isResponse(actor)) return actor;
      try {
        const result = await getInvitationAccessPin(
          options.db,
          actor,
          context.req.param("siteId"),
          context.req.param("invitationId"),
          options.guestFingerprintSecret ?? "",
        );
        return context.json(
          invitationAccessPinResponseSchema.parse(result),
          200,
          { "Cache-Control": "no-store" },
        );
      } catch (error) {
        return responseOrThrow(error);
      }
    },
  );

  router.post(
    "/v1/sites/:siteId/invitations/:invitationId/access-pin/rotate",
    async (context) => {
      const actor = await requireActor(context.req.raw, options);
      if (isResponse(actor)) return actor;
      try {
        const result = await rotateInvitationAccessPin(
          options.db,
          actor,
          context.req.param("siteId"),
          context.req.param("invitationId"),
          options.guestFingerprintSecret ?? "",
          options.now?.(),
        );
        return context.json(
          invitationAccessPinResponseSchema.parse(result),
          200,
          { "Cache-Control": "no-store" },
        );
      } catch (error) {
        return responseOrThrow(error);
      }
    },
  );

  router.notFound(() => problem(404, "NOT_FOUND", "Not Found"));
  return router;
}
