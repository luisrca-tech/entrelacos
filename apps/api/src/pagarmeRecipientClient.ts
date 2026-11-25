import {
  GIFT_PLATFORM_TARIFFS,
  type PagarmeKycStatus,
  type PagarmeKycStatusReason,
  pagarmeKycStatuses,
  pagarmeKycStatusReasons,
  RECEIVING_HOLDER_NAME_MAX_LENGTH,
} from "@entrelacos/contracts";
import { logObservabilityEvent } from "./observability";
import {
  createPagarmeHttpClient,
  type PagarmeHttpClient,
  type PagarmeHttpClientOptions,
} from "./pagarmeHttpClient";
import {
  pagarmeLegacyWithdrawalIdPattern,
  pagarmeRecipientIdPattern,
  pagarmeTransferIdPattern,
} from "./pagarmeIds";

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

/**
 * Transfer statuses (https://docs.pagar.me/reference/objeto-transfer%C3%AAncia.md)
 * plus the deprecated withdrawal ones, kept so recorded observations stay
 * readable.
 */
export const pagarmeWithdrawalStatuses = [
  "pending_transfer",
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
    readonly referencePoint?: string;
  };
  readonly bankAccount: {
    readonly bank: string;
    readonly branchNumber: string;
    readonly branchCheckDigit?: string;
    readonly accountNumber: string;
    readonly accountCheckDigit: string;
    /** `default_bank_account.holder_name`, at most 29 characters. */
    readonly holderName: string;
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
  /** Identity check (`kyc_details`): enum values only, no personal data. */
  readonly kyc: PagarmeRecipientKyc;
  readonly bankAccount: {
    readonly id: string;
    readonly holderDocument: string;
    /** Matches the withdrawal preview mask: `Conta **** 1234`. */
    readonly maskedAccount: string;
  } | null;
}

export interface PagarmeRecipientKyc {
  /** Null when Pagar.me sent no `kyc_details`. */
  readonly status: PagarmeKycStatus | null;
  readonly statusReason: PagarmeKycStatusReason | null;
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
  /**
   * `attempt` counts the dispatches of one account creation. The first keeps
   * the `recipient:<code>` idempotency key; a later one, made only after a
   * recorded definitive refusal or a confirmed absence, uses
   * `recipient:<code>:<attempt>` so a cached refusal is not replayed.
   */
  createRecipient(
    code: string,
    input: PagarmeRecipientInput,
    attempt?: number,
  ): Promise<PagarmeRecipient>;
  getRecipient(recipientId: string): Promise<PagarmeRecipient>;
  /**
   * Reads every recipient (GET only) and returns the one created with this
   * code, or null once every page proved it absent. Any doubt throws.
   */
  findRecipientByCode(code: string): Promise<PagarmeRecipient | null>;
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
  /** GET /transfers?recipient_id=, created since an instant: recovers a lost POST response. */
  listWithdrawals(
    recipientId: string,
    createdSince: string,
  ): Promise<PagarmeWithdrawal[]>;
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
export function readPagarmeRecipientId(value: unknown): string {
  if (typeof value !== "string" || !pagarmeRecipientIdPattern.test(value))
    return invalid();
  return value;
}
/** Transfer ids are integers on the wire; they are kept as decimal strings. */
function withdrawalId(value: unknown): string {
  const id =
    typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? String(value)
      : value;
  if (typeof id !== "string" || !pagarmeTransferIdPattern.test(id))
    return invalid();
  return id;
}
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

function kycValue<T extends string>(
  values: readonly T[],
  value: unknown,
): T | "unknown" | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" &&
    (values as readonly string[]).includes(value)
    ? (value as T)
    : "unknown";
}

/**
 * Reads `kyc_details` without ever failing the recipient read: only the
 * documented enum values survive, anything else becomes `unknown`.
 */
function readKyc(value: unknown): PagarmeRecipientKyc {
  if (value === null || value === undefined)
    return Object.freeze({ status: null, statusReason: null });
  if (typeof value !== "object" || Array.isArray(value))
    return Object.freeze({ status: "unknown", statusReason: null });
  const raw = value as Record<string, unknown>;
  return Object.freeze({
    status: kycValue(pagarmeKycStatuses, raw.status),
    statusReason: kycValue(pagarmeKycStatusReasons, raw.status_reason),
  });
}

function readRecipient(value: unknown): PagarmeRecipient {
  const raw = record(value);
  const status = text(raw.status, 64);
  const bank =
    raw.default_bank_account === null || raw.default_bank_account === undefined
      ? null
      : record(raw.default_bank_account);
  return Object.freeze({
    // Recipients created after the 2026-07-14 API change may only carry a
    // `pp_` payment profile id.
    id: readPagarmeRecipientId(raw.id ?? raw.payment_profile_id),
    code: raw.code === null || raw.code === undefined ? null : code(raw.code),
    status,
    kyc: readKyc(raw.kyc_details),
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

/**
 * Every id one recipient answers to: the core `rp_`/`re_` id, the `pp_`
 * payment profile id and the gateway `re_` id (`gateway_recipients[].pgid`).
 * Pagar.me may echo any of them as a transfer's `source_id`.
 */
function recipientIdentities(value: unknown): ReadonlySet<string> {
  const raw = record(value);
  const gateways = Array.isArray(raw.gateway_recipients)
    ? raw.gateway_recipients
    : [];
  const candidates = [
    raw.id,
    raw.payment_profile_id,
    ...gateways.map((gateway) =>
      gateway && typeof gateway === "object" && !Array.isArray(gateway)
        ? (gateway as Record<string, unknown>).pgid
        : undefined,
    ),
  ];
  return new Set(
    candidates.filter(
      (id): id is string =>
        typeof id === "string" && pagarmeRecipientIdPattern.test(id),
    ),
  );
}

interface ReadTransfer {
  readonly withdrawal: PagarmeWithdrawal;
  /** Recipient ids the provider names as the transfer's source. */
  readonly sources: readonly string[];
}

/**
 * Reads a transfer (or a legacy withdrawal) and the recipient ids it names.
 * A source that is not a recipient is refused here; whether the named ids
 * belong to our recipient is settled by `ownedBy`.
 */
function readTransfer(value: unknown): ReadTransfer {
  const raw = record(value);
  if (raw.source_type !== undefined && raw.source_type !== "recipient")
    return invalid();
  const sources = [raw.source_id, raw.recipient_id]
    .filter((id) => id !== undefined)
    .map(readPagarmeRecipientId);
  return {
    withdrawal: Object.freeze({
      id: withdrawalId(raw.id),
      amountCents: cents(raw.amount),
      status: text(raw.status, 64),
      updatedAt: instant(
        raw.date_updated ??
          raw.updated_at ??
          raw.date_created ??
          raw.created_at,
      ),
    }),
    sources,
  };
}

function createdAt(value: unknown): number {
  const raw = record(value);
  return Date.parse(instant(raw.date_created ?? raw.created_at));
}

/** GET /transfers answers at most this many items per page. */
const TRANSFER_PAGE_SIZE = 1_000;

/**
 * GET /recipients only documents `page` and `size`, no `code` filter, and its
 * list items may omit `code` (https://docs.pagar.me/reference/listar-recebedores-1),
 * so the search pages the list and reads by id an item without one.
 */
const RECIPIENT_PAGE_SIZE = 100;
const RECIPIENT_MAX_PAGES = 20;
const RECIPIENT_MAX_CODE_READS = 25;
export const MAX_RECIPIENT_DISPATCH_ATTEMPTS = 1_000;

function attemptNumber(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_RECIPIENT_DISPATCH_ATTEMPTS
  )
    return invalid();
  return value as number;
}

/** Pagar.me example dates are `DD/MM/YYYY` (criar-recebedor-1). */
function pagarmeBirthdate(isoDate: string): string {
  const [year, month, day] = birthDate(isoDate).split("-");
  return `${day}/${month}/${year}`;
}

/**
 * POST /recipients answers 422 without `register_information.address.complementary`
 * (sandbox, 2026-11-19), so an address without a complement sends this instead.
 */
const RECIPIENT_COMPLEMENT_FALLBACK = "Sem complemento";

/**
 * `register_information.address.reference_point` is required by POST /recipients
 * (https://docs.pagar.me/reference/criar-recebedor-1), so an address without a
 * reference point sends this instead of an empty string.
 */
const RECIPIENT_REFERENCE_POINT_FALLBACK = "Sem referência";

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
      birthdate: pagarmeBirthdate(input.birthDate),
      monthly_income: input.monthlyIncomeCents,
      professional_occupation: text(input.professionalOccupation, 128),
      phone_numbers: [
        { ddd: phone.slice(0, 2), number: phone.slice(2), type: "mobile" },
      ],
      address: {
        street: text(address.street, 256),
        street_number: text(address.streetNumber, 32),
        complementary: address.complement?.trim()
          ? text(address.complement, 128)
          : RECIPIENT_COMPLEMENT_FALLBACK,
        neighborhood: text(address.neighborhood, 128),
        city: text(address.city, 128),
        state: digits(address.state, /^[A-Z]{2}$/),
        zip_code: digits(address.zipCode, /^\d{8}$/),
        reference_point: address.referencePoint?.trim()
          ? text(address.referencePoint, 256)
          : RECIPIENT_REFERENCE_POINT_FALLBACK,
      },
    },
    default_bank_account: {
      // Pagar.me refuses a holder name of 30 or more characters (422), so it
      // is the name typed for the bank, never the 128-character full name.
      holder_name: text(bank.holderName, RECEIVING_HOLDER_NAME_MAX_LENGTH),
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

export type PagarmeRecipientClientOptions = (
  | PagarmeHttpClientOptions
  | { http: PagarmeHttpClient }
) & {
  /** Receives PII-free operational events; defaults to the structured log. */
  observe?(event: {
    level: "warn";
    event: string;
    operation: string;
    count: number;
  }): void;
};

export function createPagarmeRecipientClient(
  options: PagarmeRecipientClientOptions,
): PagarmeRecipientClient {
  const http =
    "http" in options ? options.http : createPagarmeHttpClient(options);
  const observe = options.observe ?? logObservabilityEvent;
  /**
   * Refuses any source that is not the recipient `id`. When the provider
   * names it in another format, the recipient is read once: it must answer
   * to `id` and list every named source among its own ids. Any failure of
   * that read is a TypeError, never a PagarmeRejectedError, so a created
   * transfer is never mistaken for a definitive rejection.
   */
  async function ownedBy(id: string, sources: readonly string[]) {
    if (sources.every((source) => source === id)) return;
    let identities: ReadonlySet<string>;
    try {
      identities = recipientIdentities(
        await http.request("GET", `/recipients/${id}`),
      );
    } catch {
      return invalid();
    }
    if (
      !identities.has(id) ||
      !sources.every((source) => identities.has(source))
    )
      return invalid();
  }
  const client: PagarmeRecipientClient = {
    async createRecipient(recipientCode, input, attempt = 1) {
      const body = recipientBody(code(recipientCode), input);
      const dispatch = attemptNumber(attempt);
      const recipient = readRecipient(
        await http.request("POST", "/recipients", {
          body,
          idempotencyKey:
            dispatch === 1
              ? `recipient:${recipientCode}`
              : `recipient:${recipientCode}:${dispatch}`,
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
      const raw = await http.request("GET", `/recipients/${id}`);
      const recipient = readRecipient(raw);
      // The stored id may be any of the recipient's formats; it is kept.
      if (!recipientIdentities(raw).has(id)) return invalid();
      return Object.freeze({ ...recipient, id });
    },
    async findRecipientByCode(recipientCode) {
      const wanted = code(recipientCode);
      let reads = 0;
      let seen = 0;
      for (let page = 1; page <= RECIPIENT_MAX_PAGES; page++) {
        const query = new URLSearchParams({
          page: String(page),
          size: String(RECIPIENT_PAGE_SIZE),
        });
        const raw = record(await http.request("GET", `/recipients?${query}`));
        const total = record(raw.paging).total;
        if (!Array.isArray(raw.data) || !Number.isSafeInteger(total))
          return invalid();
        for (const item of raw.data) {
          const listed = record(item);
          const id = readPagarmeRecipientId(
            listed.id ?? listed.payment_profile_id,
          );
          let listedCode = listed.code;
          if (listedCode === undefined) {
            if (++reads > RECIPIENT_MAX_CODE_READS) return invalid();
            listedCode = readRecipient(
              await http.request("GET", `/recipients/${id}`),
            ).code;
          }
          if (listedCode !== wanted) continue;
          const found = readRecipient(
            await http.request("GET", `/recipients/${id}`),
          );
          if (found.code !== wanted) return invalid();
          return found;
        }
        seen += raw.data.length;
        if (raw.data.length < RECIPIENT_PAGE_SIZE) {
          // Absence is proven only when every counted recipient was read.
          if (seen !== total) return invalid();
          return null;
        }
      }
      return invalid();
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
      // POST /recipients/{id}/withdrawals is deprecated in favour of
      // Transfers, the only route that documents Idempotency-Key
      // (https://docs.pagar.me/reference/criando-uma-transfer%C3%AAncia.md).
      const { withdrawal, sources } = readTransfer(
        await http.request("POST", "/transfers", {
          body: { amount: transferCents, recipient_id: id },
          idempotencyKey,
        }),
      );
      await ownedBy(id, sources);
      if (withdrawal.amountCents !== transferCents) return invalid();
      return withdrawal;
    },
    async getWithdrawal(recipientId, providerWithdrawalId) {
      const id = readPagarmeRecipientId(recipientId);
      const wid = withdrawalId(providerWithdrawalId);
      // Only withdrawals recorded before the move to Transfers use the
      // deprecated route.
      const path = pagarmeLegacyWithdrawalIdPattern.test(wid)
        ? `/recipients/${id}/withdrawals/${wid}`
        : `/transfers/${wid}`;
      const { withdrawal, sources } = readTransfer(
        await http.request("GET", path),
      );
      await ownedBy(id, sources);
      if (withdrawal.id !== wid) return invalid();
      return withdrawal;
    },
    async listWithdrawals(recipientId, createdSince) {
      const id = readPagarmeRecipientId(recipientId);
      const since = Date.parse(instant(createdSince));
      // GET /transfers answers a bare array filtered by recipient; it has no
      // "created since" filter, so the window is applied here
      // (https://docs.pagar.me/reference/retornando-transfer%C3%AAncias.md).
      // Only the first page is read: later pages are signalled by the
      // `x-cursor-nextpage` header and the sort order is undocumented, so a
      // full page cannot prove the window is complete and is refused. Lookup
      // then stays unresolved and the hold is kept.
      const query = new URLSearchParams({
        recipient_id: id,
        count: String(TRANSFER_PAGE_SIZE),
      });
      const raw = await http.request("GET", `/transfers?${query}`);
      const list = Array.isArray(raw) ? raw : record(raw).data;
      if (!Array.isArray(list) || list.length >= TRANSFER_PAGE_SIZE)
        return invalid();
      // An unreadable item (bad shape or no creation date) is skipped so the
      // others still reconcile; it can never be matched, and only a count is
      // logged. A readable item naming another recipient still refuses the
      // whole list: the provider filter cannot be trusted then.
      const readable: ReadTransfer[] = [];
      const inWindow: PagarmeWithdrawal[] = [];
      let skipped = 0;
      for (const item of list) {
        let transfer: ReadTransfer;
        let created: number;
        try {
          transfer = readTransfer(item);
          created = createdAt(item);
        } catch {
          skipped += 1;
          continue;
        }
        readable.push(transfer);
        if (created >= since) inWindow.push(transfer.withdrawal);
      }
      if (skipped > 0)
        observe({
          level: "warn",
          event: "pagarme_transfer_list_item_skipped",
          operation: "listWithdrawals",
          count: skipped,
        });
      await ownedBy(
        id,
        readable.flatMap((transfer) => transfer.sources),
      );
      return inWindow;
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
