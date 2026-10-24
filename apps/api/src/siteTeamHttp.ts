import {
  siteAccessResponseSchema,
  siteIdSchema,
  siteTeamAcceptInputSchema,
  siteTeamAcceptResponseSchema,
  siteTeamInvitationSchema,
  siteTeamInviteInputSchema,
  siteTeamInviteResponseSchema,
  siteTeamMemberSchema,
  siteTeamResponseSchema,
  siteTeamRevokeInputSchema,
} from "@entrelacos/contracts";
import { Hono } from "hono";
import { trustedAdminOrigin } from "./adminOrigin";
import {
  AdminSessionRequiredError,
  type AuthHttpOptions,
  getAdministrativeSession,
  requireAdminSession,
} from "./authHttp";
import {
  resolveSiteAccess,
  type SiteAccessActor,
  SiteAccessDeniedError,
} from "./siteAccess";
import {
  acceptSiteAssessorInvitation,
  issueSiteAssessorInvitation,
  listSiteTeam,
  revokeSiteAssessorInvitation,
  revokeSiteAssessorMembership,
  SiteTeamServiceError,
} from "./siteTeam";

function problem(status: number, code: string, title: string): Response {
  return new Response(
    JSON.stringify({ type: "about:blank", status, code, title }),
    {
      status,
      headers: {
        "Content-Type": "application/problem+json",
        "Cache-Control": "no-store",
      },
    },
  );
}

async function readBody(request: Request): Promise<unknown> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    return undefined;
  return request.json().catch(() => undefined);
}

export function createSiteTeamHttpRouter(options: AuthHttpOptions) {
  const router = new Hono<{ Variables: { actor: SiteAccessActor } }>();
  router.onError((error) => {
    if (error instanceof AdminSessionRequiredError)
      return problem(401, "UNAUTHORIZED", "Authentication required");
    if (error instanceof SiteAccessDeniedError)
      return problem(403, "MEMBERSHIP_DENIED", "Site membership denied");
    if (error instanceof SiteTeamServiceError)
      return problem(error.status, error.code, "Team operation rejected");
    return problem(503, "SERVICE_UNAVAILABLE", "Team service unavailable");
  });
  router.use("*", async (context, next) => {
    if (!trustedAdminOrigin(context.req.header("origin"), options.adminOrigin))
      return problem(403, "FORBIDDEN", "Forbidden");
    context.header("Cache-Control", "no-store");
    await next();
  });
  router.use("/v1/sites/:siteId/*", async (context, next) => {
    if (!siteIdSchema.safeParse(context.req.param("siteId")).success)
      return problem(400, "VALIDATION_ERROR", "Invalid site identifier");
    const actor = await requireAdminSession(context.req.raw, options);
    context.set("actor", { userId: actor.user.id, role: actor.user.role });
    await next();
  });
  router.get("/v1/sites/:siteId/access", async (context) => {
    const actor = context.get("actor");
    const access = await resolveSiteAccess(options.db, {
      userId: actor.userId,
      platformRole: actor.role,
      siteId: context.req.param("siteId"),
    });
    if (!access) throw new SiteAccessDeniedError();
    return context.json(siteAccessResponseSchema.parse({ access }));
  });
  router.get("/v1/sites/:siteId/team", async (context) =>
    context.json(
      siteTeamResponseSchema.parse(
        await listSiteTeam(
          options.db,
          context.get("actor"),
          context.req.param("siteId"),
        ),
      ),
    ),
  );
  router.post("/v1/sites/:siteId/team/invitations", async (context) => {
    const body = siteTeamInviteInputSchema.safeParse(
      await readBody(context.req.raw),
    );
    if (!body.success)
      return problem(400, "VALIDATION_ERROR", "Invalid invitation payload");
    return context.json(
      siteTeamInviteResponseSchema.parse(
        await issueSiteAssessorInvitation(
          options.db,
          context.get("actor"),
          context.req.param("siteId"),
          body.data,
          options.now?.(),
        ),
      ),
      201,
    );
  });
  router.post(
    "/v1/sites/:siteId/team/invitations/:invitationId/revoke",
    async (context) => {
      const id = siteTeamInvitationSchema.shape.id.safeParse(
        context.req.param("invitationId"),
      );
      const body = siteTeamRevokeInputSchema.safeParse(
        await readBody(context.req.raw),
      );
      if (!id.success || !body.success)
        return problem(
          400,
          "VALIDATION_ERROR",
          "Invalid invitation revocation",
        );
      await revokeSiteAssessorInvitation(
        options.db,
        context.get("actor"),
        context.req.param("siteId"),
        id.data,
        options.now?.(),
      );
      return context.json({ ok: true });
    },
  );
  router.post(
    "/v1/sites/:siteId/team/members/:userId/revoke",
    async (context) => {
      const id = siteTeamMemberSchema.shape.userId.safeParse(
        context.req.param("userId"),
      );
      const body = siteTeamRevokeInputSchema.safeParse(
        await readBody(context.req.raw),
      );
      if (!id.success || !body.success)
        return problem(
          400,
          "VALIDATION_ERROR",
          "Invalid membership revocation",
        );
      await revokeSiteAssessorMembership(
        options.db,
        context.get("actor"),
        context.req.param("siteId"),
        id.data,
        options.now?.(),
      );
      return context.json({ ok: true });
    },
  );
  router.post("/v1/team-invitations/accept", async (context) => {
    const body = siteTeamAcceptInputSchema.safeParse(
      await readBody(context.req.raw),
    );
    if (!body.success)
      return problem(400, "VALIDATION_ERROR", "Invalid invitation acceptance");
    const session = await getAdministrativeSession(context.req.raw, options);
    const actor = session
      ? { userId: session.user.id, role: session.user.role }
      : null;
    return context.json(
      siteTeamAcceptResponseSchema.parse(
        await acceptSiteAssessorInvitation(
          options.db,
          body.data,
          actor,
          options.now?.(),
        ),
      ),
    );
  });
  return router;
}
