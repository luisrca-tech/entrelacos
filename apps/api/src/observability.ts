import type { MiddlewareHandler } from "hono";

export const OBSERVABILITY_MODES = [
  "simulated",
  "unavailable",
  "manual",
  "live",
] as const;

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
): string | number | undefined {
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
  if (field === "requestId") return boundedUuid(value);
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
    let value: string | number | undefined;
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
