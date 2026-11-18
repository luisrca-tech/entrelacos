import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Pagar.me webhook types we act on, normalized to the inbox event types.
 * `chargeback.received` replaces the discontinued `charge.chargedback`
 * (migration deadline 2026-09-30 in the webhook event reference); the legacy
 * spellings stay accepted. `charge.partial_canceled` is read as a refund
 * event: the re-read order decides (a partial reversal goes to an operator).
 */
export const pagarmeWebhookEventTypes = Object.freeze({
  "order.paid": "ORDER_PAID",
  "order.payment_failed": "ORDER_PAYMENT_FAILED",
  "order.canceled": "ORDER_CANCELED",
  "charge.paid": "CHARGE_PAID",
  "charge.refunded": "CHARGE_REFUNDED",
  "charge.partial_canceled": "CHARGE_REFUNDED",
  "charge.chargedback": "CHARGE_CHARGEDBACK",
  "charge.chargeback": "CHARGE_CHARGEDBACK",
  "chargeback.received": "CHARGE_CHARGEDBACK",
  "recipient.updated": "RECIPIENT_UPDATED",
} as const);

export type PagarmeInboxEventType =
  | (typeof pagarmeWebhookEventTypes)[keyof typeof pagarmeWebhookEventTypes]
  /** Internal: the reconciliation sweep asks the worker to re-read an order. */
  | "ORDER_RECONCILE";

export interface PagarmeWebhookEvent {
  readonly eventId: string;
  readonly providerType: keyof typeof pagarmeWebhookEventTypes;
  readonly eventType: PagarmeInboxEventType;
  readonly orderId: string | null;
  readonly orderCode: string | null;
  readonly chargeId: string | null;
  readonly recipientId: string | null;
}

export type PagarmeWebhookAppendResult =
  | "INSERTED"
  | "DUPLICATE"
  | "UNROUTABLE";

export interface PagarmeWebhookRepository {
  /** Routes the event to its site/account and stores it once per event id. */
  append(
    event: PagarmeWebhookEvent,
    authenticatedAt: Date,
  ): Promise<PagarmeWebhookAppendResult>;
}

export class PagarmeWebhookError extends Error {
  constructor(
    readonly status: 400 | 401 | 503,
    readonly code:
      | "WEBHOOK_INVALID"
      | "WEBHOOK_AUTH_DENIED"
      | "WEBHOOK_UNAVAILABLE",
  ) {
    super("Pagar.me webhook rejected");
    this.name = "PagarmeWebhookError";
  }
}

const eventIdPattern = /^hook_[A-Za-z0-9]{1,128}$/;
const orderIdPattern = /^or_[A-Za-z0-9]{1,128}$/;
const chargeIdPattern = /^ch_[A-Za-z0-9]{1,128}$/;
const recipientIdPattern = /^rp_[A-Za-z0-9]{1,128}$/;
const codePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Checks `Authorization: Basic base64(user:password)` against the stored
 * sha256 of `user:password`. Both sides are fixed-length digests compared with
 * timingSafeEqual, so the comparison time does not depend on the secret.
 */
export function verifyPagarmeWebhookAuthorization(
  header: string | undefined,
  credentialsHash: string,
): boolean {
  const expected = /^[a-f0-9]{64}$/.test(credentialsHash)
    ? Buffer.from(credentialsHash, "hex")
    : Buffer.alloc(32, 0xff);
  let decoded = "";
  const match =
    typeof header === "string" && header.length <= 1024
      ? /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(header)
      : null;
  if (match) {
    const value = Buffer.from(match[1], "base64");
    if (value.toString("base64") === match[1]) decoded = value.toString("utf8");
  }
  const received = sha256(decoded);
  const equal = timingSafeEqual(received, expected);
  return (
    equal &&
    match !== null &&
    decoded.includes(":") &&
    !decoded.endsWith(":") &&
    /^[a-f0-9]{64}$/.test(credentialsHash)
  );
}

function invalid(): never {
  throw new PagarmeWebhookError(400, "WEBHOOK_INVALID");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
}

function optional(value: unknown, pattern: RegExp): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !pattern.test(value)) return invalid();
  return value;
}

function required(value: unknown, pattern: RegExp): string {
  return optional(value, pattern) ?? invalid();
}

/**
 * Keeps only correlation references from the body. Money and status are
 * never trusted from here: the worker re-reads the resource from the API.
 * Returns null for event types we do not handle.
 */
export function parsePagarmeWebhookEvent(
  rawBody: unknown,
): PagarmeWebhookEvent | null {
  if (typeof rawBody !== "string" || Buffer.byteLength(rawBody) > 65_536)
    return invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return invalid();
  }
  const body = object(parsed);
  const eventId = required(body.id, eventIdPattern);
  if (typeof body.type !== "string" || body.type.length > 128) return invalid();
  if (!Object.hasOwn(pagarmeWebhookEventTypes, body.type)) return null;
  const providerType = body.type as keyof typeof pagarmeWebhookEventTypes;
  const eventType = pagarmeWebhookEventTypes[providerType];
  const data = object(body.data);
  if (providerType === "recipient.updated")
    return {
      eventId,
      providerType,
      eventType,
      orderId: null,
      orderCode: null,
      chargeId: null,
      recipientId: required(data.id, recipientIdPattern),
    };
  if (providerType.startsWith("order.")) {
    const charges = Array.isArray(data.charges) ? data.charges : [];
    const first = charges.length === 1 ? object(charges[0]) : null;
    return {
      eventId,
      providerType,
      eventType,
      orderId: required(data.id, orderIdPattern),
      orderCode: optional(data.code, codePattern),
      chargeId: first ? optional(first.id, chargeIdPattern) : null,
      recipientId: null,
    };
  }
  if (providerType === "chargeback.received") {
    // The event carries a dispute, not a charge. The documented dispute
    // object references the charge as `chargeId`; snake_case and nested
    // shapes are accepted too. The worker re-reads the order by charge.
    const charge =
      data.charge && typeof data.charge === "object" ? object(data.charge) : {};
    const chargeRef =
      data.chargeId ??
      data.charge_id ??
      charge.id ??
      (typeof data.id === "string" && data.id.startsWith("ch_")
        ? data.id
        : undefined);
    const nested = data.order ?? charge.order;
    const order =
      nested && typeof nested === "object" ? object(nested) : undefined;
    return {
      eventId,
      providerType,
      eventType,
      orderId: optional(
        order?.id ?? data.orderId ?? data.order_id ?? charge.order_id,
        orderIdPattern,
      ),
      orderCode: optional(order?.code, codePattern),
      chargeId: required(chargeRef, chargeIdPattern),
      recipientId: null,
    };
  }
  const order = data.order === undefined ? null : object(data.order);
  return {
    eventId,
    providerType,
    eventType,
    orderId: required(order?.id, orderIdPattern),
    orderCode: optional(order?.code, codePattern),
    chargeId: required(data.id, chargeIdPattern),
    recipientId: null,
  };
}

/** Stable identity of a normalized inbox event, stored as its payload hash. */
export function hashFinancialEventIdentity(
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

export interface PagarmeWebhookReceiverOptions {
  webhookCredentialsHash: string;
  repository: PagarmeWebhookRepository;
  now(): Date;
  onInserted?(): void;
}

export function createPagarmeWebhookReceiver(
  options: PagarmeWebhookReceiverOptions,
) {
  return {
    async receive(
      authorization: string | undefined,
      rawBody: unknown,
    ): Promise<{ accepted: true }> {
      if (
        !verifyPagarmeWebhookAuthorization(
          authorization,
          options.webhookCredentialsHash,
        )
      )
        throw new PagarmeWebhookError(401, "WEBHOOK_AUTH_DENIED");
      const event = parsePagarmeWebhookEvent(rawBody);
      if (event === null) return { accepted: true };
      let result: PagarmeWebhookAppendResult;
      try {
        result = await options.repository.append(event, options.now());
      } catch {
        throw new PagarmeWebhookError(503, "WEBHOOK_UNAVAILABLE");
      }
      if (result === "INSERTED") {
        try {
          options.onInserted?.();
        } catch {
          // The scheduled sweep still finds the stored event.
        }
      }
      return { accepted: true };
    },
  };
}

export type PagarmeWebhookReceiver = ReturnType<
  typeof createPagarmeWebhookReceiver
>;
