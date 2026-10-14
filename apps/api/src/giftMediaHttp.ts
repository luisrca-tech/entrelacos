import {
  giftMediaFinalizeInputSchema,
  giftMediaFinalizeResponseSchema,
  giftMediaStatusResponseSchema,
  giftMediaUploadInputSchema,
  giftMediaUploadResponseSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  AdminSessionRequiredError,
  type AuthHttpOptions,
  readAdministrativeSession,
  requireAdminSession,
} from "./authHttp";
import {
  consultGiftMediaUpload,
  finalizeGiftMediaUpload,
  GiftMediaServiceError,
  type GiftMediaServiceOptions,
  issueGiftMediaUpload,
  recoverGiftMediaUpload,
} from "./giftMedia";
import { GiftServiceError } from "./gifts";
import { type SiteAccessActor, SiteAccessDeniedError } from "./siteAccess";

export type GiftMediaHttpOptions = AuthHttpOptions & GiftMediaServiceOptions;
function problem(context: Context, status: number, code: string): Response {
  return context.newResponse(
    JSON.stringify({
      type: "about:blank",
      status,
      code,
      title: "Gift image operation unavailable",
    }),
    status as ContentfulStatusCode,
    {
      "Content-Type": "application/problem+json",
      "Cache-Control": "no-store",
    },
  );
}
function current(signal: AbortSignal) {
  if (signal.aborted)
    throw new GiftMediaServiceError(
      503,
      "SERVICE_UNAVAILABLE",
      "Gift image operation unavailable",
    );
}
async function body(request: Request, signal: AbortSignal): Promise<unknown> {
  current(signal);
  const mediaType = request.headers
    .get("content-type")
    ?.split(";")[0]
    .trim()
    .toLowerCase();
  if (mediaType !== "application/json") return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation ??= reader.cancel().then(
      () => {},
      () => {},
    );
  };
  const timer = setTimeout(cancel, 15_000);
  signal.addEventListener("abort", cancel, { once: true });
  let size = 0;
  try {
    const bytes = new Uint8Array(16_384);
    if (signal.aborted) cancel();
    while (true) {
      current(signal);
      const { done, value } = await reader.read();
      current(signal);
      if (cancellation) return null;
      if (done) break;
      if (
        !(value instanceof Uint8Array) ||
        size + value.byteLength > bytes.byteLength
      ) {
        cancel();
        return null;
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)),
    );
  } catch (error) {
    cancel();
    current(signal);
    if (error instanceof GiftMediaServiceError) throw error;
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    if (cancellation) await cancellation;
    reader.releaseLock();
  }
}
export function createGiftMediaHttpRouter(options: GiftMediaHttpOptions) {
  const processing = options.processing;
  const router = new Hono<{
    Variables: {
      actor: SiteAccessActor;
      service: GiftMediaServiceOptions;
      signal: AbortSignal;
    };
  }>();
  router.onError((error, context) => {
    if (error instanceof AdminSessionRequiredError)
      return problem(context, 401, "UNAUTHORIZED");
    if (error instanceof SiteAccessDeniedError)
      return problem(context, 403, "MEMBERSHIP_DENIED");
    if (
      error instanceof GiftMediaServiceError ||
      error instanceof GiftServiceError
    )
      return problem(context, error.status, error.code);
    return problem(context, 503, "SERVICE_UNAVAILABLE");
  });
  router.use("/v1/sites/:siteId/gift-media/*", async (context, next) => {
    if (context.req.header("origin") !== options.adminOrigin)
      return problem(context, 403, "FORBIDDEN");
    if (!siteIdSchema.safeParse(context.req.param("siteId")).success)
      return problem(context, 400, "VALIDATION_ERROR");
    const request = context.req.raw;
    const operation = async (signal: AbortSignal) => {
      current(signal);
      const native = await requireAdminSession(request, options);
      current(signal);
      const subject = { userId: native.user.id, role: native.user.role };
      const sessionId = native.session.id;
      context.set("actor", subject);
      context.set("signal", signal);
      context.set("service", {
        storage: options.storage,
        storageNamespace: options.storageNamespace,
        processing,
        decode: options.decode,
        readReadiness: options.readReadiness,
        now: options.now,
        generateId: options.generateId,
        authorize: async (db = options.db) => {
          current(signal);
          const fresh = await readAdministrativeSession(request, {
            auth: options.auth,
            db,
            now: options.now,
          });
          current(signal);
          if (
            !fresh ||
            fresh.session.id !== sessionId ||
            fresh.user.id !== subject.userId ||
            fresh.user.role !== subject.role
          )
            throw new AdminSessionRequiredError();
          return { userId: fresh.user.id, role: fresh.user.role };
        },
      });
      context.header("Cache-Control", "no-store");
      await next();
      current(signal);
    };
    if (processing) await processing.track(operation, request.signal);
    else await operation(request.signal);
  });
  router.post("/v1/sites/:siteId/gift-media/uploads", async (context) => {
    if (context.req.raw.headers.has("content-encoding"))
      return problem(context, 400, "VALIDATION_ERROR");
    const input = giftMediaUploadInputSchema.safeParse(
      await body(context.req.raw, context.get("signal")),
    );
    if (!input.success) return problem(context, 400, "VALIDATION_ERROR");
    return context.json(
      giftMediaUploadResponseSchema.parse(
        await issueGiftMediaUpload(
          options.db,
          context.get("actor"),
          context.req.param("siteId"),
          input.data,
          context.get("service"),
        ),
      ),
      201,
    );
  });
  router.post(
    "/v1/sites/:siteId/gift-media/:assetId/finalize",
    async (context) => {
      const request = context.req.raw;
      const id = siteIdSchema.safeParse(context.req.param("assetId"));
      if (!id.success || request.headers.has("content-encoding"))
        return problem(context, 400, "VALIDATION_ERROR");
      const siteId = context.req.param("siteId");
      const actor = context.get("actor");
      const service = context.get("service");
      const signal = context.get("signal");
      const contentType = request.headers.get("content-type");
      if (
        contentType === "image/jpeg" ||
        contentType === "image/png" ||
        contentType === "image/webp"
      ) {
        const rawLength = request.headers.get("content-length");
        const contentLength =
          rawLength === null ? undefined : Number(rawLength);
        if (
          !request.body ||
          (rawLength !== null &&
            (!/^[1-9]\d*$/.test(rawLength) ||
              !Number.isSafeInteger(contentLength) ||
              (contentLength as number) > 5_242_880))
        )
          return problem(context, 400, "VALIDATION_ERROR");
        current(signal);
        const result = giftMediaFinalizeResponseSchema.parse(
          await finalizeGiftMediaUpload(
            options.db,
            actor,
            siteId,
            id.data,
            { body: request.body, contentType, contentLength, signal },
            service,
          ),
        );
        if (result.media.siteId !== siteId || result.media.id !== id.data)
          throw new Error("Unexpected finalized scope");
        return context.json(result);
      }
      const input = giftMediaFinalizeInputSchema.safeParse(
        await body(request, signal),
      );
      if (!input.success) return problem(context, 400, "VALIDATION_ERROR");
      const operation =
        input.data.action === "RECOVER"
          ? recoverGiftMediaUpload
          : consultGiftMediaUpload;
      const result = giftMediaStatusResponseSchema.parse(
        await operation(options.db, actor, siteId, id.data, service, signal),
      );
      if (result.status.siteId !== siteId || result.status.assetId !== id.data)
        throw new Error("Unexpected consultation scope");
      return context.json(result);
    },
  );
  return router;
}
