import {
  financialOverviewResponseSchema,
  type SiteAccess,
  siteIdSchema,
  withdrawalCreateInputSchema,
  withdrawalListResponseSchema,
  withdrawalPreviewInputSchema,
  withdrawalRequestContextResponseSchema,
  withdrawalRequestStatusResponseSchema,
  withdrawalResponseSchema,
  withdrawalSealInputSchema,
} from "@entrelacos/contracts";
import { Hono } from "hono";
import { trustedAdminOrigin } from "./adminOrigin";
import {
  type AdministrativeActor,
  AdminSessionRequiredError,
  type AuthHttpOptions,
  requireAdminSession,
} from "./authHttp";
import {
  assertFinancialReadAccess,
  type FinancialActor,
  FinancialAuthorizationError,
} from "./financialAuthorization";
import {
  type FinancialReauthentication,
  FinancialReauthenticationError,
} from "./financialReauthentication";
import { ReceivingReadinessServiceError } from "./receivingReadiness";
import { resolveSiteAccess } from "./siteAccess";
import {
  type WithdrawalReservationService,
  WithdrawalReservationServiceError,
} from "./withdrawalReservations";

const FINANCE_PATH = "/v1/sites/:siteId/finance";
const WITHDRAWALS_PATH = "/v1/sites/:siteId/withdrawals";

// Server-selected readers resolve stored account scope; browser claims cannot
// select a provider account, credential, balance source or recipient.
export interface FinanceHttpReadPorts {
  readOverview?(siteId: string): Promise<unknown>;
  listWithdrawals?(siteId: string): Promise<unknown>;
}
export type FinanceHttpOptions = AuthHttpOptions & {
  finance?: FinanceHttpReadPorts;
  financialReauthentication?: FinancialReauthentication;
  withdrawalReservation?: WithdrawalReservationService;
  readAdministrativeSession?: (
    request: Request,
    options: Pick<AuthHttpOptions, "auth" | "db" | "now">,
  ) => Promise<AdministrativeActor | null>;
};

function problem(status: number, code: string, title: string): Response {
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

function providerUnavailable(): Response {
  return problem(
    409,
    "PROVIDER_MODE_UNAVAILABLE",
    "Financial provider is unavailable",
  );
}

async function readWithdrawalBody(request: Request): Promise<unknown> {
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
      if (size > 8192) {
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

const actionFailureStatuses = {
  WITHDRAWAL_INVALID: 400,
  MEMBERSHIP_DENIED: 403,
  RECENT_AUTH_REQUIRED: 403,
  RECIPIENT_REQUIRED: 403,
  DESTINATION_UNVERIFIED: 409,
  REQUEST_CONFLICT: 409,
  PREVIEW_EXPIRED: 409,
  PROVIDER_MODE_UNAVAILABLE: 409,
  FEE_QUOTE_UNAVAILABLE: 409,
  PROVIDER_BALANCE_UNAVAILABLE: 409,
  FINANCIAL_EVENTS_UNRESOLVED: 409,
  INSUFFICIENT_FUNDS: 409,
  WITHDRAWAL_UNAVAILABLE: 503,
  REAUTHENTICATION_RATE_LIMITED: 429,
  REAUTHENTICATION_UNAVAILABLE: 503,
  RECEIVING_NOT_READY: 409,
} as const;

export function createFinanceHttpRouter(options: FinanceHttpOptions) {
  const router = new Hono<{
    Variables: { financialActor: FinancialActor; financialAccess: SiteAccess };
  }>();
  const service = options.withdrawalReservation;
  const confirmNew =
    typeof service?.confirmNew === "function"
      ? service.confirmNew.bind(service)
      : undefined;
  const recoverExisting =
    typeof service?.recoverExisting === "function"
      ? service.recoverExisting.bind(service)
      : undefined;
  const createPreview =
    typeof service?.createPreview === "function"
      ? service.createPreview.bind(service)
      : undefined;
  const readContext =
    typeof service?.readContext === "function"
      ? service.readContext.bind(service)
      : undefined;
  const readRequest =
    typeof service?.readRequest === "function"
      ? service.readRequest.bind(service)
      : undefined;
  const seal =
    typeof service?.sealUncreatedRequest === "function"
      ? service.sealUncreatedRequest.bind(service)
      : undefined;
  const readSession =
    typeof options.readAdministrativeSession === "function"
      ? options.readAdministrativeSession.bind(options)
      : undefined;
  const proof = options.financialReauthentication;
  const readProof =
    typeof proof?.readProof === "function"
      ? proof.readProof.bind(proof)
      : undefined;
  router.onError((error, context) => {
    if (error instanceof AdminSessionRequiredError) {
      return problem(401, "UNAUTHORIZED", "Authentication required");
    }
    if (
      error instanceof FinancialAuthorizationError &&
      context.req.method !== "POST"
    )
      return problem(403, "MEMBERSHIP_DENIED", "Financial access denied");
    if (
      context.req.method === "POST" &&
      (error instanceof FinancialAuthorizationError ||
        error instanceof FinancialReauthenticationError ||
        error instanceof ReceivingReadinessServiceError ||
        error instanceof WithdrawalReservationServiceError)
    ) {
      if (Object.hasOwn(actionFailureStatuses, error.code)) {
        const status =
          actionFailureStatuses[
            error.code as keyof typeof actionFailureStatuses
          ];
        if (status === error.status)
          return problem(status, error.code, "Financial action unavailable");
      }
    }
    return problem(503, "SERVICE_UNAVAILABLE", "Financial service unavailable");
  });

  for (const path of [
    FINANCE_PATH,
    WITHDRAWALS_PATH,
    `${WITHDRAWALS_PATH}/*`,
  ]) {
    router.use(path, async (context, next) => {
      context.header("Cache-Control", "no-store");
      if (
        path === `${WITHDRAWALS_PATH}/*` &&
        /^\/v1\/sites\/[^/]+\/withdrawals$/.test(
          new URL(context.req.url).pathname,
        )
      ) {
        await next();
        return;
      }
      if (
        !trustedAdminOrigin(context.req.header("origin"), options.adminOrigin)
      ) {
        return problem(403, "FORBIDDEN", "Forbidden");
      }
      const requestRead =
        ["GET", "HEAD"].includes(context.req.method) &&
        path === `${WITHDRAWALS_PATH}/*`;
      if (requestRead && !readSession) return providerUnavailable();
      const actor = requestRead
        ? await readSession?.(context.req.raw, options)
        : await requireAdminSession(context.req.raw, options);
      if (!actor)
        return problem(401, "UNAUTHORIZED", "Authentication required");
      const parsedSiteId = siteIdSchema.safeParse(context.req.param("siteId"));
      if (!parsedSiteId.success) {
        return problem(400, "VALIDATION_ERROR", "Invalid site identifier");
      }
      const siteId = parsedSiteId.data;
      const access = await resolveSiteAccess(options.db, {
        userId: actor.user.id,
        platformRole: actor.user.role,
        siteId,
      });
      assertFinancialReadAccess(access, siteId);
      if (
        access.membershipRole === "OWNER" &&
        (context.req.method === "POST" || requestRead)
      ) {
        return problem(
          403,
          "MEMBERSHIP_DENIED",
          "Financial action access denied",
        );
      }
      if (access.userId !== actor.user.id) {
        return problem(403, "MEMBERSHIP_DENIED", "Financial access denied");
      }
      if (requestRead && !readContext && !readRequest)
        return providerUnavailable();
      const url = new URL(context.req.url);
      const contextRead =
        requestRead &&
        /^\/v1\/sites\/[^/]+\/withdrawals\/context$/.test(url.pathname);
      const cursor = url.searchParams.get("cursor");
      if (
        (contextRead &&
          ([...url.searchParams.keys()].some((key) => key !== "cursor") ||
            url.searchParams.getAll("cursor").length > 1 ||
            (cursor !== null &&
              (cursor.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(cursor))))) ||
        (!contextRead && url.search)
      ) {
        return problem(400, "VALIDATION_ERROR", "Invalid financial query");
      }
      if (context.req.method === "POST" || requestRead) {
        context.set(
          "financialActor",
          Object.freeze({
            userId: actor.user.id,
            siteId,
            sessionId: actor.session.id,
          }),
        );
        context.set(
          "financialAccess",
          Object.freeze({
            ...access,
            capabilities: Object.freeze({ ...access.capabilities }),
          }),
        );
      }
      await next();
    });
  }

  router.get(FINANCE_PATH, async (context) => {
    if (!options.finance?.readOverview) return providerUnavailable();
    const siteId = context.req.param("siteId");
    const result = financialOverviewResponseSchema.safeParse({
      overview: await options.finance.readOverview(siteId),
    });
    if (!result.success || result.data.overview.siteId !== siteId) {
      return problem(
        503,
        "SERVICE_UNAVAILABLE",
        "Financial service unavailable",
      );
    }
    context.header("Cache-Control", "no-store");
    return context.json(result.data);
  });
  router.get(WITHDRAWALS_PATH, async (context) => {
    if (!options.finance?.listWithdrawals) return providerUnavailable();
    const siteId = context.req.param("siteId");
    const result = withdrawalListResponseSchema.safeParse({
      withdrawals: await options.finance.listWithdrawals(siteId),
    });
    if (
      !result.success ||
      result.data.withdrawals.some((value) => value.siteId !== siteId)
    ) {
      return problem(
        503,
        "SERVICE_UNAVAILABLE",
        "Financial service unavailable",
      );
    }
    context.header("Cache-Control", "no-store");
    return context.json(result.data);
  });
  router.post(WITHDRAWALS_PATH, async (context) => {
    const body = withdrawalCreateInputSchema.safeParse(
      await readWithdrawalBody(context.req.raw),
    );
    if (!body.success) {
      return problem(400, "VALIDATION_ERROR", "Invalid withdrawal payload");
    }
    const action =
      body.data.action === "CONFIRM_NEW" ? confirmNew : recoverExisting;
    if (!action || !readProof) return providerUnavailable();
    const actor = context.get("financialActor");
    const access = context.get("financialAccess");
    const { reauthenticationToken, requestId } = body.data;
    const recentAuth = readProof(
      actor,
      "REQUEST_WITHDRAWAL",
      reauthenticationToken,
    );
    // The real service distinguishes a new action from historical exact replay.
    // HTTP must not replace original commitments with current destination gates.
    const result = withdrawalResponseSchema.safeParse({
      requestId,
      withdrawal: await action({ actor, access, recentAuth, requestId }),
    });
    if (
      !result.success ||
      result.data.withdrawal.siteId !== actor.siteId ||
      (result.data.withdrawal.mode !== "sandbox" &&
        result.data.withdrawal.mode !== "live")
    )
      return problem(
        503,
        "SERVICE_UNAVAILABLE",
        "Financial service unavailable",
      );
    return context.json(result.data, 200, { "Cache-Control": "no-store" });
  });
  router.get(`${WITHDRAWALS_PATH}/context`, async (context) => {
    if (!readContext || !readSession) return providerUnavailable();
    const actor = context.get("financialActor"),
      access = context.get("financialAccess");
    const cursor = new URL(context.req.url).searchParams.get("cursor");
    const result = withdrawalRequestContextResponseSchema.safeParse({
      context: await readContext({
        actor,
        access,
        ...(cursor === null ? {} : { cursor }),
      }),
    });
    if (!result.success || result.data.context.siteId !== actor.siteId)
      return problem(
        503,
        "SERVICE_UNAVAILABLE",
        "Financial service unavailable",
      );
    return context.json(result.data, 200, { "Cache-Control": "no-store" });
  });
  router.post(`${WITHDRAWALS_PATH}/preview`, async (context) => {
    const input = withdrawalPreviewInputSchema.safeParse(
      await readWithdrawalBody(context.req.raw),
    );
    if (!input.success)
      return problem(400, "VALIDATION_ERROR", "Invalid withdrawal payload");
    if (!createPreview) return providerUnavailable();
    const actor = context.get("financialActor"),
      access = context.get("financialAccess");
    const result = withdrawalRequestStatusResponseSchema.safeParse({
      request: await createPreview({ actor, access, input: input.data }),
    });
    if (
      !result.success ||
      result.data.request.siteId !== actor.siteId ||
      result.data.request.requestId !== input.data.requestId ||
      (result.data.request.state === "OPEN" &&
        result.data.request.preview.amountCents !== input.data.amountCents) ||
      (result.data.request.state !== "OPEN" &&
        result.data.request.command !== null &&
        result.data.request.command.amountCents !== input.data.amountCents)
    )
      return problem(
        503,
        "SERVICE_UNAVAILABLE",
        "Financial service unavailable",
      );
    return context.json(result.data, 200, { "Cache-Control": "no-store" });
  });
  router.get(`${WITHDRAWALS_PATH}/requests/:requestId`, async (context) => {
    const requestId = withdrawalPreviewInputSchema.shape.requestId.safeParse(
      context.req.param("requestId"),
    );
    if (!requestId.success)
      return problem(400, "VALIDATION_ERROR", "Invalid withdrawal identifier");
    if (!readRequest || !readSession) return providerUnavailable();
    const actor = context.get("financialActor"),
      access = context.get("financialAccess");
    const result = withdrawalRequestStatusResponseSchema.safeParse({
      request: await readRequest({ actor, access, requestId: requestId.data }),
    });
    if (
      !result.success ||
      result.data.request.siteId !== actor.siteId ||
      result.data.request.requestId !== requestId.data
    )
      return problem(
        503,
        "SERVICE_UNAVAILABLE",
        "Financial service unavailable",
      );
    return context.json(result.data, 200, { "Cache-Control": "no-store" });
  });
  router.post(`${WITHDRAWALS_PATH}/:requestId/seal`, async (context) => {
    const requestId = withdrawalPreviewInputSchema.shape.requestId.safeParse(
      context.req.param("requestId"),
    );
    const input = withdrawalSealInputSchema.safeParse(
      await readWithdrawalBody(context.req.raw),
    );
    if (!requestId.success || !input.success)
      return problem(400, "VALIDATION_ERROR", "Invalid withdrawal payload");
    if (!seal) return providerUnavailable();
    const actor = context.get("financialActor"),
      access = context.get("financialAccess");
    const result = withdrawalRequestStatusResponseSchema.safeParse({
      request: await seal({
        actor,
        access,
        requestId: requestId.data,
      }),
    });
    if (
      !result.success ||
      result.data.request.siteId !== actor.siteId ||
      result.data.request.requestId !== requestId.data ||
      result.data.request.state === "OPEN"
    )
      return problem(
        503,
        "SERVICE_UNAVAILABLE",
        "Financial service unavailable",
      );
    return context.json(result.data, 200, { "Cache-Control": "no-store" });
  });
  return router;
}
