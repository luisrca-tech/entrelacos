import {
  apiProblemSchema,
  giftPurchaseHistoryLimits,
  giftPurchaseHistoryPageResponseSchema,
  giftPurchaseHistoryPurchaseSchema,
  siteIdSchema,
} from "@entrelacos/contracts";

export interface ApiProxyOptions {
  apiBaseUrl: string;
  adminOrigin: string;
}

let binaryInFlight = false;
async function mediaUpstream(
  request: Request,
  target: URL,
  headers: Headers,
  binary: boolean,
): Promise<Response> {
  const limit = binary ? 5_242_880 : 16_384;
  const rawLength = request.headers.get("content-length");
  const length = rawLength === null ? undefined : Number(rawLength);
  if (
    !request.body ||
    request.headers.has("content-encoding") ||
    (rawLength !== null &&
      (!/^[1-9]\d*$/.test(rawLength) ||
        !Number.isSafeInteger(length) ||
        (length as number) > limit))
  )
    return problem(400, "VALIDATION_ERROR", "Invalid image request");
  if (binary && binaryInFlight)
    return problem(409, "GIFT_MEDIA_BUSY", "Image processing is busy");
  if (binary) binaryInFlight = true;
  const abort = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancellation: Promise<void> | undefined;
  let responseReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let responseCancellation: Promise<void> | undefined;
  let inputStopped = false;
  let forwardController:
    | ReadableStreamDefaultController<Uint8Array>
    | undefined;
  let forwardClosed = false;
  const pending = new Set<Promise<void>>();
  const cancel = () => {
    if (reader)
      cancellation ??= reader.cancel().then(
        () => {},
        () => {},
      );
  };
  const stop = () => {
    abort.abort();
    cancel();
    cancelResponse();
  };
  const cancelResponse = () => {
    if (responseReader)
      responseCancellation ??= responseReader.cancel().then(
        () => {},
        () => {},
      );
  };
  const timer = setTimeout(stop, 45_000);
  const bodyTimer = setTimeout(stop, 15_000);
  request.signal.addEventListener("abort", stop, { once: true });
  let size = 0;
  let result: Response;
  try {
    if (request.signal.aborted) stop();
    if (abort.signal.aborted) throw new Error("Canceled request");
    reader = request.body.getReader();
    const sourceReader = reader;
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          forwardController = controller;
        },
        pull(controller) {
          const work = (async () => {
            try {
              if (abort.signal.aborted) throw new Error("Canceled request");
              const { done, value } = await sourceReader.read();
              if (abort.signal.aborted) throw new Error("Canceled request");
              if (inputStopped) return;
              if (done) {
                clearTimeout(bodyTimer);
                if (length !== undefined && size !== length)
                  throw new Error("Invalid length");
                forwardClosed = true;
                controller.close();
                return;
              }
              if (
                !(value instanceof Uint8Array) ||
                size + value.byteLength > limit ||
                (length !== undefined && size + value.byteLength > length)
              )
                throw new Error("Invalid length");
              size += value.byteLength;
              controller.enqueue(new Uint8Array(value));
            } catch (error) {
              stop();
              if (!forwardClosed) {
                forwardClosed = true;
                controller.error(error);
              }
            }
          })();
          pending.add(work);
          void work.then(
            () => pending.delete(work),
            () => pending.delete(work),
          );
          return work;
        },
        cancel() {
          forwardClosed = true;
          stop();
          return cancellation;
        },
      },
      { highWaterMark: 0 },
    );
    if (rawLength !== null) headers.set("Content-Length", rawLength);
    const transport = fetch;
    if (abort.signal.aborted) throw new Error("Canceled request");
    const upstream = await transport(target.toString(), {
      method: "POST",
      headers,
      body: stream,
      signal: abort.signal,
      redirect: "manual",
      ...{ duplex: "half" },
    });
    if (abort.signal.aborted) {
      await upstream.body?.cancel();
      throw new Error("Canceled request");
    }
    inputStopped = true;
    if (!forwardClosed) {
      forwardClosed = true;
      forwardController?.close();
    }
    clearTimeout(bodyTimer);
    cancel();
    if (!upstream.body) result = upstream;
    else {
      responseReader = upstream.body.getReader();
      const responseBytes = new Uint8Array(16_384);
      let responseSize = 0;
      while (true) {
        if (abort.signal.aborted) throw new Error("Canceled response");
        const { done, value } = await responseReader.read();
        if (abort.signal.aborted) throw new Error("Canceled response");
        if (done) break;
        if (
          !(value instanceof Uint8Array) ||
          responseSize + value.byteLength > responseBytes.byteLength
        )
          throw new Error("Invalid response length");
        responseBytes.set(value, responseSize);
        responseSize += value.byteLength;
      }
      result = new Response(responseBytes.subarray(0, responseSize), {
        status: upstream.status,
        headers: upstream.headers,
      });
    }
  } catch {
    stop();
    result = problem(502, "UPSTREAM_UNAVAILABLE", "API unavailable");
  } finally {
    cancel();
    cancelResponse();
    if (cancellation) await cancellation;
    if (responseCancellation) await responseCancellation;
    await Promise.allSettled([...pending]);
    reader?.releaseLock();
    responseReader?.releaseLock();
    clearTimeout(timer);
    clearTimeout(bodyTimer);
    request.signal.removeEventListener("abort", stop);
    if (binary) binaryInFlight = false;
  }
  return abort.signal.aborted
    ? problem(502, "UPSTREAM_UNAVAILABLE", "API unavailable")
    : result;
}

function problem(status: number, code: string, title: string): Response {
  return new Response(
    JSON.stringify({
      type: "about:blank",
      title,
      status,
      code,
    }),
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      },
    },
  );
}

function copyResponseHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const name of [
    "cache-control",
    "content-disposition",
    "content-type",
    "pragma",
    "vary",
    "x-request-id",
  ]) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }

  const sourceWithCookies = source as Headers & {
    getSetCookie?: () => string[];
  };
  const cookies = sourceWithCookies.getSetCookie?.() ?? [];
  if (cookies.length > 0) {
    for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  } else {
    const cookie = source.get("set-cookie");
    if (cookie) headers.set("Set-Cookie", cookie);
  }
  return headers;
}

function removeNativeAuthSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeNativeAuthSecrets);
  if (!value || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      [
        "token",
        "sessionToken",
        "accessToken",
        "refreshToken",
        "cookie",
      ].includes(key)
    ) {
      continue;
    }
    result[key] = removeNativeAuthSecrets(entry);
  }
  return result;
}

function isNativeAuthPath(pathname: string): boolean {
  return (
    pathname === "/v1/auth/sign-in/email" || pathname === "/v1/auth/sign-out"
  );
}

type HistoryTarget = { target: URL; origin: string; method: "GET" | "HEAD" };
function historyProblem(
  method: string,
  status: number,
  code: string,
  title: string,
  allow = false,
): Response {
  const response = problem(status, code, title);
  if (allow) response.headers.set("Allow", "GET, HEAD");
  return method === "HEAD"
    ? new Response(null, { status, headers: response.headers })
    : response;
}

function resolveHistoryTarget(
  request: Request,
  options: ApiProxyOptions,
): HistoryTarget | Response | undefined {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return undefined;
  }
  // Reserve the family before validating its method or tuple; invalid history never uses ordinary buffering.
  if (
    !/^\/api\/v1\/sites\/[^/]*\/finance\/purchases(?:\/|$)/.test(url.pathname)
  )
    return undefined;
  const method = request.method.toUpperCase();
  const denied = (status: number, code: string, title: string, allow = false) =>
    historyProblem(method, status, code, title, allow);
  let origin: string, base: URL;
  try {
    origin = options.adminOrigin;
    base = new URL(options.apiBaseUrl);
    if (
      new URL(origin).origin !== origin ||
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      (base.pathname !== "/" && base.pathname !== "")
    )
      throw new Error("Invalid proxy configuration");
  } catch {
    return denied(500, "CONFIGURATION_ERROR", "API proxy is unavailable");
  }
  const suppliedOrigin = request.headers.get("origin");
  if (
    url.origin !== origin ||
    request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site" ||
    (suppliedOrigin !== null && suppliedOrigin !== origin) ||
    (method !== "GET" && method !== "HEAD" && suppliedOrigin !== origin)
  )
    return denied(403, "FORBIDDEN", "Forbidden");
  if (method !== "GET" && method !== "HEAD")
    return denied(405, "METHOD_NOT_ALLOWED", "Method not allowed", true);
  const parts = url.pathname.split("/");
  if (!siteIdSchema.safeParse(parts[4]).success)
    return denied(404, "NOT_FOUND", "Not Found");
  if (parts.length !== 7 && (parts.length !== 9 || parts[8] !== "history"))
    return denied(404, "NOT_FOUND", "Not Found");
  if (parts.length === 9) {
    const raw = parts[7];
    let original: string;
    try {
      original = decodeURIComponent(raw);
    } catch {
      return denied(404, "NOT_FOUND", "Not Found");
    }
    if (
      !giftPurchaseHistoryPurchaseSchema.shape.orderId.safeParse(original)
        .success ||
      (raw.includes("%")
        ? encodeURIComponent(original).replaceAll(".", "%2E") !== raw
        : raw.includes(".."))
    )
      return denied(404, "NOT_FOUND", "Not Found");
  }
  const parameters = [...url.searchParams],
    length = request.headers.get("content-length");
  if (
    url.hash ||
    request.body ||
    (length !== null && length !== "0") ||
    request.headers.has("transfer-encoding") ||
    new TextEncoder().encode(url.search).byteLength > 1024 ||
    parameters.length > 1 ||
    (parameters.length === 1 && parameters[0][0] !== "cursor") ||
    !giftPurchaseHistoryPageResponseSchema.shape.history.shape.nextCursor.safeParse(
      parameters.length ? parameters[0][1] : null,
    ).success
  )
    return denied(400, "VALIDATION_ERROR", "Invalid purchase history request");
  const path = `/v1/${url.pathname.slice("/api/v1/".length)}`;
  const target = new URL(path, base);
  if (target.origin !== base.origin || target.pathname !== path)
    return denied(404, "NOT_FOUND", "Not Found");
  target.search = url.search;
  return { target, origin, method };
}

async function historyUpstream(
  request: Request,
  resolved: HistoryTarget,
): Promise<Response> {
  const { target, origin, method } = resolved;
  const transport = fetch,
    signal = request.signal,
    abort = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    if (reader && !cancellation) {
      try {
        cancellation = reader.cancel().then(
          () => {},
          () => {},
        );
      } catch {
        cancellation = Promise.resolve();
      }
    }
  };
  const stop = () => {
    abort.abort();
    cancel();
  };
  const unavailable = () =>
    historyProblem(method, 502, "UPSTREAM_UNAVAILABLE", "API unavailable");
  const assertCurrent = () => {
    if (abort.signal.aborted) throw new Error("History transport unavailable");
  };
  const timer = setTimeout(stop, 45_000);
  signal.addEventListener("abort", stop, { once: true });
  let result: Response;
  try {
    if (signal.aborted) stop();
    assertCurrent();
    const headers = new Headers();
    for (const name of ["cookie", "content-type"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set("Origin", origin);
    assertCurrent();
    const upstream = await transport(target.toString(), {
      method,
      headers,
      signal: abort.signal,
      redirect: "manual",
      cache: "no-store",
    });
    if (upstream.body) reader = upstream.body.getReader();
    assertCurrent();
    const bytes = new Uint8Array(giftPurchaseHistoryLimits.jsonBytes);
    let size = 0;
    if (reader) {
      while (true) {
        assertCurrent();
        pendingRead = reader.read();
        const { done, value } = await pendingRead;
        assertCurrent();
        if (done) break;
        if (
          !(value instanceof Uint8Array) ||
          size + value.byteLength > bytes.byteLength
        )
          throw new Error("History response exceeds bound");
        bytes.set(value, size);
        size += value.byteLength;
      }
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, size),
    );
    const status = upstream.status;
    const contentType = upstream.headers
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .toLowerCase();
    assertCurrent();
    if (upstream.ok) {
      if (reader || method !== "HEAD") {
        if (contentType !== "application/json")
          throw new Error("History JSON unavailable");
        JSON.parse(text);
      }
      const headers = copyResponseHeaders(upstream.headers);
      headers.set("Cache-Control", "no-store");
      result = new Response(method === "HEAD" ? null : text, {
        status,
        headers,
      });
    } else {
      if (reader || method !== "HEAD") {
        if (
          contentType !== "application/json" &&
          contentType !== "application/problem+json"
        )
          throw new Error("History problem unavailable");
        const parsed = apiProblemSchema.parse(JSON.parse(text));
        if (parsed.status !== status)
          throw new Error("History problem status mismatch");
      }
      if (![400, 401, 403, 404, 405, 409, 429, 500, 502, 503].includes(status))
        throw new Error("Unsupported history outcome");
      const code =
        status === 401
          ? "UNAUTHENTICATED"
          : status === 403
            ? "FORBIDDEN"
            : status === 405
              ? "METHOD_NOT_ALLOWED"
              : "GIFT_PAYMENT_HISTORY_UNAVAILABLE";
      result = historyProblem(
        method,
        status,
        code,
        status === 401
          ? "Unauthenticated"
          : status === 403
            ? "Forbidden"
            : "Purchase history unavailable",
        status === 405,
      );
    }
  } catch {
    stop();
    result = unavailable();
  } finally {
    cancel();
    if (pendingRead) await Promise.allSettled([pendingRead]);
    if (cancellation) await cancellation;
    reader?.releaseLock();
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
  return abort.signal.aborted ? unavailable() : result;
}

function resolveTarget(
  request: Request,
  options: ApiProxyOptions,
): URL | Response {
  let requestUrl: URL;
  let adminOriginUrl: URL;
  try {
    requestUrl = new URL(request.url);
    adminOriginUrl = new URL(options.adminOrigin);
  } catch {
    return problem(500, "CONFIGURATION_ERROR", "API proxy is unavailable");
  }
  if (requestUrl.origin !== adminOriginUrl.origin) {
    return problem(403, "FORBIDDEN", "Forbidden");
  }

  const method = request.method.toUpperCase();
  const requestOrigin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite === "cross-site") {
    return problem(403, "FORBIDDEN", "Forbidden");
  }
  if (method === "GET" || method === "HEAD") {
    if (
      (requestOrigin && requestOrigin !== options.adminOrigin) ||
      (!requestOrigin && requestUrl.origin !== adminOriginUrl.origin)
    ) {
      return problem(403, "FORBIDDEN", "Forbidden");
    }
  } else if (requestOrigin !== options.adminOrigin) {
    return problem(403, "FORBIDDEN", "Forbidden");
  }

  let apiBase: URL;
  try {
    apiBase = new URL(options.apiBaseUrl);
  } catch {
    return problem(500, "CONFIGURATION_ERROR", "API proxy is unavailable");
  }
  if (
    !["http:", "https:"].includes(apiBase.protocol) ||
    apiBase.username ||
    apiBase.password ||
    apiBase.search ||
    apiBase.hash ||
    (apiBase.pathname !== "/" && apiBase.pathname !== "")
  ) {
    return problem(500, "CONFIGURATION_ERROR", "API proxy is unavailable");
  }

  const pathname = requestUrl.pathname;
  if (!pathname.startsWith("/api/v1/")) {
    return problem(404, "NOT_FOUND", "Not Found");
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return problem(404, "NOT_FOUND", "Not Found");
  }
  if (
    decodedPath !== pathname ||
    decodedPath.includes("..") ||
    decodedPath.includes("\\")
  ) {
    return problem(404, "NOT_FOUND", "Not Found");
  }

  const target = new URL(`/v1/${pathname.slice("/api/v1/".length)}`, apiBase);
  target.search = requestUrl.search;
  return target;
}

export async function proxyApiRequest(
  request: Request,
  options: ApiProxyOptions,
): Promise<Response> {
  const history = resolveHistoryTarget(request, options);
  if (history instanceof Response) return history;
  if (history) return historyUpstream(request, history);
  const target = resolveTarget(request, options);
  if (target instanceof Response) return target;

  const requestHeaders = new Headers();
  for (const name of ["cookie", "content-type"]) {
    const value = request.headers.get(name);
    if (value) requestHeaders.set(name, value);
  }
  requestHeaders.set("Origin", options.adminOrigin);

  const method = request.method.toUpperCase();
  const mediaRoute =
    method === "POST" &&
    /^\/v1\/sites\/[a-zA-Z0-9_-]+\/gift-media\/(uploads|[a-zA-Z0-9_-]+\/finalize)$/.test(
      target.pathname,
    );
  const requestContentType = request.headers.get("content-type");
  const binary =
    requestContentType === "image/jpeg" ||
    requestContentType === "image/png" ||
    requestContentType === "image/webp";
  if (
    mediaRoute &&
    ((!binary &&
      requestContentType?.split(";")[0].trim().toLowerCase() !==
        "application/json") ||
      (binary && target.pathname.endsWith("/uploads")))
  )
    return problem(400, "VALIDATION_ERROR", "Invalid image request");
  const body =
    mediaRoute || method === "GET" || method === "HEAD"
      ? undefined
      : await request.clone().arrayBuffer();
  let upstream: Response;
  try {
    upstream = mediaRoute
      ? await mediaUpstream(request, target, requestHeaders, binary)
      : await fetch(target.toString(), {
          method,
          headers: requestHeaders,
          body,
          redirect: "manual",
        });
  } catch {
    return problem(502, "UPSTREAM_UNAVAILABLE", "API unavailable");
  }

  const headers = copyResponseHeaders(upstream.headers);
  const contentType = upstream.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  const text = await upstream.text();
  let bodyValue: unknown;
  try {
    bodyValue = JSON.parse(text);
  } catch {
    return new Response(text, { status: upstream.status, headers });
  }
  if (isNativeAuthPath(target.pathname)) {
    bodyValue = removeNativeAuthSecrets(bodyValue);
  }
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(bodyValue), {
    status: upstream.status,
    headers,
  });
}
