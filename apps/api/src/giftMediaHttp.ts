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
import { trustedAdminOrigin } from "./adminOrigin";
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
import { GiftMediaStorageError } from "./giftMediaStorage";
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
function matchesDerivativeEtag(
  condition: string | undefined,
  etag: string,
): boolean {
  const value = condition?.trim();
  if (value === "*") return true;
  if (
    !value ||
    !/^(?:W\/)?"[^"\\\r\n]*"(?:[ \t]*,[ \t]*(?:W\/)?"[^"\\\r\n]*")*$/.test(
      value,
    )
  )
    return false;
  return [...value.matchAll(/(?:W\/)?"[^"\\\r\n]*"/g)].some(
    ([tag]) => tag === etag || tag === `W/${etag}`,
  );
}
export function createGiftMediaHttpRouter(options: GiftMediaHttpOptions) {
  const processing = options.processing;
  let activePublicReads = 0;
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
  router.all("/gifts/*", async (context) => {
    const request = context.req.raw;
    const method = request.method;
    const failure = (status: number, code = "GIFT_MEDIA_UNAVAILABLE") => {
      const response = problem(context, status, code);
      return method === "HEAD"
        ? new Response(null, { status, headers: response.headers })
        : response;
    };
    if (method !== "GET" && method !== "HEAD") {
      const response = failure(405, "METHOD_NOT_ALLOWED");
      response.headers.set("Allow", "GET, HEAD");
      return response;
    }
    const path = new URL(request.url).pathname;
    if (
      !/^\/gifts\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/[A-Za-z0-9_-]{1,128}\.webp$/.test(
        path,
      )
    )
      return failure(404, "GIFT_MEDIA_NOT_FOUND");
    const storage = options.storage;
    if (!storage || !processing) return failure(503);
    try {
      return await processing.track(async (signal) => {
        if (activePublicReads >= 8) return failure(503);
        activePublicReads++;
        try {
          current(signal);
          const key = path.slice(1);
          const head = await storage.headDerivative(key, signal);
          current(signal);
          if (
            head.contentType !== "image/webp" ||
            !Number.isSafeInteger(head.byteLength) ||
            head.byteLength <= 0 ||
            head.byteLength > 5_242_880 ||
            !/^"[^"\\\r\n]{1,128}"$/.test(head.etag)
          )
            throw new Error("Gift image metadata unavailable");
          const headers = new Headers({
            "Content-Type": "image/webp",
            "Cache-Control": "public, max-age=31536000, immutable",
            ETag: head.etag,
            "X-Content-Type-Options": "nosniff",
          });
          if (
            matchesDerivativeEtag(
              context.req.header("If-None-Match"),
              head.etag,
            )
          )
            return new Response(null, { status: 304, headers });
          headers.set("Content-Length", String(head.byteLength));
          if (method === "HEAD")
            return new Response(null, { status: 200, headers });
          const bytes = await storage.readDerivative(
            key,
            head.etag,
            head.byteLength,
            signal,
          );
          current(signal);
          if (
            !(bytes instanceof Uint8Array) ||
            bytes.byteLength !== head.byteLength
          )
            throw new Error("Gift image body unavailable");
          return new Response(Buffer.from(bytes), { status: 200, headers });
        } catch (error) {
          current(signal);
          return error instanceof GiftMediaStorageError && error.status === 404
            ? failure(404, "GIFT_MEDIA_NOT_FOUND")
            : failure(503);
        } finally {
          activePublicReads--;
        }
      }, request.signal);
    } catch {
      return failure(503);
    }
  });
  router.use("/v1/sites/:siteId/gift-media/*", async (context, next) => {
    if (!trustedAdminOrigin(context.req.header("origin"), options.adminOrigin))
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
        applicationEnvironment: options.applicationEnvironment,
        liveDemoSiteId: options.liveDemoSiteId,
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
