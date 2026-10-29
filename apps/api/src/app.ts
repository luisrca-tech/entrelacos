import {
  type ApiProblem,
  type HealthResponse,
  internalGiftsEndpointPaths,
} from "@entrelacos/contracts";
import { Hono } from "hono";
import { createAdminAccessHttpRouter } from "./adminAccessHttp";
import {
  type AsaasWebhookHttpReceiver,
  createAsaasWebhookHttpRouter,
} from "./asaasWebhookHttp";
import {
  type AsaasWithdrawalAuthorizationHttpReceiver,
  createAsaasWithdrawalAuthorizationHttpRouter,
} from "./asaasWithdrawalAuthorizationHttp";
import { createAuthHttpRouter } from "./authHttp";
import { createDemoResetHttpRouter } from "./demoResetHttp";
import {
  createFinanceHttpRouter,
  type FinanceHttpOptions,
} from "./financeHttp";
import type { FinancialReauthentication } from "./financialReauthentication";
import { createFinancialReauthenticationHttpRouter } from "./financialReauthenticationHttp";
import {
  createGiftMediaHttpRouter,
  type GiftMediaHttpOptions,
} from "./giftMediaHttp";
import {
  createGiftPaymentHistoryHttpRouter,
  type GiftPaymentHistoryHttpOptions,
  giftPaymentHistoryHttpPaths,
} from "./giftPaymentHistoryHttp";
import {
  createGiftPaymentsHttpRouter,
  type GiftPaymentsHttpOptions,
} from "./giftPaymentsHttp";
import { readGiftPricingSettings } from "./giftPricingSettings";
import { createGiftsHttpRouter } from "./giftsHttp";
import { createGuestVerificationHttpRouter } from "./guestVerificationHttp";
import { createHandoffHttpRouter } from "./handoffHttp";
import { createInvitationsHttpRouter } from "./invitationsHttp";
import { createMessagesHttpRouter } from "./messagesHttp";
import {
  createObservabilityMiddleware,
  type ObservabilityOptions,
  type ObservabilityVariables,
} from "./observability";
import { createReceivingHttpRouter } from "./receivingHttp";
import type { ReceivingNominationService } from "./receivingNomination";
import {
  createReceivingNominationHttpRouter,
  type ReceivingNominationHttpOptions,
} from "./receivingNominationHttp";
import {
  type ReceivingRepositoryOptions,
  type ReceivingTransaction,
  readReceivingReadiness,
} from "./receivingRepository";
import type { ReceivingSetupService } from "./receivingSetup";
import {
  createReceivingSetupHttpRouter,
  type ReceivingSetupHttpOptions,
} from "./receivingSetupHttp";
import { createReportsHttpRouter } from "./reportsHttp";
import { createRsvpHttpRouter } from "./rsvpHttp";
import { createSitesHttpRouter } from "./sitesHttp";
import { createSiteTeamHttpRouter } from "./siteTeamHttp";

export type ApiOptions = GiftPaymentsHttpOptions &
  Pick<
    GiftMediaHttpOptions,
    "storage" | "storageNamespace" | "processing" | "decode"
  > &
  Pick<FinanceHttpOptions, "finance" | "withdrawalReservation"> &
  Pick<
    ReceivingNominationHttpOptions,
    "receivingNominationContext" | "readAdministrativeSession"
  > & {
    receiving?: ReceivingRepositoryOptions;
    asaasWebhook?: AsaasWebhookHttpReceiver;
    asaasWithdrawalAuthorization?: AsaasWithdrawalAuthorizationHttpReceiver;
    financialReauthentication?: FinancialReauthentication;
    receivingNomination?: ReceivingNominationService;
    receivingSetup?: ReceivingSetupService;
    receivingVerification?: ReceivingSetupHttpOptions["receivingVerification"];
    giftMediaAuth?: GiftMediaHttpOptions["auth"];
    giftPaymentHistory?: GiftPaymentHistoryHttpOptions["giftPaymentHistory"];
    previewPricing?: (siteId: string, input: unknown) => Promise<unknown>;
  };

export function createApp(
  options?: ApiOptions,
  observability?: ObservabilityOptions,
) {
  const app = new Hono<{ Variables: ObservabilityVariables }>();
  app.use("*", createObservabilityMiddleware(observability));

  app.get("/v1/health", (context) => {
    return context.json({
      status: "ok",
      service: "entrelacos-api",
    } satisfies HealthResponse);
  });

  const historyRouter = createGiftPaymentHistoryHttpRouter({
    adminOrigin: options?.adminOrigin,
    giftPaymentHistory: options?.giftPaymentHistory,
  });
  // Exact history dispatch keeps other routers' activity middleware outside this read.
  for (const path of giftPaymentHistoryHttpPaths) {
    app.all(path, (context) => historyRouter.fetch(context.req.raw));
  }

  if (options) {
    app.route(
      "/",
      createAsaasWithdrawalAuthorizationHttpRouter(
        options.asaasWithdrawalAuthorization,
      ),
    );
    app.route("/", createAsaasWebhookHttpRouter(options.asaasWebhook));
    const liveSitePolicy = {
      applicationEnvironment: options.receiving?.applicationEnvironment,
      liveDemoSiteId: options.receiving?.liveDemoSiteId,
    };
    const readReadiness = (
      siteId: string,
      transaction?: ReceivingTransaction,
    ) =>
      transaction
        ? readReceivingReadiness(
            options.db,
            siteId,
            options.receiving,
            transaction,
          )
        : readReceivingReadiness(options.db, siteId, options.receiving);
    app.route("/", createAuthHttpRouter(options));
    app.route("/", createAdminAccessHttpRouter(options));
    app.route("/", createSitesHttpRouter(options));
    const teamRouter = createSiteTeamHttpRouter(options);
    // Dispatch only team contracts so its private middleware cannot guard guest routes.
    for (const endpoint of [
      internalGiftsEndpointPaths.access,
      internalGiftsEndpointPaths.teamRead,
      internalGiftsEndpointPaths.teamInvite,
      internalGiftsEndpointPaths.teamInvitationRevoke,
      internalGiftsEndpointPaths.teamMemberRevoke,
      internalGiftsEndpointPaths.teamAccept,
    ]) {
      const [method, path] = endpoint.split(" ");
      app.on(method, path, (context) => teamRouter.fetch(context.req.raw));
    }
    app.route("/", createReceivingHttpRouter({ ...options, readReadiness }));
    const receivingSetupRouter = createReceivingSetupHttpRouter(options);
    for (const [method, path] of [
      ["GET", "/v1/sites/:siteId/receiving/setup"],
      ["POST", "/v1/sites/:siteId/receiving/setup"],
      ["POST", "/v1/sites/:siteId/receiving/holder"],
      ["POST", "/v1/sites/:siteId/receiving/incoming-verification"],
      ["POST", "/v1/sites/:siteId/receiving/pix-destination/preview"],
      ["POST", "/v1/sites/:siteId/receiving/pix-destination/confirm"],
      ["GET", "/v1/sites/:siteId/receiving/pix-destination"],
    ]) {
      app.on(method, path, (context) =>
        receivingSetupRouter.fetch(context.req.raw),
      );
    }
    app.route("/", createFinanceHttpRouter(options));
    app.route("/", createFinancialReauthenticationHttpRouter(options));
    app.route("/", createReceivingNominationHttpRouter(options));
    const mediaRouter = createGiftMediaHttpRouter({
      ...options,
      auth: options.giftMediaAuth ?? options.auth,
      ...liveSitePolicy,
      readReadiness,
    });
    app.all("/gifts/*", (context) => mediaRouter.fetch(context.req.raw));
    for (const endpoint of [
      internalGiftsEndpointPaths.mediaUpload,
      internalGiftsEndpointPaths.mediaFinalize,
    ]) {
      const [method, path] = endpoint.split(" ");
      app.on(method, path, (context) => mediaRouter.fetch(context.req.raw));
    }
    const giftsRouter = createGiftsHttpRouter({
      ...options,
      ...liveSitePolicy,
      readReadiness,
      readPricingSettings: (siteId) =>
        readGiftPricingSettings(options.db, siteId),
      previewPricing: options.previewPricing,
    });
    for (const endpoint of [
      internalGiftsEndpointPaths.giftsRead,
      internalGiftsEndpointPaths.giftsCreate,
      internalGiftsEndpointPaths.giftUpdate,
      internalGiftsEndpointPaths.giftPublication,
      internalGiftsEndpointPaths.giftsReorder,
      internalGiftsEndpointPaths.publicGifts,
      "GET /v1/sites/:siteId/gift-pricing-settings",
      "PATCH /v1/sites/:siteId/gift-pricing-settings",
      "POST /v1/sites/:siteId/gift-pricing-preview",
      "OPTIONS /v1/public/sites/:siteId/gifts",
    ]) {
      const [method, path] = endpoint.split(" ");
      app.on(method, path, (context) => giftsRouter.fetch(context.req.raw));
    }
    const paymentsRouter = createGiftPaymentsHttpRouter(options);
    for (const endpoint of [
      internalGiftsEndpointPaths.quote,
      internalGiftsEndpointPaths.checkout,
      internalGiftsEndpointPaths.checkoutStatus,
    ]) {
      const [method, path] = endpoint.split(" ");
      app.on([method, "OPTIONS"], path, (context) =>
        paymentsRouter.fetch(context.req.raw),
      );
    }
    app.route("/", createInvitationsHttpRouter(options));
    app.route(
      "/",
      createDemoResetHttpRouter({ ...options, ...liveSitePolicy }),
    );
    app.route("/", createGuestVerificationHttpRouter(options));
    app.route("/", createRsvpHttpRouter(options));
    app.route("/", createReportsHttpRouter(options));
    app.route("/", createMessagesHttpRouter(options));
    app.route("/", createHandoffHttpRouter(options));
  }

  app.notFound((context) => {
    context.header("Content-Type", "application/problem+json");
    return context.body(
      JSON.stringify({
        type: "about:blank",
        title: "Not Found",
        status: 404,
        code: "NOT_FOUND",
      } satisfies ApiProblem),
      404,
    );
  });

  return Object.assign(app, { close: historyRouter.close });
}

export const app = createApp();
