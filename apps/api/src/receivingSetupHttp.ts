import {
  type ReceivingReadiness,
  receivingIncomingVerificationInputSchema,
  receivingPixDestinationConfirmationInputSchema,
  receivingPixDestinationInputSchema,
  receivingPixDestinationReviewSchema,
  receivingPixDestinationSavedResponseSchema,
  receivingPixDestinationSavedSchema,
  receivingReadinessSchema,
  receivingSetupHolderInputSchema,
  receivingSetupInputSchema,
  receivingSetupResponseSchema,
  receivingSetupResultSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import { Hono } from "hono";
import { trustedAdminOrigin } from "./adminOrigin";
import {
  AdminSessionRequiredError,
  type AuthHttpOptions,
  requireAdminSession,
} from "./authHttp";
import {
  type FinancialReauthentication,
  FinancialReauthenticationError,
} from "./financialReauthentication";
import { ReceivingNominationServiceError } from "./receivingNomination";
import { ReceivingPixDestinationError } from "./receivingPixDestination";
import { ReceivingPixDestinationSetupError } from "./receivingPixDestinationSetup";
import type { ReceivingSetupService } from "./receivingSetup";
import { ReceivingSetupError } from "./receivingSetupRepository";
import { resolveSiteAccess } from "./siteAccess";

export type ReceivingSetupHttpOptions = AuthHttpOptions & {
  receivingSetup?: ReceivingSetupService;
  financialReauthentication?: FinancialReauthentication;
  receivingVerification?: {
    verify(
      actor: import("./financialAuthorization").FinancialActor,
    ): Promise<ReceivingReadiness>;
  };
};
function problem(status: number, code: string) {
  return new Response(
    JSON.stringify({
      type: "about:blank",
      title: "Receiving setup unavailable",
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
async function body(request: Request): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(
      request.headers.get("content-type") ?? "",
    )
  )
    return undefined;
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  try {
    const buffer = new Uint8Array(16384);
    let length = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (length + chunk.value.byteLength > buffer.byteLength) {
        void reader.cancel().catch(() => {});
        return undefined;
      }
      buffer.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, length),
      ),
    );
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
}
export function createReceivingSetupHttpRouter(
  options: ReceivingSetupHttpOptions,
): Hono {
  const router = new Hono();
  router.onError((error) => {
    if (error instanceof AdminSessionRequiredError)
      return problem(401, "UNAUTHORIZED");
    if (
      error instanceof ReceivingSetupError ||
      error instanceof ReceivingPixDestinationSetupError ||
      error instanceof FinancialReauthenticationError ||
      error instanceof ReceivingPixDestinationError ||
      error instanceof ReceivingNominationServiceError
    )
      return problem(error.status, error.code);
    return problem(503, "RECEIVING_SETUP_UNAVAILABLE");
  });
  router.use("/v1/sites/:siteId/receiving/*", async (context, next) => {
    if (!trustedAdminOrigin(context.req.header("origin"), options.adminOrigin))
      return problem(403, "FORBIDDEN");
    if (
      !siteIdSchema.safeParse(context.req.param("siteId")).success ||
      new URL(context.req.url).search
    )
      return problem(400, "VALIDATION_ERROR");
    await next();
  });
  router.post("/v1/sites/:siteId/receiving/holder", async (context) => {
    const current = await requireAdminSession(context.req.raw, options);
    if (current.user.role !== "OWNER") return problem(403, "MEMBERSHIP_DENIED");
    const input = receivingSetupHolderInputSchema.safeParse(
      await body(context.req.raw),
    );
    if (!input.success) return problem(400, "VALIDATION_ERROR");
    if (!options.receivingSetup)
      return problem(503, "RECEIVING_SETUP_UNAVAILABLE");
    await options.receivingSetup.designate(
      {
        userId: current.user.id,
        sessionId: current.session.id,
        siteId: context.req.param("siteId"),
      },
      input.data.holderUserId,
    );
    return context.body(null, 204, { "Cache-Control": "no-store" });
  });
  router.get("/v1/sites/:siteId/receiving/setup", async (context) => {
    const current = await requireAdminSession(context.req.raw, options);
    const siteId = context.req.param("siteId");
    const access = await resolveSiteAccess(options.db, {
      userId: current.user.id,
      platformRole: current.user.role,
      siteId,
    });
    if (
      !access ||
      (current.user.role !== "OWNER" &&
        (access.membershipRole !== "SITE_ADMIN" ||
          !access.capabilities.configureReceiving))
    )
      return problem(403, "MEMBERSHIP_DENIED");
    if (!options.receivingSetup)
      return problem(503, "RECEIVING_SETUP_UNAVAILABLE");
    const output = receivingSetupResponseSchema.safeParse({
      setup: await options.receivingSetup.read(
        {
          userId: current.user.id,
          sessionId: current.session.id,
          siteId,
        },
        current.user.role,
      ),
    });
    if (!output.success || output.data.setup.siteId !== siteId)
      return problem(503, "RECEIVING_SETUP_UNAVAILABLE");
    return context.json(output.data, 200, { "Cache-Control": "no-store" });
  });
  router.post(
    "/v1/sites/:siteId/receiving/pix-destination/preview",
    async (context) => {
      const current = await requireAdminSession(context.req.raw, options);
      const siteId = context.req.param("siteId");
      const access = await resolveSiteAccess(options.db, {
        userId: current.user.id,
        platformRole: current.user.role,
        siteId,
      });
      if (
        current.user.role !== "SITE_ADMIN" ||
        !access ||
        access.membershipRole !== "SITE_ADMIN" ||
        !access.capabilities.configureReceiving
      )
        return problem(403, "MEMBERSHIP_DENIED");
      const input = receivingPixDestinationInputSchema.safeParse(
        await body(context.req.raw),
      );
      if (!input.success) return problem(400, "VALIDATION_ERROR");
      if (!options.receivingSetup)
        return problem(503, "PIX_DESTINATION_UNAVAILABLE");
      const result = receivingPixDestinationReviewSchema.parse(
        await options.receivingSetup.lookupPixDestination(
          { userId: current.user.id, sessionId: current.session.id, siteId },
          input.data,
        ),
      );
      if (result.siteId !== siteId)
        return problem(503, "PIX_DESTINATION_UNAVAILABLE");
      return context.json(result, 200, { "Cache-Control": "no-store" });
    },
  );
  router.get("/v1/sites/:siteId/receiving/pix-destination", async (context) => {
    const current = await requireAdminSession(context.req.raw, options);
    const siteId = context.req.param("siteId");
    const access = await resolveSiteAccess(options.db, {
      userId: current.user.id,
      platformRole: current.user.role,
      siteId,
    });
    if (
      !access ||
      access.siteId !== siteId ||
      access.userId !== current.user.id ||
      !access.capabilities.readFinance ||
      (current.user.role !== "OWNER" &&
        (current.user.role !== "SITE_ADMIN" ||
          access.membershipRole !== "SITE_ADMIN"))
    )
      return problem(403, "MEMBERSHIP_DENIED");
    if (!options.receivingSetup)
      return problem(503, "PIX_DESTINATION_UNAVAILABLE");
    const actor = {
      userId: current.user.id,
      siteId,
      sessionId: current.session.id,
    };
    const output = receivingPixDestinationSavedResponseSchema.parse(
      options.receivingSetup.readPixDestinationSnapshot
        ? await options.receivingSetup.readPixDestinationSnapshot(actor)
        : {
            destination: await options.receivingSetup.readPixDestination(actor),
          },
    );
    if (
      (output.destination && output.destination.siteId !== siteId) ||
      output.recentDestinations.some(
        (destination) => destination.siteId !== siteId,
      )
    )
      return problem(503, "PIX_DESTINATION_UNAVAILABLE");
    return context.json(output, 200, { "Cache-Control": "no-store" });
  });
  router.post(
    "/v1/sites/:siteId/receiving/pix-destination/confirm",
    async (context) => {
      const current = await requireAdminSession(context.req.raw, options);
      const siteId = context.req.param("siteId");
      const access = await resolveSiteAccess(options.db, {
        userId: current.user.id,
        platformRole: current.user.role,
        siteId,
      });
      if (
        current.user.role !== "SITE_ADMIN" ||
        !access ||
        access.membershipRole !== "SITE_ADMIN" ||
        !access.capabilities.configureReceiving
      )
        return problem(403, "MEMBERSHIP_DENIED");
      const parsed = receivingPixDestinationConfirmationInputSchema.safeParse(
        await body(context.req.raw),
      );
      if (!parsed.success) return problem(400, "VALIDATION_ERROR");
      if (!options.receivingSetup || !options.financialReauthentication)
        return problem(503, "PIX_DESTINATION_UNAVAILABLE");
      const actor = {
        userId: current.user.id,
        siteId,
        sessionId: current.session.id,
      };
      const { reauthenticationToken, ...input } = parsed.data;
      const proof = options.financialReauthentication.readProof(
        actor,
        "CONFIGURE_RECEIVING",
        reauthenticationToken,
      );
      const result = receivingPixDestinationSavedSchema.parse(
        await options.receivingSetup.confirmPixDestination(actor, input, proof),
      );
      if (result.siteId !== siteId)
        return problem(503, "PIX_DESTINATION_UNAVAILABLE");
      return context.json(result, 200, { "Cache-Control": "no-store" });
    },
  );
  router.post(
    "/v1/sites/:siteId/receiving/incoming-verification",
    async (context) => {
      const current = await requireAdminSession(context.req.raw, options);
      const siteId = context.req.param("siteId");
      const access = await resolveSiteAccess(options.db, {
        userId: current.user.id,
        platformRole: current.user.role,
        siteId,
      });
      if (
        current.user.role !== "SITE_ADMIN" ||
        !access ||
        access.membershipRole !== "SITE_ADMIN" ||
        !access.capabilities.configureReceiving
      )
        return problem(403, "MEMBERSHIP_DENIED");
      const input = receivingIncomingVerificationInputSchema.safeParse(
        await body(context.req.raw),
      );
      if (!input.success) return problem(400, "VALIDATION_ERROR");
      if (!options.receivingVerification)
        return problem(503, "RECEIVING_VERIFICATION_UNAVAILABLE");
      const actor = {
        userId: current.user.id,
        siteId,
        sessionId: current.session.id,
      };
      const readiness = receivingReadinessSchema.parse(
        await options.receivingVerification.verify(actor),
      );
      if (readiness.siteId !== siteId)
        return problem(503, "RECEIVING_VERIFICATION_UNAVAILABLE");
      return context.json({ readiness }, 200, { "Cache-Control": "no-store" });
    },
  );
  router.post("/v1/sites/:siteId/receiving/setup", async (context) => {
    const current = await requireAdminSession(context.req.raw, options);
    const siteId = context.req.param("siteId");
    const access = await resolveSiteAccess(options.db, {
      userId: current.user.id,
      platformRole: current.user.role,
      siteId,
    });
    if (
      current.user.role !== "SITE_ADMIN" ||
      !access ||
      access.membershipRole !== "SITE_ADMIN" ||
      !access.capabilities.configureReceiving
    )
      return problem(403, "MEMBERSHIP_DENIED");
    const input = receivingSetupInputSchema.safeParse(
      await body(context.req.raw),
    );
    if (!input.success) return problem(400, "VALIDATION_ERROR");
    if (!options.receivingSetup)
      return problem(503, "RECEIVING_SETUP_UNAVAILABLE");
    const actor = {
      userId: current.user.id,
      sessionId: current.session.id,
      siteId,
    };
    const result = receivingSetupResultSchema.parse(
      await options.receivingSetup.submit(input.data, {
        actor,
        access,
      }),
    );
    return context.json(result, result.state === "STORED" ? 200 : 202, {
      "Cache-Control": "no-store",
    });
  });
  return router;
}
