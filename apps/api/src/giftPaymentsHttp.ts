import {
  type CheckoutResult,
  type CheckoutStatus,
  checkoutCreateInputSchema,
  checkoutResponseSchema,
  checkoutStatusInputSchema,
  checkoutStatusResponseSchema,
  type GiftQuote,
  giftQuoteInputSchema,
  giftQuoteResponseSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import { siteOrigin } from "@entrelacos/database/schema";
import { and, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AuthHttpOptions } from "./authHttp";
import {
  GiftCheckoutServiceError,
  isSafeCheckoutContinuation,
} from "./giftCheckouts";
import { GiftQuoteServiceError } from "./giftQuotes";
import { allowsLocalPublicOrigin } from "./localPublicOrigin";
import { ReceivingReadinessServiceError } from "./receivingReadiness";

export interface PublicGiftPaymentsServices {
  createQuote(siteId: unknown, input: unknown): Promise<GiftQuote>;
  createCheckout(siteId: unknown, input: unknown): Promise<CheckoutResult>;
  getStatus(siteId: unknown, input: unknown): Promise<CheckoutStatus>;
}
export type GiftPaymentsHttpOptions = AuthHttpOptions & {
  giftPayments?: PublicGiftPaymentsServices;
};

function problem(
  context: Context,
  status: 400 | 403 | 409 | 503,
  code: string,
): Response {
  return context.newResponse(
    JSON.stringify({
      type: "about:blank",
      status,
      code,
      title:
        status === 503
          ? "Gift payment service unavailable"
          : "Gift payment request rejected",
    }),
    status as ContentfulStatusCode,
    { "Content-Type": "application/problem+json", "Cache-Control": "no-store" },
  );
}

async function readBody(request: Request): Promise<unknown> {
  const mediaType = request.headers
    .get("Content-Type")
    ?.split(";")[0]
    .trim()
    .toLowerCase();
  if (mediaType !== "application/json") return undefined;
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16_384) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
}

function validOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.origin === value &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function createGiftPaymentsHttpRouter(
  options: GiftPaymentsHttpOptions,
): Hono {
  const router = new Hono();
  router.onError((error, context) => {
    if (
      error instanceof GiftCheckoutServiceError ||
      error instanceof GiftQuoteServiceError ||
      error instanceof ReceivingReadinessServiceError
    )
      return problem(context, error.status, error.code);
    return problem(context, 503, "SERVICE_UNAVAILABLE");
  });
  router.use("/v1/public/sites/:siteId/*", async (context, next) => {
    const siteId = siteIdSchema.safeParse(context.req.param("siteId"));
    if (!siteId.success || new URL(context.req.url).search)
      return problem(context, 400, "VALIDATION_ERROR");
    const origin = context.req.header("Origin");
    if (!origin || !validOrigin(origin))
      return problem(context, 403, "FORBIDDEN");
    if (!allowsLocalPublicOrigin(context.req.url, origin)) {
      const rows = await options.db
        .select({ id: siteOrigin.id })
        .from(siteOrigin)
        .where(
          and(
            eq(siteOrigin.siteId, siteId.data),
            eq(siteOrigin.origin, origin),
          ),
        )
        .limit(1);
      if (rows.length !== 1) return problem(context, 403, "FORBIDDEN");
    }
    context.header("Access-Control-Allow-Origin", origin);
    context.header("Vary", "Origin");
    context.header("Cache-Control", "no-store");
    await next();
  });
  for (const path of [
    "gift-quotes",
    "gift-checkouts",
    "gift-checkouts/status",
  ]) {
    router.options(`/v1/public/sites/:siteId/${path}`, (context) => {
      context.header("Access-Control-Allow-Methods", "POST");
      context.header("Access-Control-Allow-Headers", "Content-Type");
      return context.newResponse(null, 204);
    });
  }
  router.post("/v1/public/sites/:siteId/gift-quotes", async (context) => {
    const input = giftQuoteInputSchema.safeParse(
      await readBody(context.req.raw),
    );
    if (!input.success) return problem(context, 400, "VALIDATION_ERROR");
    if (!options.giftPayments)
      return problem(context, 409, "PROVIDER_MODE_UNAVAILABLE");
    const siteId = context.req.param("siteId");
    const quote = await options.giftPayments.createQuote(siteId, input.data);
    const result = giftQuoteResponseSchema.safeParse({ quote });
    if (
      !result.success ||
      result.data.quote.siteId !== siteId ||
      result.data.quote.giftId !== input.data.giftId ||
      result.data.quote.method !== input.data.method ||
      result.data.quote.mode === "disabled"
    )
      return problem(context, 503, "SERVICE_UNAVAILABLE");
    return context.json(result.data);
  });
  router.post("/v1/public/sites/:siteId/gift-checkouts", async (context) => {
    const input = checkoutCreateInputSchema.safeParse(
      await readBody(context.req.raw),
    );
    if (!input.success) return problem(context, 400, "VALIDATION_ERROR");
    if (!options.giftPayments)
      return problem(context, 409, "PROVIDER_MODE_UNAVAILABLE");
    const checkout = await options.giftPayments.createCheckout(
      context.req.param("siteId"),
      input.data,
    );
    const result = checkoutResponseSchema.safeParse({ checkout });
    if (
      !result.success ||
      result.data.checkout.quoteId !== input.data.quoteId ||
      result.data.checkout.mode === "disabled" ||
      !isSafeCheckoutContinuation(
        result.data.checkout.hostedUrl,
        input.data.recoveryToken,
      )
    )
      return problem(context, 503, "SERVICE_UNAVAILABLE");
    return context.json(result.data);
  });
  router.post(
    "/v1/public/sites/:siteId/gift-checkouts/status",
    async (context) => {
      const input = checkoutStatusInputSchema.safeParse(
        await readBody(context.req.raw),
      );
      if (!input.success) return problem(context, 400, "VALIDATION_ERROR");
      if (!options.giftPayments)
        return problem(context, 409, "PROVIDER_MODE_UNAVAILABLE");
      const siteId = context.req.param("siteId");
      const status = await options.giftPayments.getStatus(siteId, input.data);
      const result = checkoutStatusResponseSchema.safeParse({ status });
      if (
        !result.success ||
        result.data.status.siteId !== siteId ||
        result.data.status.quoteId !== input.data.quoteId ||
        result.data.status.requestId !== input.data.requestId ||
        (result.data.status.checkout !== null &&
          !isSafeCheckoutContinuation(
            result.data.status.checkout.hostedUrl,
            input.data.recoveryToken,
          ))
      )
        return problem(context, 503, "SERVICE_UNAVAILABLE");
      return context.json(result.data);
    },
  );
  return router;
}
