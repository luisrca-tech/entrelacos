export const PAGARME_API_BASE_URL = "https://api.pagar.me/core/v5";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PROVIDER_MESSAGE_LENGTH = 500;

/** Pagar.me refused the request (4xx): nothing was created or changed. */
export class PagarmeRejectedError extends Error {
  readonly outcome = "rejected";

  constructor(
    readonly status: number,
    readonly providerCode: string | null,
    readonly providerMessage: string | null,
  ) {
    super(`Pagar.me rejected the request (${status})`);
    this.name = "PagarmeRejectedError";
  }
}

/**
 * The request may or may not have been applied (5xx, timeout, network
 * failure or unreadable success body). Callers must re-read the resource or
 * retry with the same idempotency key.
 */
export class PagarmeUnknownOutcomeError extends Error {
  readonly outcome = "unknown";

  constructor(
    readonly reason: "server" | "timeout" | "network" | "invalid_response",
    readonly status: number | null = null,
  ) {
    super(`Pagar.me request outcome is unknown (${reason})`);
    this.name = "PagarmeUnknownOutcomeError";
  }
}

export interface PagarmeHttpClientOptions {
  secretKey: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface PagarmeRequestOptions {
  body?: unknown;
  /** Sent as `Idempotency-Key`; reuse it when retrying an unknown outcome. */
  idempotencyKey?: string;
}

export interface PagarmeHttpClient {
  request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    options?: PagarmeRequestOptions,
  ): Promise<T>;
}

function assertPath(path: string) {
  if (
    !/^\/[A-Za-z0-9_\-./?=&%[\]]*$/.test(path) ||
    path.includes("//") ||
    path.includes("..")
  )
    throw new TypeError("Unsafe Pagar.me path");
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** Tolerates the error shapes used across Pagar.me v5 endpoints. */
function readProviderError(body: unknown): {
  code: string | null;
  message: string | null;
} {
  if (!body || typeof body !== "object") return { code: null, message: null };
  const record = body as Record<string, unknown>;
  const nested =
    record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>)
      : undefined;
  const errors = record.errors;
  const first =
    Array.isArray(errors) && errors[0] && typeof errors[0] === "object"
      ? (errors[0] as Record<string, unknown>)
      : undefined;
  const fieldCode =
    errors && typeof errors === "object" && !Array.isArray(errors)
      ? (Object.keys(errors)[0] ?? null)
      : null;
  return {
    code:
      text(nested?.code) ??
      text(record.code) ??
      text(first?.type) ??
      fieldCode ??
      text(record.type),
    message:
      text(record.message) ??
      text(nested?.message) ??
      text(first?.message) ??
      text(record.detail),
  };
}

export function createPagarmeHttpClient(
  options: PagarmeHttpClientOptions,
): PagarmeHttpClient {
  const { secretKey } = options;
  if (!/^sk_[A-Za-z0-9_-]+$/.test(secretKey) || secretKey.length > 8192)
    throw new Error("Pagar.me client configuration is invalid");
  const fetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const authorization = `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`;
  const redact = (value: string | null) =>
    value === null
      ? null
      : value
          .split(secretKey)
          .join("[redacted]")
          .slice(0, MAX_PROVIDER_MESSAGE_LENGTH);

  return {
    async request<T>(
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      path: string,
      requestOptions: PagarmeRequestOptions = {},
    ): Promise<T> {
      assertPath(path);
      const headers: Record<string, string> = {
        accept: "application/json",
        authorization,
      };
      const { body, idempotencyKey } = requestOptions;
      if (idempotencyKey !== undefined) {
        if (!/^[!-~]{1,255}$/.test(idempotencyKey))
          throw new TypeError("Invalid idempotency key");
        headers["idempotency-key"] = idempotencyKey;
      }
      if (body !== undefined) headers["content-type"] = "application/json";
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      let raw: string;
      try {
        response = await fetch(`${PAGARME_API_BASE_URL}${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "error",
          signal: controller.signal,
        });
        raw = await response.text();
      } catch {
        throw new PagarmeUnknownOutcomeError(
          controller.signal.aborted ? "timeout" : "network",
        );
      } finally {
        clearTimeout(timer);
      }
      let parsed: unknown;
      let readable = true;
      try {
        parsed = raw ? JSON.parse(raw) : undefined;
      } catch {
        readable = false;
      }
      if (response.status >= 400 && response.status < 500) {
        const error = readable
          ? readProviderError(parsed)
          : { code: null, message: null };
        throw new PagarmeRejectedError(
          response.status,
          redact(error.code),
          redact(error.message),
        );
      }
      if (!response.ok)
        throw new PagarmeUnknownOutcomeError("server", response.status);
      if (!readable || parsed === undefined)
        throw new PagarmeUnknownOutcomeError(
          "invalid_response",
          response.status,
        );
      return parsed as T;
    },
  };
}
