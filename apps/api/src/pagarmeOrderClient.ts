import {
  createPagarmeHttpClient,
  type PagarmeHttpClient,
  type PagarmeHttpClientOptions,
  PagarmeUnknownOutcomeError,
} from "./pagarmeHttpClient";
import { pagarmeRecipientIdPattern } from "./pagarmeIds";
import type { PagarmeOrderRequest } from "./pagarmeOrderPayload";

export interface PagarmePixData {
  readonly qrCode: string;
  readonly qrCodeUrl: string;
  readonly expiresAt: string;
}

export interface PagarmeSplitObservation {
  readonly recipientId: string;
  readonly amountCents: number;
}

export interface PagarmeChargeObservation {
  readonly id: string;
  readonly code: string | null;
  /** Raw provider status (pending, paid, failed, canceled, refunded, chargedback, ...). */
  readonly status: string;
  readonly amountCents: number;
  readonly paidAmountCents: number | null;
  /** Amount cancelled or refunded on the charge, when reported. */
  readonly canceledAmountCents: number | null;
  /** Raw status of the last transaction (e.g. `refunded` on a cancelled card charge). */
  readonly transactionStatus: string | null;
  readonly paymentMethod: string;
  readonly installments: number | null;
  readonly pix: PagarmePixData | null;
  /** Split rules echoed by the last transaction, when present. */
  readonly split: readonly PagarmeSplitObservation[] | null;
}

export interface PagarmeOrderObservation {
  readonly id: string;
  readonly code: string;
  /** Raw provider status (pending, paid, canceled, failed). */
  readonly status: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly charges: readonly PagarmeChargeObservation[];
}

export interface PagarmeOrderClient {
  createOrder(request: PagarmeOrderRequest): Promise<PagarmeOrderObservation>;
  getOrder(orderId: string): Promise<PagarmeOrderObservation>;
  /** GET /orders?code=: recovers an order whose creation outcome is unknown. */
  findOrderByCode(code: string): Promise<PagarmeOrderObservation | null>;
  /** DELETE /charges/{id}: cancels or fully refunds a charge (operator only). */
  cancelCharge(
    chargeId: string,
    idempotencyKey: string,
  ): Promise<PagarmeChargeObservation>;
}

const orderId = /^or_[A-Za-z0-9]{1,128}$/;
const chargeId = /^ch_[A-Za-z0-9]{1,128}$/;
const recipientId = pagarmeRecipientIdPattern;
const code = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function malformed(): never {
  throw new PagarmeUnknownOutcomeError("invalid_response");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return malformed();
  return value as Record<string, unknown>;
}

function text(value: unknown, pattern?: RegExp): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 4096 ||
    (pattern && !pattern.test(value))
  )
    return malformed();
  return value;
}

function cents(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 2_147_483_647
  )
    return malformed();
  return value;
}

function instant(value: unknown): string {
  const parsed = Date.parse(text(value));
  if (!Number.isFinite(parsed)) return malformed();
  return new Date(parsed).toISOString();
}

function readPix(transaction: Record<string, unknown>): PagarmePixData | null {
  if (transaction.qr_code == null) return null;
  const url = text(transaction.qr_code_url);
  if (!url.startsWith("https://")) return malformed();
  return {
    qrCode: text(transaction.qr_code),
    qrCodeUrl: url,
    expiresAt: instant(transaction.expires_at),
  };
}

function readSplit(value: unknown): PagarmeSplitObservation[] | null {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length > 16) return malformed();
  return value.map((entry) => {
    const rule = record(entry);
    const recipient =
      rule.recipient && typeof rule.recipient === "object"
        ? record(rule.recipient).id
        : rule.recipient_id;
    return {
      recipientId: text(recipient, recipientId),
      amountCents: cents(rule.amount),
    };
  });
}

export function readPagarmeCharge(value: unknown): PagarmeChargeObservation {
  const charge = record(value);
  const transaction =
    charge.last_transaction == null ? {} : record(charge.last_transaction);
  const installments = transaction.installments;
  return {
    id: text(charge.id, chargeId),
    code: charge.code == null ? null : text(charge.code),
    status: text(charge.status, /^[a-z_]{1,64}$/),
    amountCents: cents(charge.amount),
    paidAmountCents:
      charge.paid_amount == null ? null : cents(charge.paid_amount),
    canceledAmountCents:
      charge.canceled_amount == null ? null : cents(charge.canceled_amount),
    transactionStatus:
      transaction.status == null
        ? null
        : text(transaction.status, /^[a-z_]{1,64}$/),
    paymentMethod: text(charge.payment_method, /^[a-z_]{1,64}$/),
    installments:
      installments == null
        ? null
        : Number.isSafeInteger(installments) &&
            (installments as number) >= 1 &&
            (installments as number) <= 24
          ? (installments as number)
          : malformed(),
    pix: readPix(transaction),
    split: readSplit(transaction.split),
  };
}

export function readPagarmeOrder(value: unknown): PagarmeOrderObservation {
  const order = record(value);
  if (!Array.isArray(order.charges) || order.charges.length > 16)
    return malformed();
  return {
    id: text(order.id, orderId),
    code: text(order.code, code),
    status: text(order.status, /^[a-z_]{1,64}$/),
    amountCents: cents(order.amount),
    currency: text(order.currency, /^[A-Z]{3}$/),
    charges: order.charges.map(readPagarmeCharge),
  };
}

function required(value: string, pattern: RegExp): string {
  if (!pattern.test(value)) throw new TypeError("Unsafe Pagar.me identifier");
  return value;
}

export function createPagarmeOrderClient(
  options: PagarmeHttpClientOptions & { http?: PagarmeHttpClient },
): PagarmeOrderClient {
  const http = options.http ?? createPagarmeHttpClient(options);
  return {
    async createOrder(request) {
      return readPagarmeOrder(
        await http.request("POST", "/orders", {
          body: request.body,
          idempotencyKey: request.idempotencyKey,
        }),
      );
    },
    async getOrder(id) {
      return readPagarmeOrder(
        await http.request("GET", `/orders/${required(id, orderId)}`),
      );
    },
    async findOrderByCode(value) {
      const page = record(
        await http.request(
          "GET",
          `/orders?code=${encodeURIComponent(required(value, code))}`,
        ),
      );
      if (!Array.isArray(page.data)) return malformed();
      const matches = page.data
        .map(readPagarmeOrder)
        .filter((order) => order.code === value);
      if (matches.length > 1) return malformed();
      return matches[0] ?? null;
    },
    async cancelCharge(id, idempotencyKey) {
      return readPagarmeCharge(
        await http.request("DELETE", `/charges/${required(id, chargeId)}`, {
          idempotencyKey,
        }),
      );
    },
  };
}
