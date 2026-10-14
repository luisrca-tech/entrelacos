import {
  financialReauthenticationInputSchema,
  financialReauthenticationResponseSchema,
  siteAccessSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import { Hono } from "hono";
import {
  AdminSessionRequiredError,
  type AuthHttpOptions,
  requireAdminSession,
} from "./authHttp";
import {
  type FinancialReauthentication,
  FinancialReauthenticationError,
} from "./financialReauthentication";
import { resolveSiteAccess } from "./siteAccess";

export type FinancialReauthenticationHttpOptions = AuthHttpOptions & {
  financialReauthentication?: FinancialReauthentication;
};
function problem(status: number, code: string, title: string) {
  return new Response(
    JSON.stringify({ type: "about:blank", status, code, title }),
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      },
    },
  );
}
async function readBody(request: Request): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(
      request.headers.get("content-type") ?? "",
    )
  )
    return undefined;
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 4096) {
        void reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
}
export function createFinancialReauthenticationHttpRouter(
  options: FinancialReauthenticationHttpOptions,
): Hono {
  const router = new Hono();
  router.onError((error) => {
    if (error instanceof AdminSessionRequiredError)
      return problem(401, "UNAUTHORIZED", "Authentication required");
    if (error instanceof FinancialReauthenticationError)
      return problem(error.status, error.code, error.message);
    return problem(
      503,
      "REAUTHENTICATION_UNAVAILABLE",
      "Financial reauthentication unavailable",
    );
  });
  router.post(
    "/v1/sites/:siteId/financial-reauthentication",
    async (context) => {
      if (context.req.header("origin") !== options.adminOrigin)
        return problem(403, "FORBIDDEN", "Forbidden");
      const actor = await requireAdminSession(context.req.raw, options);
      const siteId = siteIdSchema.safeParse(context.req.param("siteId"));
      if (!siteId.success || new URL(context.req.url).search)
        return problem(
          400,
          "VALIDATION_ERROR",
          "Invalid financial reauthentication request",
        );
      const access = siteAccessSchema.safeParse(
        await resolveSiteAccess(options.db, {
          userId: actor.user.id,
          platformRole: actor.user.role,
          siteId: siteId.data,
        }),
      );
      if (
        !access.success ||
        access.data.userId !== actor.user.id ||
        access.data.siteId !== siteId.data ||
        access.data.membershipRole !== "SITE_ADMIN" ||
        access.data.membershipId === null
      )
        return problem(403, "MEMBERSHIP_DENIED", "Financial membership denied");
      const body = financialReauthenticationInputSchema.safeParse(
        await readBody(context.req.raw),
      );
      if (!body.success)
        return problem(
          400,
          "VALIDATION_ERROR",
          "Invalid financial reauthentication payload",
        );
      if (
        body.data.action === "CONFIGURE_RECEIVING"
          ? !access.data.capabilities.configureReceiving
          : !access.data.capabilities.readFinance
      )
        return problem(403, "MEMBERSHIP_DENIED", "Financial membership denied");
      if (!options.financialReauthentication)
        return problem(
          409,
          "PROVIDER_MODE_UNAVAILABLE",
          "Financial reauthentication unavailable",
        );
      const response = financialReauthenticationResponseSchema.safeParse(
        await options.financialReauthentication.authenticate(
          {
            userId: actor.user.id,
            siteId: siteId.data,
            sessionId: actor.session.id,
          },
          body.data.action,
          body.data.password,
        ),
      );
      if (!response.success)
        return problem(
          503,
          "REAUTHENTICATION_UNAVAILABLE",
          "Financial reauthentication unavailable",
        );
      return context.json(response.data, 200, { "Cache-Control": "no-store" });
    },
  );
  return router;
}
