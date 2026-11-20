import type { MiddlewareHandler } from "hono";

export const OBSERVABILITY_MODES = ["unavailable", "manual", "live"] as const;

export type ObservabilityMode = (typeof OBSERVABILITY_MODES)[number];

export interface ObservabilityEvent {
  timestamp?: string;
  level?: "info" | "warn" | "error";
  event?: string;
  requestId?: string;
  routeTemplate?: string;
  method?: string;
  status?: number;
  durationMs?: number;
  operation?: string;
  result?: string;
  siteId?: string;
  actorRole?: string;
  mode?: ObservabilityMode;
  rateLimitOutcome?: string;
  datasetVersion?: string;
  count?: number;
  errorCode?: string;
  attemptId?: string;
  paymentMethod?: string;
  providerCode?: string;
  providerMessage?: string;
  /** `field.path: message` entries of a provider validation error. */
  providerFields?: string[];
}

export type ObservabilitySink = (event: ObservabilityEvent) => void;

export interface ObservabilityOptions {
  sink?: ObservabilitySink;
  id?: () => string;
  now?: () => Date;
}

export interface ObservabilityVariables {
  observabilityRequestId: string;
  observabilityEmit: (event: unknown) => void;
}

const ALLOWED_FIELDS = [
  "timestamp",
  "level",
  "event",
  "requestId",
  "routeTemplate",
  "method",
  "status",
  "durationMs",
  "operation",
  "result",
  "siteId",
  "actorRole",
  "mode",
  "rateLimitOutcome",
  "datasetVersion",
  "count",
  "errorCode",
  "attemptId",
  "paymentMethod",
  "providerCode",
  "providerMessage",
  "providerFields",
] as const satisfies readonly (keyof ObservabilityEvent)[];

const TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const ROUTE_PATTERN = /^\/[A-Za-z0-9_:.*/-]{0,191}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function boundedToken(value: unknown): string | undefined {
  return typeof value === "string" && TOKEN_PATTERN.test(value)
    ? value
    : undefined;
}

/**
 * Provider error codes are external text: keep only short code-shaped values
 * without digit runs, so an echoed document or phone never reaches the log.
 */
function providerCode(value: unknown): string | undefined {
  const token = boundedToken(value);
  if (token === undefined) return undefined;
  return /\d{4,}/.test(token) ? "redacted" : token;
}

export const PROVIDER_MESSAGE_LIMIT = 300;
export const PROVIDER_FIELD_LIMIT = 10;
const PROVIDER_FIELD_ENTRY_LIMIT = 240;

/**
 * Provider text may echo what was sent. Removes the shapes personal data
 * takes: quoted values, e-mails, runs of capitalized words (names are sent in
 * capitals) and any number of four or more digits, separators included
 * (CPF, phone, CEP, bank account, dates). Control characters are dropped and
 * the result is bounded.
 */
export function redactProviderText(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFC")
    .replace(/\p{Cc}+/gu, " ")
    .replace(
      /["'`\u2018\u2019\u201c\u201d][^"'`\u2018\u2019\u201c\u201d]*["'`\u2018\u2019\u201c\u201d]/g,
      "[valor]",
    )
    .replace(/[^\s@()[\]<>,;:]+@[^\s@()[\]<>,;:]+/g, "[e-mail]")
    .replace(/\b\p{Lu}{2,}(?:\s+\p{Lu}{2,})+\b/gu, "[valor]")
    .replace(/\d(?:[\d.\-/\s()]*\d)?/g, (number) =>
      (number.match(/\d/g)?.length ?? 0) >= 4 ? "[número]" : number,
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function providerFields(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const fields = value
    .filter((entry): entry is string => typeof entry === "string")
    .slice(0, PROVIDER_FIELD_LIMIT)
    .map((entry) => redactProviderText(entry, PROVIDER_FIELD_ENTRY_LIMIT))
    .filter(Boolean);
  return fields.length ? fields : undefined;
}

function boundedRoute(value: unknown): string | undefined {
  return typeof value === "string" &&
    ROUTE_PATTERN.test(value) &&
    !/\d{7,}/.test(value)
    ? value
    : undefined;
}

function boundedUuid(value: unknown): string | undefined {
  return typeof value === "string" && UUID_PATTERN.test(value)
    ? value
    : undefined;
}

function boundedNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function safeFieldValue(
  field: keyof ObservabilityEvent,
  value: unknown,
): string | number | string[] | undefined {
  if (field === "providerFields") return providerFields(value);
  if (field === "providerMessage")
    return redactProviderText(value, PROVIDER_MESSAGE_LIMIT) || undefined;
  if (field === "timestamp") {
    return typeof value === "string" &&
      value.length <= 64 &&
      TIMESTAMP_PATTERN.test(value)
      ? value
      : undefined;
  }
  if (field === "level") {
    return value === "info" || value === "warn" || value === "error"
      ? value
      : undefined;
  }
  if (field === "requestId" || field === "attemptId") return boundedUuid(value);
  if (field === "providerCode") return providerCode(value);
  if (field === "routeTemplate") return boundedRoute(value);
  if (field === "method") {
    return typeof value === "string" && /^[A-Z]{3,7}$/.test(value)
      ? value
      : undefined;
  }
  if (field === "status") {
    const status = nonNegativeInteger(value);
    return status !== undefined && status >= 100 && status <= 599
      ? status
      : undefined;
  }
  if (field === "durationMs") {
    const duration = boundedNumber(value);
    return duration !== undefined && duration >= 0 && duration <= 86_400_000
      ? duration
      : undefined;
  }
  if (field === "count") return nonNegativeInteger(value);
  if (field === "mode") {
    return typeof value === "string" &&
      (OBSERVABILITY_MODES as readonly string[]).includes(value)
      ? value
      : undefined;
  }
  return boundedToken(value);
}

export function sanitizeObservabilityEvent(input: unknown): ObservabilityEvent {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};

  const source = input as Record<string, unknown>;
  const output: ObservabilityEvent = {};
  for (const field of ALLOWED_FIELDS) {
    let value: string | number | string[] | undefined;
    try {
      value = safeFieldValue(field, source[field]);
    } catch {
      value = undefined;
    }
    if (value !== undefined) {
      output[field] = value as never;
    }
  }
  return output;
}

export function emitObservabilityEvent(
  sink: ObservabilitySink,
  input: unknown,
): void {
  sink(sanitizeObservabilityEvent(input));
}

function defaultSink(event: ObservabilityEvent): void {
  console.info(JSON.stringify(event));
}

/** Emits a sanitized event to the default structured log. */
export function logObservabilityEvent(input: unknown): void {
  emitObservabilityEvent(defaultSink, {
    timestamp: new Date().toISOString(),
    ...(input as object),
  });
}

function getRouteTemplate(routePath: unknown): string | undefined {
  return boundedRoute(routePath);
}

export function createObservabilityMiddleware(
  options: ObservabilityOptions = {},
): MiddlewareHandler<{ Variables: ObservabilityVariables }> {
  const sink = options.sink ?? defaultSink;
  const createId = options.id ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date());

  return async (context, next) => {
    const requestId = createId();
    context.set("observabilityRequestId", requestId);
    context.set("observabilityEmit", (event: unknown) =>
      emitObservabilityEvent(sink, { ...(event as object), requestId }),
    );
    const startedAt = now();

    await next();

    const endedAt = now();
    context.header("X-Request-Id", requestId);
    const response = context.res;

    let routePath: string | undefined;
    try {
      routePath = context.req.routePath;
    } catch {
      routePath = undefined;
    }

    emitObservabilityEvent(sink, {
      timestamp: endedAt.toISOString(),
      level:
        response.status >= 500
          ? "error"
          : response.status >= 400
            ? "warn"
            : "info",
      event: "http.request",
      requestId,
      routeTemplate: getRouteTemplate(routePath),
      method: context.req.method,
      status: response.status,
      durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
      operation: "request",
      result: response.status >= 400 ? "failure" : "success",
      rateLimitOutcome: response.status === 429 ? "limited" : undefined,
    });
  };
}
