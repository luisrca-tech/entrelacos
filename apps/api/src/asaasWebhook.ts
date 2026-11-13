import { createHash, timingSafeEqual } from "node:crypto";
import { allowsLiveSite, type LiveSitePolicy } from "./liveSitePolicy";

export interface AsaasWebhookBinding {
  siteId: string;
  accountId: string;
  provider: "ASAAS";
  providerAccountReference: string;
  environment: "sandbox" | "live";
  webhookTokenHash: string;
  isDemo: boolean;
}

export interface AsaasInboxEvent {
  id: string;
  siteId: string;
  accountId: string;
  provider: "ASAAS";
  environment: "sandbox" | "live";
  providerAccountReference: string;
  providerEventId: string;
  eventType: string;
  payload: Readonly<Record<string, string>>;
  payloadHash: string;
  receivedAt: string;
}

// Correlation references read from a platform-account (V2) notification.
export interface AsaasPlatformEventReferences {
  externalReference?: string;
  paymentId?: string;
  // Checkout, checkout session and installment plan references.
  providerReferences: string[];
}

// The couple binding a platform event belongs to, resolved from stored attempts.
export interface AsaasPlatformEventRoute {
  siteId: string;
  accountId: string;
  providerAccountReference: string;
  environment: "sandbox" | "live";
  attemptId: string;
  isDemo: boolean;
}

export interface AsaasUnroutablePlatformEvent {
  environment: "sandbox" | "live";
  providerEventId: string;
  eventType: string;
  paymentReference: string;
}

export interface AsaasPlatformWebhookBinding {
  // sha256 hex of ASAAS_PLATFORM_WEBHOOK_TOKEN.
  webhookTokenHash: string;
  // ASAAS_PLATFORM_ACCOUNT_ID; every platform notification must carry it.
  accountReference: string;
  route(
    references: Readonly<AsaasPlatformEventReferences>,
  ): Promise<AsaasPlatformEventRoute | null>;
  recordUnroutable(event: Readonly<AsaasUnroutablePlatformEvent>): Promise<void>;
}

export interface AsaasWebhookDependencies extends LiveSitePolicy {
  mode: "disabled" | "sandbox" | "live";
  applicationEnvironment: "development" | "test" | "production";
  resolveBinding(tokenHash: string): Promise<AsaasWebhookBinding | null>;
  platform?: AsaasPlatformWebhookBinding;
  repository: {
    // Atomically deduplicate by provider/account/environment/event ID and compare normalized hash.
    append(
      event: Readonly<AsaasInboxEvent>,
    ): Promise<"INSERTED" | "DUPLICATE" | "COLLISION">;
  };
  now(): Date;
  generateId(): string;
}

export class AsaasWebhookError extends Error {
  constructor(
    readonly status: 400 | 401 | 503,
    readonly code:
      | "WEBHOOK_INVALID"
      | "WEBHOOK_AUTH_DENIED"
      | "WEBHOOK_UNAVAILABLE",
  ) {
    super(
      code === "WEBHOOK_UNAVAILABLE"
        ? "Webhook unavailable"
        : "Webhook rejected",
    );
    this.name = "AsaasWebhookError";
  }
}

function reject(
  status: 400 | 401 | 503,
  code: AsaasWebhookError["code"],
): never {
  throw new AsaasWebhookError(status, code);
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function reference(value: unknown, maximum = 256): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximum &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

function sameHash(left: string, right: unknown): boolean {
  return (
    typeof right === "string" &&
    /^[a-f0-9]{64}$/.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}

export function hashAsaasEventIdentity(
  eventId: string,
  eventType: string,
  accountReference: string,
  payload: Readonly<Record<string, string>>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        eventId,
        eventType,
        accountReference,
        Object.keys(payload)
          .sort()
          .map((key) => [key, payload[key]]),
      ]),
    )
    .digest("hex");
}


type ParsedEvent = Record<string, unknown> & { id: string; event: string };

function parseEvent(rawBody: unknown): ParsedEvent {
  if (
    typeof rawBody !== "string" ||
    Buffer.byteLength(rawBody, "utf8") > 65_536
  ) {
    reject(400, "WEBHOOK_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return reject(400, "WEBHOOK_INVALID");
  }
  const event = object(parsed);
  if (
    !event ||
    !reference(event.id) ||
    typeof event.event !== "string" ||
    event.event.length > 128 ||
    !/^[A-Z][A-Z0-9_]+$/.test(event.event)
  )
    reject(400, "WEBHOOK_INVALID");
  return event as ParsedEvent;
}

// Only correlation references are retained; consequential effects re-fetch the provider object.
function correlationPayload(event: ParsedEvent): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const [key, field] of [
    ["payment", "paymentId"],
    ["checkout", "checkoutId"],
    ["transfer", "transferId"],
    ["refund", "refundId"],
    ["accessToken", "accessTokenId"],
  ] as const) {
    const entry = object(event[key]);
    if (!entry) continue;
    if (!reference(entry.id)) reject(400, "WEBHOOK_INVALID");
    payload[field] = entry.id;
    if (
      entry.externalReference !== undefined &&
      entry.externalReference !== null
    ) {
      if (!reference(entry.externalReference, 200))
        reject(400, "WEBHOOK_INVALID");
      if (
        payload.externalReference &&
        payload.externalReference !== entry.externalReference
      ) {
        reject(400, "WEBHOOK_INVALID");
      }
      payload.externalReference = entry.externalReference;
    }
  }
  const payment = object(event.payment);
  if (
    event.event === "PAYMENT_DELETED" &&
    payment?.checkoutSession == null &&
    payment?.installment != null
  ) {
    if (!reference(payment.installment, 128)) reject(400, "WEBHOOK_INVALID");
    payload.installmentId = payment.installment;
  }
  return payload;
}

// Platform notifications name the payment of an anticipation, and the plan or
// checkout session of a payment; these are routing hints, not trusted state.
function platformReferences(
  event: ParsedEvent,
  payload: Record<string, string>,
): AsaasPlatformEventReferences {
  const anticipation = object(event.anticipation);
  if (anticipation && anticipation.payment != null) {
    if (!reference(anticipation.payment, 128)) reject(400, "WEBHOOK_INVALID");
    if (payload.paymentId && payload.paymentId !== anticipation.payment)
      reject(400, "WEBHOOK_INVALID");
    payload.paymentId = anticipation.payment;
  }
  const payment = object(event.payment);
  const providerReferences: string[] = [];
  for (const value of [
    payload.checkoutId,
    payment?.checkoutSession,
    payment?.installment,
    anticipation?.installment,
  ]) {
    if (value === undefined || value === null) continue;
    if (!reference(value, 128)) reject(400, "WEBHOOK_INVALID");
    if (!providerReferences.includes(value)) providerReferences.push(value);
  }
  return {
    ...(payload.externalReference === undefined
      ? {}
      : { externalReference: payload.externalReference }),
    ...(payload.paymentId === undefined ? {} : { paymentId: payload.paymentId }),
    providerReferences,
  };
}

export function createAsaasWebhookReceiver(
  dependencies: AsaasWebhookDependencies,
) {
  const mode = dependencies.mode;
  const environment = dependencies.applicationEnvironment;
  const liveDemoSiteId = dependencies.liveDemoSiteId;
  const platform = dependencies.platform;

  function admitsSite(siteId: string, isDemo: boolean): boolean {
    return (
      !isDemo ||
      mode !== "live" ||
      allowsLiveSite({
        siteId,
        isDemo,
        mode,
        applicationEnvironment: environment,
        liveDemoSiteId,
      })
    );
  }

  async function appendEvent(
    target: {
      siteId: string;
      accountId: string;
      environment: "sandbox" | "live";
      providerAccountReference: string;
    },
    event: ParsedEvent,
    payload: Record<string, string>,
  ): Promise<{ accepted: true }> {
    const now = dependencies.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
      reject(503, "WEBHOOK_UNAVAILABLE");
    const id = dependencies.generateId();
    if (!reference(id, 128)) reject(503, "WEBHOOK_UNAVAILABLE");
    const payloadHash = hashAsaasEventIdentity(
      event.id,
      event.event,
      target.providerAccountReference,
      payload,
    );
    const result = await dependencies.repository.append(
      Object.freeze({
        id,
        siteId: target.siteId,
        accountId: target.accountId,
        provider: "ASAAS",
        environment: target.environment,
        providerAccountReference: target.providerAccountReference,
        providerEventId: event.id,
        eventType: event.event,
        payload: Object.freeze(payload),
        payloadHash,
        receivedAt: now.toISOString(),
      }),
    );
    if (result !== "INSERTED" && result !== "DUPLICATE")
      reject(503, "WEBHOOK_UNAVAILABLE");
    return { accepted: true };
  }

  // Platform-account (V2) notifications are stored in the routed couple's
  // inbox scope and hashed with that couple's account reference, so every
  // downstream worker keeps its existing binding checks.
  async function receivePlatform(
    binding: AsaasPlatformWebhookBinding,
    rawBody: unknown,
  ): Promise<{ accepted: true }> {
    const event = parseEvent(rawBody);
    if (object(event.account)?.id !== binding.accountReference)
      reject(400, "WEBHOOK_INVALID");
    const payload = correlationPayload(event);
    const references = platformReferences(event, payload);
    const loaded = await binding.route(Object.freeze(references));
    const route = loaded && { ...loaded };
    if (
      !route ||
      route.environment !== mode ||
      !reference(route.siteId, 128) ||
      !reference(route.accountId, 128) ||
      !reference(route.providerAccountReference, 128) ||
      !reference(route.attemptId, 128) ||
      typeof route.isDemo !== "boolean" ||
      !admitsSite(route.siteId, route.isDemo) ||
      (references.externalReference !== undefined &&
        references.externalReference !== route.attemptId)
    ) {
      await binding.recordUnroutable(
        Object.freeze({
          environment: mode as "sandbox" | "live",
          providerEventId: event.id,
          eventType: event.event,
          paymentReference:
            references.paymentId ?? references.providerReferences[0] ?? event.id,
        }),
      );
      return { accepted: true };
    }
    payload.externalReference = route.attemptId;
    return appendEvent(route, event, payload);
  }

  return {
    async receive(
      token: unknown,
      rawBody: unknown,
    ): Promise<{ accepted: true }> {
      try {
        if (
          (mode !== "sandbox" && mode !== "live") ||
          !["development", "test", "production"].includes(environment) ||
          (environment === "production" && mode !== "live")
        ) {
          reject(503, "WEBHOOK_UNAVAILABLE");
        }
        if (
          typeof token !== "string" ||
          token.length < 32 ||
          token.length > 255 ||
          !/^[\x21-\x7e]+$/.test(token)
        )
          reject(401, "WEBHOOK_AUTH_DENIED");
        const tokenHash = createHash("sha256").update(token).digest("hex");
        if (platform && sameHash(tokenHash, platform.webhookTokenHash))
          return await receivePlatform(platform, rawBody);
        const loaded = await dependencies.resolveBinding(tokenHash);
        const binding = loaded && { ...loaded };
        if (
          binding?.provider !== "ASAAS" ||
          binding.environment !== mode ||
          !sameHash(tokenHash, binding.webhookTokenHash) ||
          !reference(binding.siteId, 128) ||
          !reference(binding.accountId, 128) ||
          !reference(binding.providerAccountReference, 128) ||
          typeof binding.isDemo !== "boolean" ||
          !admitsSite(binding.siteId, binding.isDemo)
        ) {
          reject(401, "WEBHOOK_AUTH_DENIED");
        }
        const event = parseEvent(rawBody);
        const account = object(event.account);
        if (
          event.account !== undefined &&
          account?.id !== binding.providerAccountReference
        )
          reject(400, "WEBHOOK_INVALID");
        return await appendEvent(binding, event, correlationPayload(event));
      } catch (error) {
        if (error instanceof AsaasWebhookError) throw error;
        return reject(503, "WEBHOOK_UNAVAILABLE");
      }
    },
  };
}
