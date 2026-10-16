import { isPromise } from "node:util/types";
import {
  type ApiProblem,
  giftPurchaseHistoryDetailResponseSchema,
  giftPurchaseHistoryLimits,
  giftPurchaseHistoryPageResponseSchema,
  giftPurchaseHistoryPurchaseSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import { type Context, Hono } from "hono";
import {
  type GiftPaymentHistoryService,
  historyUnavailable,
} from "./giftPaymentHistory";

import { encodeGiftPurchaseHistoryCsv } from "./giftPaymentHistoryCsv";

export interface GiftPaymentHistoryHttpOptions {
  adminOrigin?: string;
  giftPaymentHistory?: GiftPaymentHistoryService;
}
export type GiftPaymentHistoryHttpRouter = Hono & { close(): Promise<void> };
export const giftPaymentHistoryHttpPaths = Object.freeze([
  "/v1/sites/:siteId/finance/purchases",
  "/v1/sites/:siteId/finance/purchases/:orderId/history",
  "/v1/sites/:siteId/finance/purchases.csv",
] as const);

function problem(
  status: 400 | 403 | 405 | 503,
  code: string,
  allow = false,
): Response {
  return new Response(
    JSON.stringify({
      type: "about:blank",
      status,
      code,
      title:
        status === 503
          ? "Purchase history unavailable"
          : status === 403
            ? "Forbidden"
            : status === 405
              ? "Method not allowed"
              : "Invalid purchase history request",
    } satisfies ApiProblem),
    {
      status,
      headers: {
        "Content-Type": "application/problem+json",
        "Cache-Control": "no-store",
        ...(allow ? { Allow: "GET, HEAD" } : {}),
      },
    },
  );
}
function unavailable() {
  return problem(503, "GIFT_PAYMENT_HISTORY_UNAVAILABLE");
}
function configuration(options?: GiftPaymentHistoryHttpOptions) {
  try {
    const origin = options?.adminOrigin,
      service = options?.giftPaymentHistory;
    if (
      !origin ||
      new URL(origin).origin !== origin ||
      service?.available !== true ||
      typeof service.readPurchasePage !== "function" ||
      typeof service.readPurchaseDetailPage !== "function" ||
      typeof service.close !== "function"
    )
      return undefined;
    return Object.freeze({
      origin,
      readPage: service.readPurchasePage.bind(service),
      readDetail: service.readPurchaseDetailPage.bind(service),
      close: service.close.bind(service),
    });
  } catch {
    return undefined;
  }
}
function input(context: Context, detail: boolean) {
  const request = context.req.raw;
  const url = new URL(request.url),
    length = request.headers.get("content-length");
  const site = siteIdSchema.safeParse(context.req.param("siteId"));
  const order = detail
    ? giftPurchaseHistoryPurchaseSchema.shape.orderId.safeParse(
        context.req.param("orderId"),
      )
    : undefined;
  if (
    !site.success ||
    (detail && !order?.success) ||
    request.body ||
    (length !== null && length !== "0") ||
    request.headers.has("transfer-encoding") ||
    new TextEncoder().encode(url.search).byteLength > 1024
  )
    return null;
  const parameters = [...url.searchParams];
  if (
    parameters.length > 1 ||
    (parameters.length === 1 && parameters[0][0] !== "cursor")
  )
    return null;
  const cursor =
    giftPurchaseHistoryPageResponseSchema.shape.history.shape.nextCursor.safeParse(
      parameters.length === 1 ? parameters[0][1] : null,
    );
  if (!cursor.success) return null;
  return {
    request,
    siteId: site.data,
    orderId: order?.success ? order.data : undefined,
    cursor: cursor.data,
  };
}
function normalize(
  value: unknown,
  siteId: string,
  orderId: string | undefined,
  csv: boolean,
): string {
  if (csv) return encodeGiftPurchaseHistoryCsv(value, siteId);
  const reply =
    orderId === undefined
      ? giftPurchaseHistoryPageResponseSchema.parse(value)
      : giftPurchaseHistoryDetailResponseSchema.parse(value);
  if (
    reply.history.scope.siteId !== siteId ||
    (orderId !== undefined &&
      (!("originalPurchase" in reply.history) ||
        reply.history.originalPurchase.orderId !== orderId))
  )
    return historyUnavailable();
  const json = JSON.stringify(reply);
  if (
    new TextEncoder().encode(json).byteLength >
    giftPurchaseHistoryLimits.jsonBytes
  )
    return historyUnavailable();
  return json;
}
export function createGiftPaymentHistoryHttpRouter(
  options?: GiftPaymentHistoryHttpOptions,
): GiftPaymentHistoryHttpRouter {
  const router = new Hono();
  const configured = configuration(options);
  const pending = new Set<{ settled: Promise<void>; cancel(): void }>();
  let closing = false,
    closed: Promise<void> | undefined;
  router.onError(() => unavailable());

  async function read(
    context: Context,
    detail: boolean,
    csv: boolean,
  ): Promise<Response> {
    if (closing || !configured) return unavailable();
    if (context.req.header("origin") !== configured.origin)
      return problem(403, "FORBIDDEN");
    const parsed = input(context, detail);
    if (!parsed) return problem(400, "VALIDATION_ERROR");
    if (
      csv &&
      parsed.cursor !== null &&
      !/^gh1\.[A-Za-z0-9_-]+$/.test(parsed.cursor)
    )
      return problem(400, "VALIDATION_ERROR");
    const { request, siteId, orderId, cursor } = parsed,
      signal = request.signal;
    if (signal.aborted) return unavailable();

    let finish!: () => void;
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let aborted = false,
      cancelledPort = false,
      portFailed = false,
      cancelPort: (() => void) | undefined;
    const cancel = () => {
      aborted = true;
      if (cancelPort && !cancelledPort) {
        cancelledPort = true;
        try {
          cancelPort();
        } catch {
          portFailed = true;
        }
      }
    };
    const job = { settled, cancel };
    pending.add(job);
    signal.addEventListener("abort", cancel, { once: true });
    let drained: Promise<PromiseSettledResult<string | true>[]> | undefined;
    try {
      if (signal.aborted) cancel();
      if (aborted || closing) return unavailable();
      const owner = detail
        ? configured.readDetail({
            request,
            siteId,
            orderId: orderId as string,
            cursor,
          })
        : configured.readPage({ request, siteId, cursor });
      // Observe both promises before cancellation or any await can interrupt ownership.
      const result = (async () => {
        const promise = owner.result;
        if (!isPromise(promise)) return historyUnavailable();
        return normalize(await promise, siteId, orderId, csv);
      })();
      const completion = (async () => {
        const promise = owner.completion;
        if (!isPromise(promise)) return historyUnavailable();
        await promise;
        return true as const;
      })();
      drained = Promise.allSettled([result, completion]);
      try {
        cancelPort = owner.cancel.bind(owner);
      } catch {
        portFailed = true;
      }
      if (aborted || closing) cancel();
      const outcomes = await drained;
      if (
        aborted ||
        closing ||
        portFailed ||
        outcomes[0].status !== "fulfilled" ||
        outcomes[1].status !== "fulfilled" ||
        typeof outcomes[0].value !== "string"
      )
        return unavailable();
      return new Response(outcomes[0].value, {
        status: 200,
        headers: {
          "Content-Type": csv
            ? "text/csv; charset=UTF-8"
            : "application/json; charset=UTF-8",
          "Cache-Control": "no-store",
          ...(csv
            ? {
                "Content-Disposition":
                  'attachment; filename="gift-purchases.csv"',
                "X-Content-Type-Options": "nosniff",
              }
            : {}),
        },
      });
    } catch {
      return unavailable();
    } finally {
      if (drained) await drained;
      signal.removeEventListener("abort", cancel);
      pending.delete(job);
      finish();
    }
  }
  for (const [index, path] of giftPaymentHistoryHttpPaths.entries()) {
    router.get(path, (context) => read(context, index === 1, index === 2));
    router.all(path, () => problem(405, "METHOD_NOT_ALLOWED", true));
  }
  function close(): Promise<void> {
    if (closed) return closed;
    closing = true;
    let resolve!: () => void, reject!: (error: unknown) => void;
    closed = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const jobs = [...pending];
    for (const job of jobs) job.cancel();
    const service = (async () => {
      await configured?.close();
    })();
    void Promise.allSettled([...jobs.map((job) => job.settled), service]).then(
      (results) => {
        if (results.some((result) => result.status === "rejected")) {
          try {
            historyUnavailable();
          } catch (error) {
            reject(error);
          }
        } else resolve();
      },
    );
    return closed;
  }
  return Object.assign(router, { close });
}
