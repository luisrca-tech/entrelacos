import { giftQuoteSchema } from "@entrelacos/contracts";
import type { DatabaseConnection } from "@entrelacos/database";
import {
  financialLedgerEntry,
  financialOperatorAlert,
  giftOrder,
  giftPaymentRecord,
  giftQuoteRecord,
} from "@entrelacos/database/schema";
import { sql } from "drizzle-orm";
import { resolveFinancialOperatorAlert } from "./financialOperatorAlertRepository";
import { parseBrlCents, serializeBrlCents } from "./giftMoney";
import {
  type GiftQuoteSnapshot,
  isPlatformAccountSplit,
  readGiftV2Settlement,
} from "./giftQuotes";

// Operator fix for a PLATFORM_ACCOUNT_SPLIT_V2 charge whose fixed couple split
// Asaas blocked (PAYMENT_SPLIT_DIVERGENCE_BLOCK) because the charge's net value
// is below it. The split is lowered to what the net can carry ("fit") and the
// rest ("topUp") is recorded in gift_payment_record.platform_adjustment_cents:
// posting then credits the lowered SPLIT_DONE and the adjustment worker
// transfers the top-up from the platform account to the couple wallet.

export type SplitDivergenceFixErrorCode =
  | "CONFIGURATION_INVALID"
  | "PROVIDER_UNAVAILABLE"
  | "PAYMENT_NOT_FOUND"
  | "PAYMENT_NOT_V2"
  | "PAYMENT_NOT_BLOCKED"
  | "PAYMENT_ALREADY_CREDITED"
  | "PAYMENT_NOT_EDITABLE"
  | "PAYMENT_RESTRICTED"
  | "NET_VALUE_UNAVAILABLE"
  | "SPLIT_UNEXPECTED"
  | "TOPUP_CONFLICT"
  | "SPLIT_UPDATE_UNVERIFIED"
  | "RECORD_CHANGED";

export class SplitDivergenceFixError extends Error {
  constructor(readonly code: SplitDivergenceFixErrorCode) {
    super(`Split divergence fix refused: ${code}`);
    this.name = "SplitDivergenceFixError";
  }
}

function fail(code: SplitDivergenceFixErrorCode): never {
  throw new SplitDivergenceFixError(code);
}

export interface SplitDivergenceFixOptions {
  environment: "sandbox" | "live";
  platformApiKey: string;
  platformWalletId: string;
  fetch: typeof globalThis.fetch;
}

/** The stored V2 charge the fix applies to (one gift_payment_record). */
export interface SplitDivergenceRecord {
  paymentId: string;
  siteId: string;
  accountId: string;
  installmentNumber: number | null;
  platformAdjustmentCents: number | null;
  adjustmentDispatched: boolean;
  blocked: boolean;
  alertOpen: boolean;
  credited: boolean;
  snapshot: GiftQuoteSnapshot;
}

export interface SplitDivergenceStore {
  /** Reads the record; inside `persist` it is read again under a row lock. */
  load(paymentReference: string): Promise<SplitDivergenceRecord | null>;
  /** Runs `work` in one transaction with a store bound to it. */
  transaction<T>(
    work: (store: SplitDivergenceTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface SplitDivergenceTransaction {
  load(paymentReference: string): Promise<SplitDivergenceRecord | null>;
  /** Sets platform_adjustment_cents once; false when the row did not match. */
  recordTopUp(
    record: SplitDivergenceRecord,
    topUpCents: number,
  ): Promise<boolean>;
  resolveAlert(paymentReference: string, note: string): Promise<boolean>;
}

export interface SplitDivergencePlan {
  paymentReference: string;
  paymentId: string;
  environment: "sandbox" | "live";
  providerStatus: string;
  installmentNumber: number | null;
  coupleWallet: string;
  netCents: number;
  expectedSplitCents: number;
  currentSplitCents: number | null;
  fitCents: number;
  topUpCents: number;
  splitUpdateRequired: boolean;
  topUpRecorded: boolean;
  blocked: boolean;
  alertOpen: boolean;
}

export interface SplitDivergenceFixResult {
  plan: SplitDivergencePlan;
  applied: boolean;
  splitUpdated: boolean;
  topUpRecorded: boolean;
  alertResolved: boolean;
}

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("PROVIDER_UNAVAILABLE");
  return value as Json;
}

function providerCents(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string")
    return fail("PROVIDER_UNAVAILABLE");
  try {
    return parseBrlCents(String(value));
  } catch {
    return fail("PROVIDER_UNAVAILABLE");
  }
}

const paymentReferencePattern = /^[A-Za-z0-9_-]{1,128}$/;

export function assertPaymentReference(value: unknown): string {
  if (typeof value !== "string" || !paymentReferencePattern.test(value))
    return fail("CONFIGURATION_INVALID");
  return value;
}

/** Platform key requests, restricted to the payment read and split edit. */
export function createSplitDivergenceProvider(
  options: SplitDivergenceFixOptions,
) {
  const sandbox = options.environment === "sandbox";
  if (
    (options.environment !== "sandbox" && options.environment !== "live") ||
    !options.platformApiKey.startsWith(sandbox ? "$aact_hmlg_" : "$aact_prod_")
  )
    return fail("CONFIGURATION_INVALID");
  const base = sandbox
    ? "https://api-sandbox.asaas.com/v3"
    : "https://api.asaas.com/v3";
  async function request(path: string, body?: Json): Promise<Json> {
    let response: Response;
    try {
      response = await options.fetch(base + path, {
        method: body === undefined ? "GET" : "PUT",
        redirect: "error",
        headers: {
          accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "Entrelacos/1.0",
          access_token: options.platformApiKey,
        },
        signal: AbortSignal.timeout(15_000),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      return fail("PROVIDER_UNAVAILABLE");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return fail("PROVIDER_UNAVAILABLE");
    }
    const text = await response.text();
    if (text.length > 262_144) return fail("PROVIDER_UNAVAILABLE");
    try {
      return record(JSON.parse(text));
    } catch {
      return fail("PROVIDER_UNAVAILABLE");
    }
  }
  return {
    getPayment: (paymentReference: string) =>
      request(`/payments/${assertPaymentReference(paymentReference)}`),
    // During a divergence block Asaas accepts a split-only edit on CONFIRMED
    // and RECEIVED charges; any other field must not be sent.
    updateSplit: (paymentReference: string, walletId: string, cents: number) =>
      request(`/payments/${assertPaymentReference(paymentReference)}`, {
        split: [{ walletId, fixedValue: Number(serializeBrlCents(cents)) }],
      }),
  };
}

/** The couple split currently configured on the charge, or null when absent. */
function coupleSplitCents(payment: Json, coupleWallet: string): number | null {
  if (payment.split == null) return null;
  if (!Array.isArray(payment.split)) return fail("PROVIDER_UNAVAILABLE");
  const splits = payment.split.map(record);
  // Only the couple wallet may be split to; the platform keeps the remainder.
  if (
    splits.length > 1 ||
    splits.some(
      (split) =>
        split.walletId !== coupleWallet || split.percentualValue != null,
    )
  )
    return fail("SPLIT_UNEXPECTED");
  if (splits.length === 0) return null;
  return providerCents(splits[0].fixedValue);
}

function expectedSplit(record: SplitDivergenceRecord, environment: string) {
  const snapshot = record.snapshot;
  if (!snapshot || !isPlatformAccountSplit(snapshot))
    return fail("PAYMENT_NOT_V2");
  const parsed = giftQuoteSchema.safeParse(snapshot.quote);
  if (!parsed.success || parsed.data.mode !== environment)
    return fail("PAYMENT_NOT_V2");
  let split: number | undefined;
  try {
    const settlement = readGiftV2Settlement(parsed.data, snapshot.settlement);
    const count = parsed.data.installmentCount ?? 1;
    const number = record.installmentNumber;
    if (
      count === 1
        ? number !== null
        : number === null ||
          !Number.isInteger(number) ||
          number < 1 ||
          number > count
    )
      return fail("PAYMENT_NOT_V2");
    split = settlement?.recipientSplitCents[(number ?? 1) - 1];
  } catch (error) {
    if (error instanceof SplitDivergenceFixError) throw error;
    return fail("PAYMENT_NOT_V2");
  }
  const wallet = snapshot.receiving?.recipientReference;
  if (
    split === undefined ||
    !Number.isSafeInteger(split) ||
    split <= 0 ||
    typeof wallet !== "string" ||
    !paymentReferencePattern.test(wallet)
  )
    return fail("PAYMENT_NOT_V2");
  return { splitCents: split, coupleWallet: wallet };
}

function checkRecord(record: SplitDivergenceRecord | null) {
  if (!record) return fail("PAYMENT_NOT_FOUND");
  if (record.credited) return fail("PAYMENT_ALREADY_CREDITED");
  if (!record.blocked && !record.alertOpen) return fail("PAYMENT_NOT_BLOCKED");
  return record;
}

/** Reads the charge and the stored record; never writes. */
export async function planSplitDivergenceFix(
  store: Pick<SplitDivergenceStore, "load">,
  options: SplitDivergenceFixOptions,
  paymentReference: string,
): Promise<SplitDivergencePlan> {
  const reference = assertPaymentReference(paymentReference);
  const provider = createSplitDivergenceProvider(options);
  const stored = checkRecord(await store.load(reference));
  const { splitCents, coupleWallet } = expectedSplit(
    stored,
    options.environment,
  );
  if (coupleWallet === options.platformWalletId) return fail("PAYMENT_NOT_V2");
  const payment = await provider.getPayment(reference);
  if (payment.id !== reference) return fail("PROVIDER_UNAVAILABLE");
  const status = String(payment.status);
  if (
    payment.deleted === true ||
    (Array.isArray(payment.refunds) && payment.refunds.length > 0) ||
    payment.chargeback != null ||
    payment.custody != null
  )
    return fail("PAYMENT_RESTRICTED");
  if (status !== "CONFIRMED" && status !== "RECEIVED")
    return fail("PAYMENT_NOT_EDITABLE");
  if (payment.netValue == null) return fail("NET_VALUE_UNAVAILABLE");
  const netCents = providerCents(payment.netValue);
  const fitCents = Math.min(splitCents, netCents);
  if (fitCents <= 0) return fail("NET_VALUE_UNAVAILABLE");
  const topUpCents = splitCents - fitCents;
  const current = coupleSplitCents(payment, coupleWallet);
  // A re-run after a partial apply finds the split already lowered.
  if (current !== null && current !== splitCents && current !== fitCents)
    return fail("SPLIT_UNEXPECTED");
  const recorded = stored.platformAdjustmentCents;
  if (
    (recorded !== null && recorded !== topUpCents) ||
    (recorded === null && stored.adjustmentDispatched)
  )
    return fail("TOPUP_CONFLICT");
  return {
    paymentReference: reference,
    paymentId: stored.paymentId,
    environment: options.environment,
    providerStatus: status,
    installmentNumber: stored.installmentNumber,
    coupleWallet,
    netCents,
    expectedSplitCents: splitCents,
    currentSplitCents: current,
    fitCents,
    topUpCents,
    splitUpdateRequired: current !== fitCents,
    topUpRecorded: recorded !== null,
    blocked: stored.blocked,
    alertOpen: stored.alertOpen,
  };
}

/**
 * Dry run without `apply`. With `apply`: edits the split (only when needed),
 * re-reads it, then records the top-up and resolves the alert in one
 * transaction. Re-running after a partial failure converges.
 */
export async function fixSplitDivergence(
  store: SplitDivergenceStore,
  options: SplitDivergenceFixOptions,
  input: { paymentReference: string; apply: boolean },
): Promise<SplitDivergenceFixResult> {
  const plan = await planSplitDivergenceFix(
    store,
    options,
    input.paymentReference,
  );
  if (!input.apply)
    return {
      plan,
      applied: false,
      splitUpdated: false,
      topUpRecorded: false,
      alertResolved: false,
    };
  const provider = createSplitDivergenceProvider(options);
  if (plan.splitUpdateRequired) {
    await provider.updateSplit(
      plan.paymentReference,
      plan.coupleWallet,
      plan.fitCents,
    );
    const reread = await provider.getPayment(plan.paymentReference);
    if (
      reread.id !== plan.paymentReference ||
      coupleSplitCents(reread, plan.coupleWallet) !== plan.fitCents
    )
      return fail("SPLIT_UPDATE_UNVERIFIED");
  }
  const note = `fixSplitDivergence fit=${plan.fitCents} topUp=${plan.topUpCents}`;
  const outcome = await store.transaction(async (tx) => {
    const locked = checkRecord(await tx.load(plan.paymentReference));
    if (
      locked.paymentId !== plan.paymentId ||
      expectedSplit(locked, options.environment).splitCents !==
        plan.expectedSplitCents ||
      (locked.platformAdjustmentCents !== null &&
        locked.platformAdjustmentCents !== plan.topUpCents)
    )
      return fail("RECORD_CHANGED");
    let recorded = false;
    if (plan.topUpCents > 0 && locked.platformAdjustmentCents === null) {
      if (!(await tx.recordTopUp(locked, plan.topUpCents)))
        return fail("RECORD_CHANGED");
      recorded = true;
    }
    const resolved = await tx.resolveAlert(plan.paymentReference, note);
    return { recorded, resolved };
  });
  return {
    plan,
    applied: true,
    splitUpdated: plan.splitUpdateRequired,
    topUpRecorded: outcome.recorded,
    alertResolved: outcome.resolved,
  };
}

type Executor = Pick<DatabaseConnection["db"], "execute">;

function storeRow(row: Json | undefined): SplitDivergenceRecord | null {
  if (!row) return null;
  const adjustment = row.platformAdjustmentCents;
  return {
    paymentId: String(row.paymentId),
    siteId: String(row.siteId),
    accountId: String(row.accountId),
    installmentNumber:
      row.installmentNumber == null ? null : Number(row.installmentNumber),
    platformAdjustmentCents: adjustment == null ? null : Number(adjustment),
    adjustmentDispatched: row.adjustmentDispatched === true,
    blocked: row.blocked === true,
    alertOpen: row.alertOpen === true,
    credited: row.credited === true,
    snapshot: (typeof row.snapshot === "string"
      ? JSON.parse(row.snapshot)
      : row.snapshot) as GiftQuoteSnapshot,
  };
}

async function loadRecord(
  db: Executor,
  environment: "sandbox" | "live",
  paymentReference: string,
  lock: boolean,
): Promise<SplitDivergenceRecord | null> {
  const result =
    await db.execute(sql`SELECT p.id AS "paymentId", p.site_id AS "siteId", p.account_id AS "accountId",
      p.installment_number AS "installmentNumber", p.platform_adjustment_cents AS "platformAdjustmentCents",
      p.platform_adjustment_dispatch_at IS NOT NULL AS "adjustmentDispatched",
      p.split_divergence_blocked_at IS NOT NULL AS blocked, q.snapshot,
      EXISTS (SELECT 1 FROM ${financialOperatorAlert} a WHERE a.environment=p.environment AND a.kind='SPLIT_DIVERGENCE_BLOCK'
        AND a.payment_reference=p.provider_payment_reference AND a.resolved_at IS NULL) AS "alertOpen",
      EXISTS (SELECT 1 FROM ${financialLedgerEntry} l WHERE l.payment_id=p.id AND l.site_id=p.site_id AND l.account_id=p.account_id
        AND l.environment=p.environment AND l.kind='GIFT_RECEIVED') AS credited
    FROM ${giftPaymentRecord} p
    JOIN ${giftOrder} o ON o.id=p.order_id AND o.site_id=p.site_id AND o.account_id=p.account_id AND o.environment=p.environment
    JOIN ${giftQuoteRecord} q ON q.id=o.quote_id AND q.site_id=p.site_id AND q.account_id=p.account_id AND q.environment=p.environment
    WHERE p.environment=${environment} AND p.provider_payment_reference=${paymentReference}
    ${lock ? sql`FOR UPDATE OF p` : sql``}`);
  if (result.rows.length > 1) return fail("PAYMENT_NOT_FOUND");
  return storeRow(result.rows[0] as Json | undefined);
}

/** Drizzle-backed store; the transaction locks the payment row. */
export function createSplitDivergenceStore(
  db: Pick<DatabaseConnection["db"], "execute" | "transaction">,
  environment: "sandbox" | "live",
): SplitDivergenceStore {
  return {
    load: (paymentReference) =>
      loadRecord(db, environment, paymentReference, false),
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          load: (paymentReference) =>
            loadRecord(tx, environment, paymentReference, true),
          async recordTopUp(stored, topUpCents) {
            const updated =
              await tx.execute(sql`UPDATE ${giftPaymentRecord} SET platform_adjustment_cents=${topUpCents}
              WHERE id=${stored.paymentId} AND site_id=${stored.siteId} AND account_id=${stored.accountId}
                AND environment=${environment} AND platform_adjustment_cents IS NULL RETURNING id`);
            return (
              updated.rows.length === 1 &&
              updated.rows[0]?.id === stored.paymentId
            );
          },
          resolveAlert: (paymentReference, note) =>
            resolveFinancialOperatorAlert(tx, {
              environment,
              kind: "SPLIT_DIVERGENCE_BLOCK",
              paymentReference,
              note,
            }),
        }),
      ),
  };
}
