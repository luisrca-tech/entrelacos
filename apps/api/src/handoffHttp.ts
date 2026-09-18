import {
  handoffIssueInputSchema,
  handoffRecognitionInputSchema,
  handoffRedeemInputSchema,
} from "@entrelacos/contracts";
import { siteOrigin } from "@entrelacos/database/schema";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { type AuthHttpOptions, getAdministrativeSession } from "./authHttp";
import { issueHandoff, recognizeSite, redeemHandoff } from "./handoff";
import { allowsLocalPublicOrigin } from "./localPublicOrigin";

function problem(status: number, code: string) {
  return new Response(
    JSON.stringify({
      type: "about:blank",
      title: "Handoff request rejected",
      status,
      code,
    }),
    {
      status,
      headers: {
        "Content-Type": "application/problem+json",
        "Cache-Control": "no-store",
      },
    },
  );
}
async function readBody(request: Request) {
  if (
    !request.headers
      .get("Content-Type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    return null;
  return request.json().catch(() => null);
}
export function createHandoffHttpRouter(options: AuthHttpOptions) {
  const router = new Hono();
  router.onError(() => problem(503, "SERVICE_UNAVAILABLE"));
  async function registered(origin: string, request: Request, siteId?: string) {
    if (allowsLocalPublicOrigin(request.url, origin)) return true;
    const rows = await options.db
      .select({ id: siteOrigin.id })
      .from(siteOrigin)
      .where(
        siteId
          ? and(eq(siteOrigin.origin, origin), eq(siteOrigin.siteId, siteId))
          : eq(siteOrigin.origin, origin),
      )
      .limit(1);
    return rows.length === 1;
  }
  router.post("/v1/handoff", async (context) => {
    if (context.req.header("Origin") !== options.adminOrigin)
      return problem(403, "FORBIDDEN");
    const actor = await getAdministrativeSession(context.req.raw, options);
    if (!actor) return problem(401, "UNAUTHORIZED");
    const parsed = handoffIssueInputSchema.safeParse(
      await readBody(context.req.raw),
    );
    if (!parsed.success) return problem(400, "VALIDATION_ERROR");
    const data = parsed.data;
    if (
      (actor.user.role !== "OWNER" && actor.siteId !== data.siteId) ||
      !(await registered(data.origin, context.req.raw, data.siteId))
    )
      return problem(403, "FORBIDDEN");
    try {
      return context.json(
        await issueHandoff(options.db, {
          ...data,
          parentSessionId: actor.session.id,
          now: options.now?.(),
        }),
        200,
        { "Cache-Control": "no-store" },
      );
    } catch {
      return problem(400, "INVALID_HANDOFF");
    }
  });
  for (const operation of ["redeem", "recognize"] as const) {
    router.options(`/v1/handoff/${operation}`, async (context) => {
      const origin = context.req.header("Origin");
      if (!origin || !(await registered(origin, context.req.raw)))
        return problem(403, "FORBIDDEN");
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers": "Content-Type",
          Vary: "Origin",
          "Cache-Control": "no-store",
        },
      });
    });
    router.post(`/v1/handoff/${operation}`, async (context) => {
      const body = await readBody(context.req.raw);
      const parsed = (
        operation === "redeem"
          ? handoffRedeemInputSchema
          : handoffRecognitionInputSchema
      ).safeParse(body);
      if (!parsed.success) return problem(400, "VALIDATION_ERROR");
      const { origin, siteId } = parsed.data;
      if (
        context.req.header("Origin") !== origin ||
        !(await registered(origin, context.req.raw, siteId))
      )
        return problem(403, "FORBIDDEN");
      context.header("Access-Control-Allow-Origin", origin);
      context.header("Vary", "Origin");
      context.header("Cache-Control", "no-store");
      try {
        if (operation === "redeem")
          return context.json(
            await redeemHandoff(options.db, {
              ...handoffRedeemInputSchema.parse(body),
              now: options.now?.(),
            }),
          );
        return context.json({
          recognized: await recognizeSite(options.db, {
            ...handoffRecognitionInputSchema.parse(body),
            now: options.now?.(),
          }),
        });
      } catch {
        return context.json(
          {
            type: "about:blank",
            title: "Handoff request rejected",
            status: 400,
            code: "INVALID_HANDOFF",
          },
          400,
        );
      }
    });
  }
  return router;
}
