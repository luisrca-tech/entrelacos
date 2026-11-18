import { GIFT_PLATFORM_TARIFFS } from "@entrelacos/contracts";
import {
  createPagarmeHttpClient,
  type PagarmeHttpClient,
  type PagarmeHttpClientOptions,
} from "./pagarmeHttpClient";

/** Flat fee Pagar.me debits from the recipient balance on each withdrawal. */
export const PAGARME_WITHDRAWAL_FEE_CENTS =
  GIFT_PLATFORM_TARIFFS.withdrawalFeeCents;

export const pagarmeRecipientStatuses = [
  "registration",
  "affiliation",
  "active",
  "refused",
  "suspended",
  "blocked",
  "inactive",
] as const;
export type PagarmeRecipientStatus = (typeof pagarmeRecipientStatuses)[number];

export const pagarmeWithdrawalStatuses = [
  "created",
  "pending",
  "processing",
  "transferred",
  "failed",
  "canceled",
] as const;
export type PagarmeWithdrawalStatus =
  (typeof pagarmeWithdrawalStatuses)[number];

export interface PagarmeRecipientInput {
  readonly name: string;
  readonly email: string;
  /** 11 digits; also the bank account holder document. */
  readonly cpf: string;
  /** DDD + number, 10 or 11 digits. */
  readonly mobilePhone: string;
  /** YYYY-MM-DD */
  readonly birthDate: string;
  readonly monthlyIncomeCents: number;
  readonly professionalOccupation: string;
  readonly address: {
    readonly street: string;
    readonly streetNumber: string;
    readonly complement?: string;
    readonly neighborhood: string;
    readonly city: string;
    readonly state: string;
    readonly zipCode: string;
    readonly referencePoint: string;
  };
  readonly bankAccount: {
    readonly bank: string;
    readonly branchNumber: string;
    readonly branchCheckDigit?: string;
    readonly accountNumber: string;
    readonly accountCheckDigit: string;
    readonly type: "checking" | "savings";
  };
}

export interface PagarmeRecipient {
  readonly id: string;
  readonly code: string | null;
  /** Raw provider status; unknown values are kept for the mapping to reject. */
  readonly status: string;
  /** Recipient CPF/CNPJ digits, compared with the bank account holder. */
  readonly document?: string | null;
  readonly bankAccount: {
    readonly id: string;
    readonly holderDocument: string;
    /** Matches the withdrawal preview mask: `Conta **** 1234`. */
    readonly maskedAccount: string;
  } | null;
}

export interface PagarmeKycLink {
  readonly url: string;
  readonly base64QrCode: string;
  readonly expiresAt: string;
}

export interface PagarmeRecipientBalance {
  readonly availableCents: number;
  readonly waitingFundsCents: number;
}

export interface PagarmeWithdrawal {
  readonly id: string;
  readonly amountCents: number;
  readonly status: string;
  readonly updatedAt: string;
}

export interface PagarmePayable {
  readonly id: string;
  readonly status: string;
  readonly amountCents: number;
  readonly feeCents: number;
  readonly anticipationFeeCents: number;
  readonly installment: number | null;
  readonly chargeId: string | null;
  readonly paymentDate: string | null;
}

export interface PagarmeRecipientClient {
  createRecipient(
    code: string,
    input: PagarmeRecipientInput,
  ): Promise<PagarmeRecipient>;
  getRecipient(recipientId: string): Promise<PagarmeRecipient>;
  /** Short-lived (about 20 minutes); callers must never persist it. */
  createKycLink(recipientId: string): Promise<PagarmeKycLink>;
  getBalance(recipientId: string): Promise<PagarmeRecipientBalance>;
  createWithdrawal(
    recipientId: string,
    transferCents: number,
    idempotencyKey: string,
  ): Promise<PagarmeWithdrawal>;
  getWithdrawal(
    recipientId: string,
    withdrawalId: string,
  ): Promise<PagarmeWithdrawal>;
  listPayables(
    recipientId: string,
    filter?: { chargeId?: string },
  ): Promise<PagarmePayable[]>;
}

export type ReceivingProviderAccountState =
  | "UNVERIFIED"
  | "ONBOARDING"
  | "UNDER_REVIEW"
  | "APPROVED"
  | "BLOCKED"
  | "SUSPENDED";

const statusMapping: Record<
  PagarmeRecipientStatus,
  ReceivingProviderAccountState
> = {
  registration: "ONBOARDING",
  affiliation: "UNDER_REVIEW",
  active: "APPROVED",
  refused: "BLOCKED",
  suspended: "SUSPENDED",
  blocked: "BLOCKED",
  inactive: "SUSPENDED",
};

/** Only an `active` recipient may receive split payments or withdraw. */
export function mapPagarmeRecipientStatus(status: string): {
  providerAccountState: ReceivingProviderAccountState;
  receivingCapability: boolean;
  withdrawalCapability: boolean;
} {
  const providerAccountState = Object.hasOwn(statusMapping, status)
    ? statusMapping[status as PagarmeRecipientStatus]
    : "UNVERIFIED";
  const capable = providerAccountState === "APPROVED";
  return {
    providerAccountState,
    receivingCapability: capable,
    withdrawalCapability: capable,
  };
}

/**
 * Pagar.me charges the withdrawal fee on top of `amount`, so the transfer
 * leaving the balance for a gross debit G is G - fee. [To confirm in sandbox]
 */
export function pagarmeWithdrawalTransferCents(grossCents: number): number {
  if (
    !Number.isSafeInteger(grossCents) ||
    grossCents <= PAGARME_WITHDRAWAL_FEE_CENTS
  )
    throw new RangeError("Withdrawal amount must exceed the withdrawal fee");
  return grossCents - PAGARME_WITHDRAWAL_FEE_CENTS;
}

function invalid(): never {
  throw new TypeError("Pagar.me recipient data is invalid");
}

const providerId = (prefixes: readonly string[]) => (value: unknown) => {
  if (
    typeof value !== "string" ||
    !new RegExp(`^(?:${prefixes.join("|")})_[A-Za-z0-9]{1,128}$`).test(value)
  )
    return invalid();
  return value;
};
export const readPagarmeRecipientId = providerId(["rp", "re"]);
const withdrawalId = providerId(["with", "tran"]);
const bankAccountId = providerId(["ba", "bank"]);

function code(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  )
    return invalid();
  return value;
}

function text(value: unknown, limit: number): string {
  if (typeof value !== "string") return invalid();
  const normalized = value.normalize("NFC").trim();
  if (
    !normalized ||
    normalized.length > limit ||
    [...normalized].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return invalid();
  return normalized;
}

function digits(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) return invalid();
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
}

function cents(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid();
  return value as number;
}

function instant(value: unknown): string {
  if (typeof value !== "string") return invalid();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return invalid();
  return new Date(parsed).toISOString();
}

function birthDate(value: unknown): string {
  const date = digits(value, /^\d{4}-\d{2}-\d{2}$/);
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)
    return invalid();
  return date;
}

function maskAccount(number: string, digit: string): string {
  return `Conta **** ${`${number}${digit}`.slice(-4).padStart(4, "0")}`;
}

function readRecipient(value: unknown): PagarmeRecipient {
  const raw = record(value);
  const status = text(raw.status, 64);
  const bank =
    raw.default_bank_account === null || raw.default_bank_account === undefined
      ? null
      : record(raw.default_bank_account);
  return Object.freeze({
    id: readPagarmeRecipientId(raw.id),
    code: raw.code === null || raw.code === undefined ? null : code(raw.code),
    status,
    document:
      raw.document === null || raw.document === undefined
        ? null
        : digits(raw.document, /^\d{11,14}$/),
    bankAccount: bank
      ? Object.freeze({
          id: bankAccountId(bank.id),
          holderDocument: digits(bank.holder_document, /^\d{11,14}$/),
          maskedAccount: maskAccount(
            digits(bank.account_number, /^\d{1,20}$/),
            digits(bank.account_check_digit ?? "", /^[0-9Xx]{0,2}$/),
          ),
        })
      : null,
  });
}

function readWithdrawal(value: unknown): PagarmeWithdrawal {
  const raw = record(value);
  return Object.freeze({
    id: withdrawalId(raw.id),
    amountCents: cents(raw.amount),
    status: text(raw.status, 64),
    updatedAt: instant(raw.updated_at ?? raw.created_at),
  });
}

function recipientBody(recipientCode: string, input: PagarmeRecipientInput) {
  const name = text(input.name, 128);
  const cpf = digits(input.cpf, /^\d{11}$/);
  const phone = digits(input.mobilePhone, /^\d{10,11}$/);
  if (
    !Number.isSafeInteger(input.monthlyIncomeCents) ||
    input.monthlyIncomeCents < 0
  )
    return invalid();
  const address = input.address;
  const bank = input.bankAccount;
  if (bank.type !== "checking" && bank.type !== "savings") return invalid();
  return {
    code: recipientCode,
    register_information: {
      type: "individual",
      name,
      email: text(input.email, 254),
      document: cpf,
      birthdate: `${birthDate(input.birthDate)}T00:00:00`,
      monthly_income: input.monthlyIncomeCents,
      professional_occupation: text(input.professionalOccupation, 128),
      phone_numbers: [
        { ddd: phone.slice(0, 2), number: phone.slice(2), type: "mobile" },
      ],
      address: {
        street: text(address.street, 256),
        street_number: text(address.streetNumber, 32),
        ...(address.complement?.trim()
          ? { complementary: text(address.complement, 128) }
          : {}),
        neighborhood: text(address.neighborhood, 128),
        city: text(address.city, 128),
        state: digits(address.state, /^[A-Z]{2}$/),
        zip_code: digits(address.zipCode, /^\d{8}$/),
        reference_point: text(address.referencePoint, 256),
      },
    },
    default_bank_account: {
      holder_name: name,
      holder_type: "individual",
      holder_document: cpf,
      bank: digits(bank.bank, /^\d{3}$/),
      branch_number: digits(bank.branchNumber, /^\d{1,4}$/),
      ...(bank.branchCheckDigit
        ? { branch_check_digit: digits(bank.branchCheckDigit, /^\d$/) }
        : {}),
      account_number: digits(bank.accountNumber, /^\d{1,13}$/),
      account_check_digit: digits(bank.accountCheckDigit, /^[0-9Xx]{1,2}$/),
      type: bank.type,
    },
    transfer_settings: {
      transfer_enabled: false,
      transfer_interval: "Daily",
      transfer_day: 0,
    },
    automatic_anticipation_settings: {
      enabled: true,
      type: "full",
      volume_percentage: 100,
      delay: null,
    },
  };
}

export function createPagarmeRecipientClient(
  options: PagarmeHttpClientOptions | { http: PagarmeHttpClient },
): PagarmeRecipientClient {
  const http =
    "http" in options ? options.http : createPagarmeHttpClient(options);
  const client: PagarmeRecipientClient = {
    async createRecipient(recipientCode, input) {
      const body = recipientBody(code(recipientCode), input);
      const recipient = readRecipient(
        await http.request("POST", "/recipients", {
          body,
          idempotencyKey: `recipient:${recipientCode}`,
        }),
      );
      if (
        recipient.code !== recipientCode ||
        (recipient.bankAccount &&
          recipient.bankAccount.holderDocument !==
            body.register_information.document)
      )
        return invalid();
      return recipient;
    },
    async getRecipient(recipientId) {
      const id = readPagarmeRecipientId(recipientId);
      const recipient = readRecipient(
        await http.request("GET", `/recipients/${id}`),
      );
      if (recipient.id !== id) return invalid();
      return recipient;
    },
    async createKycLink(recipientId) {
      const id = readPagarmeRecipientId(recipientId);
      const raw = record(
        await http.request("POST", `/recipients/${id}/kyc_link`),
      );
      const url = text(raw.url, 2048);
      let parsed: URL;
      try {
        parsed = new URL(url.startsWith("www.") ? `https://${url}` : url);
      } catch {
        return invalid();
      }
      if (parsed.protocol !== "https:") return invalid();
      const qr = text(raw.base64_qrcode ?? raw.base64, 1_000_000);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(qr)) return invalid();
      return Object.freeze({
        url: parsed.href,
        base64QrCode: qr,
        expiresAt: instant(raw.expires_at ?? raw.expiration_date),
      });
    },
    async getBalance(recipientId) {
      const id = readPagarmeRecipientId(recipientId);
      const raw = record(
        await http.request("GET", `/recipients/${id}/balance`),
      );
      if (raw.currency !== undefined && raw.currency !== "BRL")
        return invalid();
      return Object.freeze({
        availableCents: cents(raw.available_amount),
        waitingFundsCents: cents(raw.waiting_funds_amount),
      });
    },
    async createWithdrawal(recipientId, transferCents, idempotencyKey) {
      const id = readPagarmeRecipientId(recipientId);
      if (!Number.isSafeInteger(transferCents) || transferCents < 1)
        return invalid();
      const withdrawal = readWithdrawal(
        await http.request("POST", `/recipients/${id}/withdrawals`, {
          body: { amount: transferCents },
          idempotencyKey,
        }),
      );
      if (withdrawal.amountCents !== transferCents) return invalid();
      return withdrawal;
    },
    async getWithdrawal(recipientId, providerWithdrawalId) {
      const id = readPagarmeRecipientId(recipientId);
      const wid = withdrawalId(providerWithdrawalId);
      const withdrawal = readWithdrawal(
        await http.request("GET", `/recipients/${id}/withdrawals/${wid}`),
      );
      if (withdrawal.id !== wid) return invalid();
      return withdrawal;
    },
    async listPayables(recipientId, filter = {}) {
      const id = readPagarmeRecipientId(recipientId);
      const query = new URLSearchParams({ recipient_id: id });
      if (filter.chargeId !== undefined)
        query.set("charge_id", providerId(["ch"])(filter.chargeId));
      const raw = record(await http.request("GET", `/payables?${query}`));
      if (!Array.isArray(raw.data)) return invalid();
      return raw.data.map((item) => {
        const payable = record(item);
        if (payable.recipient_id !== undefined && payable.recipient_id !== id)
          return invalid();
        return Object.freeze({
          id: String(code(String(payable.id))),
          status: text(payable.status, 64),
          amountCents: Number.isSafeInteger(payable.amount)
            ? (payable.amount as number)
            : invalid(),
          feeCents: cents(payable.fee ?? 0),
          anticipationFeeCents: cents(payable.anticipation_fee ?? 0),
          installment: Number.isSafeInteger(payable.installment)
            ? (payable.installment as number)
            : null,
          chargeId:
            typeof payable.charge_id === "string" ? payable.charge_id : null,
          paymentDate:
            payable.payment_date == null ? null : instant(payable.payment_date),
        });
      });
    },
  };
  return Object.freeze(client);
}
