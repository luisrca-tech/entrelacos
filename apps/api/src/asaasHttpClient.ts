import { parseBrlCents, serializeBrlCents } from "./giftMoney";
import type { GiftProviderPaymentObservation } from "./giftPaymentReconciliation";
import type { ProviderCredentialContext } from "./providerCredentials";

// Reconstruct these values from stored server bindings. A matching credential
// envelope does not prove ownership of the remote account or provider approval.
export interface AsaasHttpClientOptions {
  mode: "disabled" | "sandbox" | "live";
  binding: ProviderCredentialContext & { accountReference: string };
  credentials: { context: ProviderCredentialContext; accessToken: string };
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
  maxResponseBytes: number;
  now?: () => Date;
}

export interface AsaasBalanceObservation {
  source: "provider";
  provider: "ASAAS";
  siteId: string;
  accountBindingId: string;
  accountReference: string;
  environment: "sandbox" | "live";
  currency: "BRL";
  observedAt: Date;
  balanceCents: number;
}

export interface AsaasPaymentSplit {
  id: string;
  walletId: string;
  status: string;
  fixedValue?: string | null;
  percentualValue?: number | null;
  totalValue?: string | null;
}

// Monetary values are canonical BRL strings. Missing observations stay missing;
// normalizing the response never infers receipt, approval or a completed split.
export interface AsaasPaymentForReconciliation {
  id: string;
  checkoutSession: string;
  status: string;
  billingType: string;
  value: string;
  currency?: "BRL";
  externalReference?: string | null;
  netValue?: string | null;
  split?: AsaasPaymentSplit[] | null;
  deleted?: boolean | null;
  chargeback?: { status?: string } | null;
  refunds?: { status?: string; value?: string | null }[] | null;
  custody?: Record<string, never> | null;
}

export interface AsaasPaymentObservation
  extends GiftProviderPaymentObservation {
  payment: AsaasPaymentForReconciliation;
}

export interface AsaasHttpClient {
  getPayment(
    providerPaymentReference: string,
  ): Promise<AsaasPaymentObservation>;
  getBalance(): Promise<AsaasBalanceObservation>;
}

export class AsaasHttpClientServiceError extends Error {
  readonly code = "PROVIDER_HTTP_UNAVAILABLE";
  readonly status = 503;
  readonly title = "Provider response is unavailable";

  constructor() {
    super("Provider response is unavailable");
    this.name = "AsaasHttpClientServiceError";
  }
}

function unavailable(): never {
  throw new AsaasHttpClientServiceError();
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return unavailable();
  return value as Record<string, unknown>;
}

function exactRecord(value: unknown, keys: string[]): Record<string, unknown> {
  const object = record(value);
  const prototype = Object.getPrototypeOf(object);
  const ownKeys = Reflect.ownKeys(object);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return unavailable();
  return object;
}

function localId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  )
    return unavailable();
  return value;
}

function reference(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    return unavailable();
  return value;
}

function money(value: unknown): number {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    Object.is(value, -0) ||
    String(value).length > 32
  )
    return unavailable();
  return parseBrlCents(String(value));
}

// These enums are the documented GET /payments/{id} response vocabulary.
// A new provider status needs review before the adapter exposes it downstream.
const paymentStatuses = [
  "PENDING",
  "RECEIVED",
  "CONFIRMED",
  "OVERDUE",
  "REFUNDED",
  "RECEIVED_IN_CASH",
  "REFUND_REQUESTED",
  "REFUND_IN_PROGRESS",
  "CHARGEBACK_REQUESTED",
  "CHARGEBACK_DISPUTE",
  "AWAITING_CHARGEBACK_REVERSAL",
  "DUNNING_REQUESTED",
  "DUNNING_RECEIVED",
  "AWAITING_RISK_ANALYSIS",
];
const splitStatuses = [
  "PENDING",
  "PROCESSING",
  "PROCESSING_REFUND",
  "AWAITING_CREDIT",
  "CANCELLED",
  "DONE",
  "REFUNDED",
  "BLOCKED_BY_VALUE_DIVERGENCE",
];
const refundStatuses = [
  "PENDING",
  "AWAITING_CRITICAL_ACTION_AUTHORIZATION",
  "AWAITING_CUSTOMER_EXTERNAL_AUTHORIZATION",
  "CANCELLED",
  "DONE",
];
const chargebackStatuses = [
  "REQUESTED",
  "IN_DISPUTE",
  "DISPUTE_LOST",
  "REVERSED",
  "DONE",
];
const billingTypes = [
  "UNDEFINED",
  "BOLETO",
  "CREDIT_CARD",
  "DEBIT_CARD",
  "TRANSFER",
  "DEPOSIT",
  "PIX",
];

function status(value: unknown, allowed: readonly string[]): string {
  if (typeof value !== "string" || !allowed.includes(value))
    return unavailable();
  return value;
}

function optionalMoney(value: unknown): string | null {
  return value === null ? null : serializeBrlCents(money(value));
}

function normalizeSplit(value: unknown): AsaasPaymentSplit {
  const raw = record(value);
  const split: AsaasPaymentSplit = {
    id: reference(raw.id),
    walletId: reference(raw.walletId),
    status: status(raw.status, splitStatuses),
  };
  if (raw.fixedValue !== undefined)
    split.fixedValue = optionalMoney(raw.fixedValue);
  // totalValue is the separately observed allocation, never a fixedValue fallback.
  if (raw.totalValue !== undefined)
    split.totalValue = optionalMoney(raw.totalValue);
  if (raw.percentualValue !== undefined) {
    if (
      raw.percentualValue !== null &&
      (typeof raw.percentualValue !== "number" ||
        !Number.isFinite(raw.percentualValue) ||
        raw.percentualValue < 0 ||
        raw.percentualValue > 100 ||
        Object.is(raw.percentualValue, -0))
    )
      return unavailable();
    split.percentualValue = raw.percentualValue;
  }
  return split;
}

function boundedArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 256) return unavailable();
  return value;
}

function normalizePayment(
  raw: Record<string, unknown>,
  requested: string,
): AsaasPaymentForReconciliation {
  const id = reference(raw.id);
  const gross = money(raw.value);
  if (
    id !== requested ||
    gross === 0 ||
    (raw.currency !== undefined && raw.currency !== "BRL")
  )
    return unavailable();
  const payment: AsaasPaymentForReconciliation = {
    id,
    checkoutSession: reference(raw.checkoutSession),
    status: status(raw.status, paymentStatuses),
    billingType: status(raw.billingType, billingTypes),
    value: serializeBrlCents(gross),
  };
  if (raw.currency !== undefined) payment.currency = "BRL";
  if (raw.externalReference !== undefined)
    payment.externalReference =
      raw.externalReference === null ? null : localId(raw.externalReference);
  if (raw.netValue !== undefined) {
    if (raw.netValue !== null && money(raw.netValue) > gross)
      return unavailable();
    payment.netValue = optionalMoney(raw.netValue);
  }
  if (raw.split !== undefined)
    payment.split =
      raw.split === null ? null : boundedArray(raw.split).map(normalizeSplit);
  if (raw.deleted !== undefined) {
    if (raw.deleted !== null && typeof raw.deleted !== "boolean")
      return unavailable();
    payment.deleted = raw.deleted;
  }
  if (raw.chargeback !== undefined) {
    const chargeback = raw.chargeback === null ? null : record(raw.chargeback);
    payment.chargeback =
      chargeback === null
        ? null
        : chargeback.status === undefined
          ? {}
          : { status: status(chargeback.status, chargebackStatuses) };
  }
  if (raw.refunds !== undefined)
    payment.refunds =
      raw.refunds === null
        ? null
        : boundedArray(raw.refunds).map((value) => {
            const refund = record(value);
            return {
              ...(refund.status === undefined
                ? {}
                : { status: status(refund.status, refundStatuses) }),
              ...(refund.value === undefined
                ? {}
                : { value: optionalMoney(refund.value) }),
            };
          });
  // Only existence of a custody restriction matters to reconciliation.
  if (raw.custody !== undefined) {
    if (raw.custody !== null) record(raw.custody);
    payment.custody = raw.custody === null ? null : {};
  }
  return payment;
}

export function createAsaasHttpClient(
  options: AsaasHttpClientOptions,
): AsaasHttpClient {
  try {
    const contextFields = [
      "provider",
      "siteId",
      "accountBindingId",
      "environment",
    ];
    const suppliedBinding = exactRecord(options.binding, [
      ...contextFields,
      "accountReference",
    ]);
    const context = exactRecord(options.credentials.context, contextFields);
    const accessToken = options.credentials.accessToken;
    const mode = options.mode;
    const fetch = options.fetch;
    const timeoutMs = options.timeoutMs;
    const maxResponseBytes = options.maxResponseBytes;
    const clock = options.now ?? (() => new Date());
    const keyPrefix = mode === "sandbox" ? "$aact_hmlg_" : "$aact_prod_";
    if (
      (mode !== "sandbox" && mode !== "live") ||
      suppliedBinding.provider !== "ASAAS" ||
      suppliedBinding.environment !== mode ||
      contextFields.some((key) => context[key] !== suppliedBinding[key]) ||
      typeof fetch !== "function" ||
      typeof clock !== "function" ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 30_000 ||
      !Number.isSafeInteger(maxResponseBytes) ||
      maxResponseBytes < 1 ||
      maxResponseBytes > 1_048_576 ||
      typeof accessToken !== "string" ||
      accessToken.length > 8192 ||
      accessToken.length <= keyPrefix.length ||
      !/^[\x21-\x7e]+$/.test(accessToken) ||
      !accessToken.startsWith(keyPrefix)
    )
      return unavailable();
    const binding = {
      provider: "ASAAS" as const,
      siteId: localId(suppliedBinding.siteId),
      accountBindingId: localId(suppliedBinding.accountBindingId),
      environment: mode,
      accountReference: reference(suppliedBinding.accountReference),
    };
    const base =
      mode === "sandbox"
        ? "https://api-sandbox.asaas.com/v3"
        : "https://api.asaas.com/v3";

    async function request(path: string): Promise<Record<string, unknown>> {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let body: ReadableStream<Uint8Array> | null | undefined;
      let cancelled = false;
      let endOfBody = false;
      let cancellation: Promise<unknown> | undefined;
      const startedAt = performance.now();
      const cancel = () => {
        if (cancelled || endOfBody || !body) return;
        cancelled = true;
        try {
          // Observe rejection immediately, but only fulfilled cancellation
          // proves cleanup. Failed cleanup retains ownership indefinitely.
          // Native then checks Promise internal slots without invoking a
          // forged thenable's method; invalid cancellation stays uncertain.
          cancellation = Promise.prototype.then.call(
            reader ? reader.cancel() : body.cancel(),
            () => undefined,
            () => new Promise<void>(() => {}),
          );
        } catch {
          cancellation = new Promise<void>(() => {});
        }
      };
      const assertDeadline = () => {
        // A busy event loop can complete promise microtasks before the timeout
        // callback. Bound actual elapsed time as well as the abort signal.
        const elapsed = performance.now() - startedAt;
        if (
          controller.signal.aborted ||
          !Number.isFinite(elapsed) ||
          elapsed < 0 ||
          elapsed >= timeoutMs
        ) {
          controller.abort();
          cancel();
          return unavailable();
        }
      };
      try {
        // The deadline requests abort; it cannot certify transport completion.
        // Await the actual fetch and every started read, even if abort is ignored.
        timer = setTimeout(() => {
          controller.abort();
          cancel();
        }, timeoutMs);
        const url = base + path;
        const response = await fetch(url, {
          method: "GET",
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
          headers: {
            access_token: accessToken,
            "User-Agent": "EntreLacos-API",
            Accept: "application/json",
          },
          signal: controller.signal,
        });
        body = response.body;
        assertDeadline();
        if (
          response.status !== 200 ||
          response.redirected ||
          (response.url && response.url !== url) ||
          !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?\s*$/i.test(
            response.headers.get("content-type") ?? "",
          ) ||
          !body
        )
          return unavailable();
        const length = response.headers.get("content-length");
        if (
          length !== null &&
          (!/^\d+$/.test(length) ||
            !Number.isSafeInteger(Number(length)) ||
            Number(length) > maxResponseBytes)
        )
          return unavailable();
        reader = body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let text = "";
        let bytes = 0;
        for (let chunks = 0; ; chunks++) {
          assertDeadline();
          if (chunks >= 4096) return unavailable();
          const chunk = await reader.read();
          if (chunk.done) endOfBody = true;
          assertDeadline();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > maxResponseBytes) return unavailable();
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
        const result = record(JSON.parse(text));
        assertDeadline();
        return result;
      } catch {
        return unavailable();
      } finally {
        if (!endOfBody) cancel();
        try {
          if (cancellation) await cancellation;
          reader?.releaseLock();
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
    }

    function observedAt(): Date {
      const time = clock();
      if (!(time instanceof Date) || !Number.isFinite(time.getTime()))
        return unavailable();
      return new Date(time);
    }

    return {
      async getBalance(): Promise<AsaasBalanceObservation> {
        try {
          // The response has no provider as-of timestamp. Keep the earliest
          // observation bound so a concurrent completed debit invalidates it.
          const startedAt = observedAt();
          const response = await request("/finance/balance");
          if (observedAt().getTime() < startedAt.getTime())
            return unavailable();
          return {
            source: "provider",
            ...binding,
            currency: "BRL",
            observedAt: startedAt,
            balanceCents: money(response.balance),
          };
        } catch {
          return unavailable();
        }
      },
      async getPayment(
        providerPaymentReference: string,
      ): Promise<AsaasPaymentObservation> {
        try {
          const requested = reference(providerPaymentReference);
          const response = await request(
            `/payments/${encodeURIComponent(requested)}`,
          );
          return {
            source: "provider",
            provider: binding.provider,
            siteId: binding.siteId,
            accountReference: binding.accountReference,
            environment: binding.environment,
            currency: "BRL",
            observedAt: observedAt(),
            payment: normalizePayment(response, requested),
          };
        } catch {
          return unavailable();
        }
      },
    };
  } catch {
    return unavailable();
  }
}
