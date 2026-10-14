import {
  receivingNominationContextResponseSchema,
  receivingNominationInputSchema,
  receivingNominationResponseSchema,
  siteAccessSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import { Hono } from "hono";
import {
  type AdministrativeActor,
  AdminSessionRequiredError,
  type AuthHttpOptions,
  requireAdminSession,
} from "./authHttp";
import {
  type FinancialReauthentication,
  FinancialReauthenticationError,
} from "./financialReauthentication";
import {
  deriveReceivingNominationRequestId,
  type ReceivingNominationService,
  ReceivingNominationServiceError,
  readReceivingNominationConfiguration,
  readReceivingNominationSnapshot,
} from "./receivingNomination";
import type { ReceivingNominationContextService } from "./receivingNominationContext";
import { resolveSiteAccess } from "./siteAccess";
export type ReceivingNominationHttpOptions = AuthHttpOptions & {
  financialReauthentication?: FinancialReauthentication;
  receivingNomination?: ReceivingNominationService;
  receivingNominationContext?: ReceivingNominationContextService;
  // Explicit read-only seam; never substitute the activity-touching helper.
  readAdministrativeSession?: (
    request: Request,
    options: Pick<AuthHttpOptions, "auth" | "db" | "now">,
  ) => Promise<AdministrativeActor | null>;
};
function problem(status: number, code: string) {
  return new Response(
    JSON.stringify({
      type: "about:blank",
      status,
      code,
      title: "Receiving nomination unavailable",
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
export function createReceivingNominationHttpRouter(
  options: ReceivingNominationHttpOptions,
): Hono {
  const router = new Hono();
  const readSession = options.readAdministrativeSession;
  const contextService = options.receivingNominationContext;
  const readContext =
    typeof contextService?.readContext === "function"
      ? contextService.readContext.bind(contextService)
      : undefined;
  let configuration:
    | ReturnType<typeof readReceivingNominationConfiguration>
    | undefined;
  try {
    if (
      contextService &&
      readContext &&
      typeof readSession === "function" &&
      typeof options.receivingNomination?.nominate === "function" &&
      typeof options.financialReauthentication?.readProof === "function" &&
      typeof options.financialReauthentication?.authenticate === "function"
    ) {
      const configured = readReceivingNominationConfiguration(
        contextService.configuration,
      );
      const action = readReceivingNominationConfiguration(
        options.receivingNomination.configuration,
      );
      if (
        Object.keys(configured).every(
          (key) =>
            configured[key as keyof typeof configured] ===
            action[key as keyof typeof action],
        )
      )
        configuration = configured;
    }
  } catch {
    /* An incompatible or incomplete GET stays unavailable. */
  }
  router.onError((error) => {
    if (error instanceof AdminSessionRequiredError)
      return problem(401, "UNAUTHORIZED");
    if (
      error instanceof FinancialReauthenticationError ||
      error instanceof ReceivingNominationServiceError
    )
      return problem(error.status, error.code);
    return problem(503, "RECEIVING_NOMINATION_UNAVAILABLE");
  });
  router.get(
    "/v1/sites/:siteId/receiving/nomination-context",
    async (context) => {
      if (context.req.header("origin") !== options.adminOrigin)
        return problem(403, "FORBIDDEN");
      const site = siteIdSchema.safeParse(context.req.param("siteId"));
      const request = context.req.raw;
      const length = request.headers.get("content-length");
      if (
        !site.success ||
        new URL(request.url).search ||
        request.body ||
        (length !== null && length !== "0") ||
        request.headers.has("transfer-encoding")
      )
        return problem(400, "VALIDATION_ERROR");
      if (!configuration || !readSession || !readContext)
        return problem(503, "RECEIVING_NOMINATION_UNAVAILABLE");
      const current = await readSession(request, options);
      if (
        !current ||
        !receivingNominationInputSchema.shape.requestId.safeParse(
          current.user?.id,
        ).success ||
        !receivingNominationInputSchema.shape.requestId.safeParse(
          current.session?.id,
        ).success
      )
        return problem(401, "UNAUTHORIZED");
      if (!["SITE_ADMIN", "SITE_ASSISTANT"].includes(current.user.role))
        return problem(403, "MEMBERSHIP_DENIED");
      const access = siteAccessSchema.safeParse(
        await resolveSiteAccess(options.db, {
          userId: current.user.id,
          platformRole: current.user.role,
          siteId: site.data,
        }),
      );
      if (
        !access.success ||
        access.data.siteId !== site.data ||
        access.data.userId !== current.user.id ||
        access.data.membershipRole !== "SITE_ADMIN" ||
        access.data.membershipId === null ||
        !access.data.capabilities.configureReceiving
      )
        return problem(403, "MEMBERSHIP_DENIED");
      const actor = {
        userId: current.user.id,
        siteId: site.data,
        sessionId: current.session.id,
      };
      const response = receivingNominationContextResponseSchema.safeParse({
        context: await readContext({ actor, access: access.data }),
      });
      if (
        !response.success ||
        response.data.context.siteId !== site.data ||
        response.data.context.mode !== configuration.mode
      )
        return problem(503, "RECEIVING_NOMINATION_UNAVAILABLE");
      const value = response.data.context;
      if (
        value.state === "AVAILABLE"
          ? value.policyVersion !== configuration.policyVersion ||
            value.requestId !==
              deriveReceivingNominationRequestId({
                siteId: site.data,
                operatorUserId: actor.userId,
                environment: configuration.mode,
              })
          : value.currentPolicyVersion !== configuration.policyVersion
      )
        return problem(503, "RECEIVING_NOMINATION_UNAVAILABLE");
      return context.json(response.data, 200, { "Cache-Control": "no-store" });
    },
  );
  router.post("/v1/sites/:siteId/receiving/nomination", async (context) => {
    if (context.req.header("origin") !== options.adminOrigin)
      return problem(403, "FORBIDDEN");
    const current = await requireAdminSession(context.req.raw, options);
    const siteId = siteIdSchema.safeParse(context.req.param("siteId"));
    if (!siteId.success || new URL(context.req.url).search)
      return problem(400, "VALIDATION_ERROR");
    const access = siteAccessSchema.safeParse(
      await resolveSiteAccess(options.db, {
        userId: current.user.id,
        platformRole: current.user.role,
        siteId: siteId.data,
      }),
    );
    if (
      !access.success ||
      access.data.siteId !== siteId.data ||
      access.data.userId !== current.user.id ||
      access.data.membershipRole !== "SITE_ADMIN" ||
      access.data.membershipId === null ||
      !access.data.capabilities.configureReceiving
    )
      return problem(403, "MEMBERSHIP_DENIED");
    const body = receivingNominationInputSchema.safeParse(
      await readBody(context.req.raw),
    );
    if (!body.success) return problem(400, "VALIDATION_ERROR");
    if (!options.financialReauthentication || !options.receivingNomination)
      return problem(409, "PROVIDER_MODE_UNAVAILABLE");
    const actor = {
      userId: current.user.id,
      siteId: siteId.data,
      sessionId: current.session.id,
    };
    const recentAuth = options.financialReauthentication.readProof(
      actor,
      "CONFIGURE_RECEIVING",
      body.data.reauthenticationToken,
    );
    const input = {
      requestId: body.data.requestId,
      confirmSelfAsRecipient: body.data.confirmSelfAsRecipient,
      policyVersion: body.data.policyVersion,
    };
    const snapshot = readReceivingNominationSnapshot(
      await options.receivingNomination.nominate({
        actor,
        access: access.data,
        recentAuth,
        input,
      }),
    );
    if (
      snapshot.siteId !== siteId.data ||
      snapshot.operatorUserId !== actor.userId ||
      snapshot.requestId !== input.requestId ||
      snapshot.policyVersion !== input.policyVersion
    )
      return problem(503, "RECEIVING_NOMINATION_UNAVAILABLE");
    const response = receivingNominationResponseSchema.safeParse({
      nomination: {
        siteId: snapshot.siteId,
        requestId: snapshot.requestId,
        state: snapshot.state,
        createdAt: snapshot.createdAt,
        mode: snapshot.environment,
      },
    });
    if (!response.success)
      return problem(503, "RECEIVING_NOMINATION_UNAVAILABLE");
    return context.json(response.data, 200, { "Cache-Control": "no-store" });
  });
  return router;
}
