import {
  dateEditInputSchema,
  emptyMutationInputSchema,
  ownerSiteCreateInputSchema,
  ownerSiteCreateResponseSchema,
  ownerSiteLifecycleResponseSchema,
  ownerSiteListResponseSchema,
  ownerSiteResponseSchema,
  ownerSiteResumeInputSchema,
  ownerSiteResumeResponseSchema,
  ownerSiteUpdateResponseSchema,
  siteDomainCreateInputSchema,
  siteDomainListResponseSchema,
  siteDomainRecordSchema,
  siteDomainUpdateInputSchema,
  sitePublicationUpdateInputSchema,
  siteReviewApproveInputSchema,
  siteScopedReadResponseSchema,
  siteStartReviewInputSchema,
  siteUpdateInputSchema,
} from "@entrelacos/contracts";
import { type Context, Hono } from "hono";
import type { AuthHttpOptions } from "./authHttp";
import { requireAdminSession } from "./authHttp";
import {
  approveReview,
  createDomain,
  createSite,
  deactivateSite,
  editSiteDates,
  getSite,
  getSiteForActor,
  listDomains,
  listSites,
  reactivateSite,
  resumeSite,
  type SiteActor,
  SiteServiceError,
  startReview,
  updateDomain,
  updatePublication,
  updateSite,
} from "./sites";

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
): Promise<Response | SiteActor> {
  if (!trustedOrigin(request, options.adminOrigin)) {
    return problem(403, "FORBIDDEN", "Forbidden");
  }
  try {
    const actor = await requireAdminSession(request, options);
    if (actor.user.role !== "OWNER")
      return problem(403, "FORBIDDEN", "Forbidden");
    return { userId: actor.user.id, role: "OWNER" };
  } catch {
    return problem(401, "UNAUTHORIZED", "Authentication required");
  }
}

async function requireActor(
  request: Request,
  options: AuthHttpOptions,
): Promise<Response | SiteActor> {
  if (!trustedOrigin(request, options.adminOrigin)) {
    return problem(403, "FORBIDDEN", "Forbidden");
  }
  try {
    const actor = await requireAdminSession(request, options);
    return { userId: actor.user.id, role: actor.user.role };
  } catch {
    return problem(401, "UNAUTHORIZED", "Authentication required");
  }
}

function isResponse(value: Response | SiteActor): value is Response {
  return value instanceof Response;
}

function serviceError(error: unknown): Response | undefined {
  if (error instanceof SiteServiceError) {
    return problem(error.status, error.code, error.title);
  }
  if (error instanceof Error && error.name === "ZodError") {
    return problem(400, "VALIDATION_ERROR", "Invalid site request");
  }
  return undefined;
}

function responseOrThrow(error: unknown): Response {
  const response = serviceError(error);
  if (response) return response;
  throw error;
}

function sendSite(context: Context, site: unknown) {
  return context.json(site, 200, { "Cache-Control": "no-store" });
}

export function createSitesHttpRouter(options: AuthHttpOptions): Hono {
  const router = new Hono();
  router.onError((error) => {
    if (error instanceof Response) return error;
    const response = serviceError(error);
    return (
      response ?? problem(503, "SERVICE_UNAVAILABLE", "Service unavailable")
    );
  });

  router.get("/v1/owner/sites", async (context) => {
    const owner = await requireOwner(context.req.raw, options);
    if (isResponse(owner)) return owner;
    try {
      const url = new URL(context.req.url);
      const query = Object.fromEntries(url.searchParams.entries());
      const result = await listSites(options.db, query);
      return context.json(ownerSiteListResponseSchema.parse(result), 200, {
        "Cache-Control": "no-store",
      });
    } catch (error) {
      return responseOrThrow(error);
    }
  });

  router.post("/v1/owner/sites", async (context) => {
    const owner = await requireOwner(context.req.raw, options);
    if (isResponse(owner)) return owner;
    try {
      const body = ownerSiteCreateInputSchema.parse(
        await readObject(context.req.raw),
      );
      const result = await createSite(options.db, body, options.now?.());
      return context.json(
        ownerSiteCreateResponseSchema.parse({ site: result }),
        201,
        { "Cache-Control": "no-store" },
      );
    } catch (error) {
      return responseOrThrow(error);
    }
  });

  router.post("/v1/owner/sites/resume", async (context) => {
    const owner = await requireOwner(context.req.raw, options);
    if (isResponse(owner)) return owner;
    try {
      const body = ownerSiteResumeInputSchema.parse(
        await readObject(context.req.raw),
      );
      const result = await resumeSite(options.db, body);
      return sendSite(
        context,
        ownerSiteResumeResponseSchema.parse({ site: result }),
      );
    } catch (error) {
      return responseOrThrow(error);
    }
  });

  router.get("/v1/owner/sites/:siteId", async (context) => {
    const owner = await requireOwner(context.req.raw, options);
    if (isResponse(owner)) return owner;
    try {
      const result = await getSite(options.db, context.req.param("siteId"));
      return sendSite(context, ownerSiteResponseSchema.parse({ site: result }));
    } catch (error) {
      return responseOrThrow(error);
    }
  });

  router.patch("/v1/owner/sites/:siteId", async (context) => {
    const owner = await requireOwner(context.req.raw, options);
    if (isResponse(owner)) return owner;
    try {
      const body = siteUpdateInputSchema.parse(
        await readObject(context.req.raw),
      );
      const result = await updateSite(
        options.db,
        context.req.param("siteId"),
        body,
        options.now?.(),
      );
      return sendSite(
        context,
        ownerSiteUpdateResponseSchema.parse({ site: result }),
      );
    } catch (error) {
      return responseOrThrow(error);
    }
  });

  router.post("/v1/owner/sites/:siteId/review/start", async (context) => {
    const owner = await requireOwner(context.req.raw, options);
    if (isResponse(owner)) return owner;
    try {
      const body = siteStartReviewInputSchema.parse(
        await readObject(context.req.raw),
      );
      const result = await startReview(
        options.db,
        context.req.param("siteId"),
        body,
        options.now?.(),
      );
      return sendSite(
        context,
        ownerSiteLifecycleResponseSchema.parse({ site: result }),
      );
    } catch (error) {
      return responseOrThrow(error);
    }
  });

  router.post("/v1/owner/sites/:siteId/review/approve", async (context) => {
    const owner = await requireOwner(context.req.raw, options);
    if (isResponse(owner)) return owner;
    try {
      const body = siteReviewApproveInputSchema.parse(
        await readObject(context.req.raw),
      );
      const result = await approveReview(
        options.db,
        context.req.param("siteId"),
        body,
        options.now?.(),
      );
      return sendSite(
        context,
        ownerSiteLifecycleResponseSchema.parse({ site: result }),
      );
    } catch (error) {
      return responseOrThrow(error);
    }
  });

  router.patch("/v1/owner/sites/:siteId/publication", async (context) => {
    const owner = await requireOwner(context.req.raw, options);
    if (isResponse(owner)) return owner;
    try {
      const body = sitePublicationUpdateInputSchema.parse(
        await readObject(context.req.raw),
      );
      const result = await updatePublication(
        options.db,
        context.req.param("siteId"),
        body,
        options.now?.(),
      );
      return sendSite(
        context,
        ownerSiteLifecycleResponseSchema.parse({ site: result }),
      );
    } catch (error) {
      return responseOrThrow(error);
    }
  });

  for (const [path, action] of [
    ["/v1/owner/sites/:siteId/deactivate", deactivateSite],
    ["/v1/owner/sites/:siteId/reactivate", reactivateSite],
  ] as const) {
    router.post(path, async (context) => {
      const owner = await requireOwner(context.req.raw, options);
      if (isResponse(owner)) return owner;
      try {
        emptyMutationInputSchema.parse(await readObject(context.req.raw));
        const result = await action(
          options.db,
          context.req.param("siteId"),
          options.now?.(),
        );
        return sendSite(
          context,
          ownerSiteLifecycleResponseSchema.parse({ site: result }),
        );
      } catch (error) {
        return responseOrThrow(error);
      }
    });
  }

  router.patch("/v1/owner/sites/:siteId/dates", async (context) => {
    const owner = await requireOwner(context.req.raw, options);
    if (isResponse(owner)) return owner;
    try {
      const body = dateEditInputSchema.parse(await readObject(context.req.raw));
      const result = await editSiteDates(
        options.db,
        context.req.param("siteId"),
        body,
        options.now?.(),
      );
      return sendSite(
        context,
        ownerSiteLifecycleResponseSchema.parse({ site: result }),
      );
    } catch (error) {
      return responseOrThrow(error);
    }
  });

  router.get("/v1/sites/:siteId", async (context) => {
    const actor = await requireActor(context.req.raw, options);
    if (isResponse(actor)) return actor;
    try {
      const site = await getSiteForActor(
        options.db,
        actor,
        context.req.param("siteId"),
      );
      return sendSite(context, siteScopedReadResponseSchema.parse({ site }));
    } catch (error) {
      return responseOrThrow(error);
    }
  });

  router.post("/v1/owner/sites/:siteId/domains", async (context) => {
    const owner = await requireOwner(context.req.raw, options);
    if (isResponse(owner)) return owner;
    try {
      const body = siteDomainCreateInputSchema.parse(
        await readObject(context.req.raw),
      );
      const result = await createDomain(
        options.db,
        context.req.param("siteId"),
        body,
        options.now?.(),
      );
      return context.json(siteDomainRecordSchema.parse(result), 201, {
        "Cache-Control": "no-store",
      });
    } catch (error) {
      return responseOrThrow(error);
    }
  });

  router.get("/v1/owner/sites/:siteId/domains", async (context) => {
    const owner = await requireOwner(context.req.raw, options);
    if (isResponse(owner)) return owner;
    try {
      const domains = await listDomains(
        options.db,
        context.req.param("siteId"),
      );
      return context.json(
        siteDomainListResponseSchema.parse({ domains }),
        200,
        {
          "Cache-Control": "no-store",
        },
      );
    } catch (error) {
      return responseOrThrow(error);
    }
  });

  router.patch("/v1/owner/sites/:siteId/domains/:domainId", async (context) => {
    const owner = await requireOwner(context.req.raw, options);
    if (isResponse(owner)) return owner;
    try {
      const body = siteDomainUpdateInputSchema.parse(
        await readObject(context.req.raw),
      );
      const result = await updateDomain(
        options.db,
        context.req.param("siteId"),
        context.req.param("domainId"),
        body,
        options.now?.(),
      );
      return context.json(siteDomainRecordSchema.parse(result), 200, {
        "Cache-Control": "no-store",
      });
    } catch (error) {
      return responseOrThrow(error);
    }
  });

  router.notFound(() => problem(404, "NOT_FOUND", "Not Found"));
  return router;
}
