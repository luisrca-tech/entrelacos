export interface ApiProxyOptions {
  apiBaseUrl: string;
  adminOrigin: string;
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
  const target = resolveTarget(request, options);
  if (target instanceof Response) return target;

  const requestHeaders = new Headers();
  for (const name of ["cookie", "content-type"]) {
    const value = request.headers.get(name);
    if (value) requestHeaders.set(name, value);
  }
  requestHeaders.set("Origin", options.adminOrigin);

  const method = request.method.toUpperCase();
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : await request.clone().arrayBuffer();
  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), {
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
