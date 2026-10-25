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

export interface AsaasAccountFees {
  payment?: {
    creditCard?: {
      operationValue?: string | null;
      oneInstallmentPercentage?: string | null;
      discountOneInstallmentPercentage?: string | null;
      discountExpiration?: string | null;
      hasValidDiscount?: boolean | null;
    } | null;
    pix?: {
      type?: string | null;
      fixedFeeValue?: string | null;
      fixedFeeValueWithDiscount?: string | null;
      percentageFee?: string | null;
      minimumFeeValue?: string | null;
      maximumFeeValue?: string | null;
      discountExpiration?: string | null;
      monthlyCreditsWithoutFee?: number | null;
      creditsReceivedOfCurrentMonth?: number | null;
    } | null;
  } | null;
  transfer?: {
    monthlyTransfersWithoutFee?: number | null;
    ted?: {
      feeValue?: string | null;
      consideredInMonthlyTransfersWithoutFee?: boolean | null;
    } | null;
    pix?: {
      feeValue?: string | null;
      discountValue?: string | null;
      expirationDate?: string | null;
      consideredInMonthlyTransfersWithoutFee?: boolean | null;
    } | null;
  } | null;
}

// Decimal strings came from original numeric tokens, never rounded Number values.
// A fee read supplies no commercial interpretation or future validity guarantee.
export interface AsaasAccountFeesObservation {
  source: "provider";
  provider: "ASAAS";
  siteId: string;
  accountBindingId: string;
  accountReference: string;
  environment: "sandbox" | "live";
  currency: "BRL";
  observedAt: Date;
  completedAt: Date;
  fees: AsaasAccountFees;
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

export interface AsaasPixTransferCommand {
  valueCents: number;
  pixAddressKey: string;
  pixAddressKeyType: "CPF" | "CNPJ" | "EMAIL" | "PHONE" | "EVP";
  externalReference: string;
}
export interface AsaasTransferBankAccount {
  bank: { ispb: string };
  ownerName: string;
  cpfCnpj: string;
  agency: string;
  account: string;
  accountDigit: string | null;
  pixAddressKey: string | null;
  agencyDigit?: string | null;
  type?: string | null;
}
export interface AsaasTransfer {
  id: string;
  status: "PENDING" | "BANK_PROCESSING" | "DONE" | "CANCELLED" | "FAILED";
  type: string;
  operationType: "PIX" | "TED" | null;
  value: string;
  netValue: string | null;
  transferFee: string | null;
  externalReference: string | null;
  transactionReceiptUrl: string | null;
  endToEndIdentifier: string | null;
  effectiveDate: string | null;
  bankAccount?: AsaasTransferBankAccount;
}
export interface AsaasTransferObservation {
  source: "provider";
  provider: "ASAAS";
  siteId: string;
  accountBindingId: string;
  accountReference: string;
  environment: "sandbox" | "live";
  observedAt: Date;
  transfer: AsaasTransfer;
}
export interface AsaasTransfersObservation
  extends Omit<AsaasTransferObservation, "transfer"> {
  offset: number;
  totalCount: number;
  hasMore: boolean;
  transfers: AsaasTransfer[];
}

export interface AsaasHttpClient {
  // A failed POST may have succeeded remotely. These methods never retry.
  createPixTransfer(
    command: AsaasPixTransferCommand,
  ): Promise<AsaasTransferObservation>;
  getTransfer(providerReference: string): Promise<AsaasTransferObservation>;
  listTransfers(offset: number): Promise<AsaasTransfersObservation>;
  listCheckoutPayments(
    checkoutReference: string,
  ): Promise<AsaasCheckoutPaymentsObservation>;
  getPayment(
    providerPaymentReference: string,
  ): Promise<AsaasPaymentObservation>;
  getBalance(): Promise<AsaasBalanceObservation>;
  getAccountFees(): Promise<AsaasAccountFeesObservation>;
}

export interface AsaasCheckoutPaymentsObservation {
  source: "provider";
  provider: "ASAAS";
  siteId: string;
  accountBindingId: string;
  accountReference: string;
  environment: "sandbox" | "live";
  checkoutReference: string;
  observedAt: Date;
  payments: Array<{
    id: string;
    checkoutSession: string;
    status: string;
    externalReference?: string | null;
  }>;
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

// Capture the trusted platform at module load. Only the fee branch uses these
// intrinsics; legacy payment/balance transport and its fixtures remain unchanged.
const feeBody = Object.getOwnPropertyDescriptor(
  Response.prototype,
  "body",
)?.get;
const feeStatus = Object.getOwnPropertyDescriptor(
  Response.prototype,
  "status",
)?.get;
const feeRedirected = Object.getOwnPropertyDescriptor(
  Response.prototype,
  "redirected",
)?.get;
const feeUrl = Object.getOwnPropertyDescriptor(Response.prototype, "url")?.get;
const feeHeaders = Object.getOwnPropertyDescriptor(
  Response.prototype,
  "headers",
)?.get;
const feeHeaderGet = Headers.prototype.get;
const feeGetReader = ReadableStream.prototype.getReader;
const feeBodyCancel = ReadableStream.prototype.cancel;
const feeRead = ReadableStreamDefaultReader.prototype.read;
const feeReaderCancel = ReadableStreamDefaultReader.prototype.cancel;
const feeRelease = ReadableStreamDefaultReader.prototype.releaseLock;
const feeThen = Promise.prototype.then;
const feeByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)?.get;

function decodeAccountFees(text: string): AsaasAccountFees {
  const numericTokens = new WeakSet<object>();
  const parse = JSON.parse as (
    text: string,
    reviver: (
      key: string,
      value: unknown,
      context: { source?: string },
    ) => unknown,
  ) => unknown;
  const revive = (
    _key: string,
    value: unknown,
    context: { source?: string },
  ) => {
    if (typeof value !== "number") return value;
    const lexeme = context?.source;
    if (typeof lexeme !== "string" || lexeme.length > 32) return unavailable();
    const token = { lexeme };
    numericTokens.add(token);
    return token;
  };
  // Even a body with no numbers must not hide an unsupported runtime capability.
  const capability = parse("0", revive);
  if (
    !capability ||
    typeof capability !== "object" ||
    !numericTokens.has(capability)
  )
    return unavailable();
  const raw = record(parse(text, revive));
  function token(value: unknown): string {
    if (!value || typeof value !== "object" || !numericTokens.has(value))
      return unavailable();
    return (value as { lexeme: string }).lexeme;
  }
  function decimal(value: unknown, percentage = false): string {
    const lexeme = token(value);
    // Bound precision before the existing parser constructs any BigInt.
    if (!/^(0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(lexeme)) return unavailable();
    const cents = parseBrlCents(lexeme);
    if (percentage && cents >= 10_000) return unavailable();
    return serializeBrlCents(cents);
  }
  function count(value: unknown): number {
    const lexeme = token(value);
    if (!/^(0|[1-9]\d{0,9})$/.test(lexeme)) return unavailable();
    const result = Number(lexeme);
    if (result > 2_147_483_647) return unavailable();
    return result;
  }
  function fields(
    value: unknown,
    amounts: string[],
    percentages: string[] = [],
    counts: string[] = [],
    flags: string[] = [],
    dates: string[] = [],
  ) {
    if (value === null) return null;
    const object = record(value);
    const result: Record<string, string | number | boolean | null> = {};
    for (const key of [
      ...amounts,
      ...percentages,
      ...counts,
      ...flags,
      ...dates,
    ]) {
      if (!Object.hasOwn(object, key)) continue;
      const value = object[key];
      if (value === null) result[key] = null;
      else if (amounts.includes(key) || percentages.includes(key))
        result[key] = decimal(value, percentages.includes(key));
      else if (counts.includes(key)) result[key] = count(value);
      else if (flags.includes(key)) {
        if (typeof value !== "boolean") return unavailable();
        result[key] = value;
      } else {
        if (
          typeof value !== "string" ||
          value.length === 0 ||
          value.length > 64
        )
          return unavailable();
        result[key] = value;
      }
    }
    return result;
  }
  const fees: AsaasAccountFees = {};
  if (Object.hasOwn(raw, "payment")) {
    if (raw.payment === null) fees.payment = null;
    else {
      const payment = record(raw.payment);
      fees.payment = {};
      if (Object.hasOwn(payment, "creditCard"))
        fees.payment.creditCard = fields(
          payment.creditCard,
          ["operationValue"],
          ["oneInstallmentPercentage", "discountOneInstallmentPercentage"],
          [],
          ["hasValidDiscount"],
          ["discountExpiration"],
        );
      if (Object.hasOwn(payment, "pix"))
        fees.payment.pix = fields(
          payment.pix,
          [
            "fixedFeeValue",
            "fixedFeeValueWithDiscount",
            "minimumFeeValue",
            "maximumFeeValue",
          ],
          ["percentageFee"],
          ["monthlyCreditsWithoutFee", "creditsReceivedOfCurrentMonth"],
          [],
          ["discountExpiration", "type"],
        );
    }
  }
  if (Object.hasOwn(raw, "transfer")) {
    if (raw.transfer === null) fees.transfer = null;
    else {
      const transfer = record(raw.transfer);
      fees.transfer = fields(
        transfer,
        [],
        [],
        ["monthlyTransfersWithoutFee"],
      ) as AsaasAccountFees["transfer"];
      if (!fees.transfer) return unavailable();
      if (Object.hasOwn(transfer, "ted"))
        fees.transfer.ted = fields(
          transfer.ted,
          ["feeValue"],
          [],
          [],
          ["consideredInMonthlyTransfersWithoutFee"],
        );
      if (Object.hasOwn(transfer, "pix"))
        fees.transfer.pix = fields(
          transfer.pix,
          ["feeValue", "discountValue"],
          [],
          [],
          ["consideredInMonthlyTransfersWithoutFee"],
          ["expirationDate"],
        );
    }
  }
  return fees;
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

// Native transfer amounts are read from original JSON tokens, before Number rounding.
function decodeTransfers(text: string): unknown {
  return (
    JSON.parse as (
      text: string,
      revive: (
        key: string,
        value: unknown,
        context: { source?: string },
      ) => unknown,
    ) => unknown
  )(text, (key, value, context) => {
    if (!["value", "netValue", "transferFee"].includes(key) || value === null)
      return value;
    if (typeof value !== "number" || typeof context?.source !== "string")
      return unavailable();
    return serializeBrlCents(parseBrlCents(context.source));
  });
}
// Native effective dates have no timezone; validate without converting the provider value.
export function readAsaasTransferEffectiveDate(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return unavailable();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?$/.exec(
    value,
  );
  if (!match || match[0] !== value) return unavailable();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1] ||
    (match[4] !== undefined &&
      (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59))
  )
    return unavailable();
  return value;
}
// Preserve exact native routing strings; authorization compares the complete snapshot.
export function readAsaasTransferBankAccount(
  value: unknown,
): AsaasTransferBankAccount {
  const raw = record(value);
  const bank = record(raw.bank);
  function text(value: unknown, max = 256): string {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > max ||
      [...value].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      unavailable();
    return value;
  }
  const ispb = text(bank.ispb, 8);
  if (!/^\d{8}$/.test(ispb)) unavailable();
  return {
    bank: { ispb },
    ownerName: text(raw.ownerName),
    cpfCnpj: text(raw.cpfCnpj, 32),
    agency: text(raw.agency, 32),
    account: text(raw.account, 32),
    accountDigit: raw.accountDigit === null ? null : text(raw.accountDigit, 8),
    pixAddressKey: raw.pixAddressKey === null ? null : text(raw.pixAddressKey),
    ...(raw.agencyDigit === undefined
      ? {}
      : {
          agencyDigit:
            raw.agencyDigit === null ? null : text(raw.agencyDigit, 8),
        }),
    ...(raw.type === undefined
      ? {}
      : { type: raw.type === null ? null : text(raw.type, 32) }),
  };
}

function normalizeTransfer(value: unknown): AsaasTransfer {
  const raw = record(value);
  const optional = (key: string): string | null => {
    const value = raw[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || !/^[\x21-\x7e]{1,2048}$/.test(value))
      return unavailable();
    return value;
  };
  const amount = (key: string): string | null =>
    raw[key] === undefined || raw[key] === null
      ? null
      : serializeBrlCents(parseBrlCents(String(raw[key])));
  const transferValue = amount("value");
  if (
    transferValue === null ||
    !["PENDING", "BANK_PROCESSING", "DONE", "CANCELLED", "FAILED"].includes(
      String(raw.status),
    ) ||
    !["PIX", "TED", "INTERNAL", "BANK_ACCOUNT", "ASAAS_ACCOUNT"].includes(
      String(raw.type),
    ) ||
    (raw.operationType !== undefined &&
      raw.operationType !== null &&
      !["PIX", "TED"].includes(String(raw.operationType)))
  )
    return unavailable();
  return {
    id: reference(raw.id),
    status: raw.status as AsaasTransfer["status"],
    type: raw.type as string,
    operationType: (raw.operationType ??
      null) as AsaasTransfer["operationType"],
    value: transferValue,
    netValue: amount("netValue"),
    transferFee: amount("transferFee"),
    externalReference: optional("externalReference"),
    transactionReceiptUrl: optional("transactionReceiptUrl"),
    endToEndIdentifier: optional("endToEndIdentifier"),
    effectiveDate: readAsaasTransferEffectiveDate(raw.effectiveDate),
    ...(raw.bankAccount === undefined || raw.bankAccount === null
      ? {}
      : { bankAccount: readAsaasTransferBankAccount(raw.bankAccount) }),
  };
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

    async function request(
      path: string,
      payload?: string,
      decode: (text: string) => unknown = JSON.parse,
    ): Promise<Record<string, unknown>> {
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
          method: payload === undefined ? "GET" : "POST",
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
          headers: {
            access_token: accessToken,
            "User-Agent": "EntreLacos-API",
            Accept: "application/json",
            ...(payload === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(payload === undefined ? {} : { body: payload }),
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
        const result = record(decode(text));
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

    async function requestAccountFees(): Promise<AsaasAccountFees> {
      if (
        !feeBody ||
        !feeStatus ||
        !feeRedirected ||
        !feeUrl ||
        !feeHeaders ||
        !feeByteLength
      )
        return unavailable();
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let body: ReadableStream<Uint8Array> | null = null;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let endOfBody = false;
      let cancelled = false;
      let cancellation: Promise<unknown> | undefined;
      const startedAt = performance.now();
      const cancel = () => {
        if (cancelled || endOfBody || !body) return;
        cancelled = true;
        try {
          cancellation = feeThen.call(
            reader ? feeReaderCancel.call(reader) : feeBodyCancel.call(body),
            () => undefined,
            () => new Promise<void>(() => {}),
          );
        } catch {
          cancellation = new Promise<void>(() => {});
        }
      };
      const abort = () => {
        if (!controller.signal.aborted) controller.abort();
        cancel();
      };
      const assertDeadline = () => {
        const elapsed = performance.now() - startedAt;
        if (
          controller.signal.aborted ||
          !Number.isFinite(elapsed) ||
          elapsed < 0 ||
          elapsed >= timeoutMs
        ) {
          abort();
          return unavailable();
        }
      };
      try {
        timer = setTimeout(abort, timeoutMs);
        const url = `${base}/myAccount/fees/`;
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
        body = feeBody.call(response) as ReadableStream<Uint8Array> | null;
        assertDeadline();
        const headers = feeHeaders.call(response) as Headers;
        const responseUrl = feeUrl.call(response) as string;
        if (
          feeStatus.call(response) !== 200 ||
          feeRedirected.call(response) ||
          (responseUrl && responseUrl !== url) ||
          !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?\s*$/i.test(
            feeHeaderGet.call(headers, "content-type") ?? "",
          ) ||
          !body
        )
          return unavailable();
        const length = feeHeaderGet.call(headers, "content-length");
        if (
          length !== null &&
          (!/^\d+$/.test(length) ||
            !Number.isSafeInteger(Number(length)) ||
            Number(length) > maxResponseBytes)
        )
          return unavailable();
        reader = feeGetReader.call(
          body,
        ) as ReadableStreamDefaultReader<Uint8Array>;
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let text = "";
        let bytes = 0;
        for (let chunks = 0; ; chunks++) {
          assertDeadline();
          if (chunks >= 4096) return unavailable();
          const chunk = await feeRead.call(reader);
          if (chunk.done) endOfBody = true;
          assertDeadline();
          if (chunk.done) break;
          if (!(chunk.value instanceof Uint8Array)) return unavailable();
          bytes += feeByteLength.call(chunk.value) as number;
          if (bytes > maxResponseBytes) return unavailable();
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
        const result = decodeAccountFees(text);
        assertDeadline();
        return result;
      } catch {
        return unavailable();
      } finally {
        if (!endOfBody) cancel();
        try {
          if (cancellation) await cancellation;
          if (reader) feeRelease.call(reader);
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
      async createPixTransfer(command) {
        try {
          const raw = exactRecord(command, [
            "valueCents",
            "pixAddressKey",
            "pixAddressKeyType",
            "externalReference",
          ]);
          if (
            !Number.isSafeInteger(raw.valueCents) ||
            (raw.valueCents as number) < 1 ||
            typeof raw.pixAddressKey !== "string" ||
            !/^[\x21-\x7e]{1,256}$/.test(raw.pixAddressKey) ||
            !["CPF", "CNPJ", "EMAIL", "PHONE", "EVP"].includes(
              String(raw.pixAddressKeyType),
            )
          )
            return unavailable();
          const value = serializeBrlCents(raw.valueCents as number);
          const externalReference = localId(raw.externalReference);
          // Insert the canonical decimal token directly; it must stay a JSON number.
          const fields = JSON.stringify({
            operationType: "PIX",
            pixAddressKey: raw.pixAddressKey,
            pixAddressKeyType: raw.pixAddressKeyType,
            externalReference,
          });
          const payload = `{"value":${value},${fields.slice(1)}`;
          const response = await request(
            "/transfers",
            payload,
            decodeTransfers,
          );
          return {
            source: "provider",
            ...binding,
            observedAt: observedAt(),
            transfer: normalizeTransfer(response),
          };
        } catch {
          return unavailable();
        }
      },
      async getTransfer(providerReference) {
        try {
          const requested = reference(providerReference);
          const response = await request(
            `/transfers/${encodeURIComponent(requested)}`,
            undefined,
            decodeTransfers,
          );
          const transfer = normalizeTransfer(response);
          if (transfer.id !== requested) return unavailable();
          return {
            source: "provider",
            ...binding,
            observedAt: observedAt(),
            transfer,
          };
        } catch {
          return unavailable();
        }
      },
      async listTransfers(offset) {
        try {
          if (
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            offset > 900 ||
            offset % 100 !== 0
          )
            return unavailable();
          const response = await request(
            `/transfers?limit=100&offset=${offset}`,
            undefined,
            decodeTransfers,
          );
          if (
            typeof response.hasMore !== "boolean" ||
            !Number.isSafeInteger(response.totalCount) ||
            (response.totalCount as number) < 0 ||
            !Array.isArray(response.data) ||
            response.data.length > 100 ||
            (response.offset !== undefined && response.offset !== offset) ||
            (response.limit !== undefined && response.limit !== 100) ||
            offset + response.data.length > (response.totalCount as number) ||
            (!response.hasMore &&
              offset + response.data.length !== response.totalCount)
          )
            return unavailable();
          const transfers = response.data.map(normalizeTransfer);
          if (
            new Set(transfers.map((transfer) => transfer.id)).size !==
            transfers.length
          )
            return unavailable();
          return {
            source: "provider",
            ...binding,
            observedAt: observedAt(),
            offset,
            totalCount: response.totalCount as number,
            hasMore: response.hasMore,
            transfers,
          };
        } catch {
          return unavailable();
        }
      },
      async listCheckoutPayments(checkoutReference) {
        try {
          const requested = reference(checkoutReference);
          const response = await request(
            `/payments?checkoutSession=${encodeURIComponent(requested)}&limit=100&offset=0`,
          );
          if (
            response.hasMore !== false ||
            !Array.isArray(response.data) ||
            response.data.length > 100 ||
            response.totalCount !== response.data.length
          )
            return unavailable();
          const seen = new Set<string>();
          const payments = response.data.map((value) => {
            const raw = record(value);
            const id = reference(raw.id);
            if (seen.has(id) || raw.checkoutSession !== requested)
              return unavailable();
            seen.add(id);
            return {
              id,
              checkoutSession: requested,
              status: status(raw.status, paymentStatuses),
              ...(raw.externalReference !== undefined
                ? {
                    externalReference:
                      raw.externalReference === null
                        ? null
                        : localId(raw.externalReference),
                  }
                : {}),
            };
          });
          return {
            source: "provider",
            ...binding,
            checkoutReference: requested,
            observedAt: observedAt(),
            payments,
          };
        } catch {
          return unavailable();
        }
      },
      async getAccountFees(): Promise<AsaasAccountFeesObservation> {
        try {
          const startedAt = observedAt();
          const fees = await requestAccountFees();
          const completedAt = observedAt();
          if (completedAt.getTime() < startedAt.getTime()) return unavailable();
          return {
            source: "provider",
            ...binding,
            currency: "BRL",
            observedAt: startedAt,
            completedAt,
            fees,
          };
        } catch {
          return unavailable();
        }
      },
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
