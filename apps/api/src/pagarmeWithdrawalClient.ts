import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseConnection } from "@entrelacos/database";
import {
  financialOperation,
  withdrawalProviderObservation,
} from "@entrelacos/database/schema";
import { sql } from "drizzle-orm";
import { databaseTimestampEpochMicroseconds } from "./databaseTimestamp";
import { PagarmeRejectedError } from "./pagarmeHttpClient";
import {
  PAGARME_WITHDRAWAL_FEE_CENTS,
  type PagarmeRecipientBalance,
  type PagarmeRecipientClient,
  type PagarmeWithdrawal,
  pagarmeWithdrawalStatuses,
  pagarmeWithdrawalTransferCents,
} from "./pagarmeRecipientClient";
import type { ReceivingTransaction } from "./receivingRepository";
import {
  captureDispatchFence,
  captureOriginalWithdrawal,
  type DispatchFence,
  type OriginalWithdrawal,
  type WithdrawalCompletionProof,
  type WithdrawalCorrelation,
  type WithdrawalDispatchObservation,
  type WithdrawalDispatchPort,
  type WithdrawalLookupPort,
  type WithdrawalTerminalFailureProof,
  withdrawalInstant,
} from "./withdrawalExecution";

/** Fixed-fee policy recorded on every Pagar.me withdrawal intent. */
export const PAGARME_WITHDRAWAL_POLICY_VERSION = `pagarme-withdrawal-fixed-v1-${PAGARME_WITHDRAWAL_FEE_CENTS}`;
const observationReference = /^pagarme-withdrawal:[a-f0-9]{64}$/;
// Assumed lower bound of Pagar.me idempotency-key retention. [To confirm in sandbox]
const defaultReplayWindowMs = 60 * 60_000;

/** Provider-neutral available balance used by withdrawals and the overview. */
export interface ProviderBalanceObservation {
  source: "provider";
  provider: "PAGARME";
  siteId: string;
  accountBindingId: string;
  accountReference: string;
  environment: "sandbox" | "live";
  currency: "BRL";
  observedAt: Date;
  balanceCents: number;
}

/** Only `available_amount` can be withdrawn; waiting funds never count. */
export function readPagarmeBalanceObservation(
  binding: {
    siteId: string;
    accountBindingId: string;
    accountReference: string;
    environment: "sandbox" | "live";
  },
  balance: PagarmeRecipientBalance,
  observedAt: Date,
): ProviderBalanceObservation {
  if (
    !Number.isSafeInteger(balance.availableCents) ||
    balance.availableCents < 0
  )
    unavailable();
  return {
    source: "provider",
    provider: "PAGARME",
    siteId: binding.siteId,
    accountBindingId: binding.accountBindingId,
    accountReference: binding.accountReference,
    environment: binding.environment,
    currency: "BRL",
    observedAt,
    balanceCents: balance.availableCents,
  };
}

/**
 * Local reference of a withdrawal Pagar.me refused outright (4xx): no
 * provider withdrawal exists, so the hold is released with a failure proof
 * bound to this command instead of waiting for a lookup that can never match.
 */
const rejectedWithdrawalReference = /^rejected_[a-f0-9]{32}$/;
/** 4xx that answer the command itself; auth, conflict and throttling do not. */
const definitiveRejections = new Set([400, 404, 412, 422]);

/** One key per withdrawal operation; every retry of it reuses the key. */
export function pagarmeWithdrawalIdempotencyKey(
  correlation: Pick<WithdrawalCorrelation, "operationId">,
): string {
  return `withdrawal:${correlation.operationId}`;
}

export interface PagarmeWithdrawalObservation {
  source: "provider";
  provider: "PAGARME";
  siteId: string;
  accountBindingId: string;
  accountReference: string;
  environment: "sandbox" | "live";
  observedAt: string;
  withdrawal: PagarmeWithdrawal;
}

export interface PagarmeWithdrawalCustody {
  record(
    original: OriginalWithdrawal,
    fence: DispatchFence,
    observation: PagarmeWithdrawalObservation,
  ): Promise<string>;
}

type Mode = "disabled" | "sandbox" | "live";
type ApplicationEnvironment = "development" | "test" | "production";

function unavailable(): never {
  throw new TypeError("Pagar.me withdrawal unavailable");
}

function supported(mode: Mode, applicationEnvironment: ApplicationEnvironment) {
  return (
    (mode === "sandbox" &&
      ["development", "test"].includes(applicationEnvironment)) ||
    (mode === "live" && applicationEnvironment === "production")
  );
}

function inputs(
  mode: Mode,
  applicationEnvironment: ApplicationEnvironment,
  originalInput: OriginalWithdrawal,
  fenceInput: DispatchFence,
) {
  const original = captureOriginalWithdrawal(originalInput);
  const fence = captureDispatchFence(fenceInput, original);
  const c = original.correlation;
  if (
    !supported(mode, applicationEnvironment) ||
    c.environment !== mode ||
    c.policyVersion !== PAGARME_WITHDRAWAL_POLICY_VERSION ||
    c.feeCents !== PAGARME_WITHDRAWAL_FEE_CENTS ||
    c.netCents !== pagarmeWithdrawalTransferCents(c.amountCents)
  )
    unavailable();
  return { original, fence };
}

/** Validates that a provider withdrawal belongs to this exact original command. */
export function capturePagarmeWithdrawal(
  original: OriginalWithdrawal,
  input: PagarmeWithdrawalObservation,
  now: Date,
): PagarmeWithdrawalObservation {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) unavailable();
  const c = original.correlation;
  const w = input?.withdrawal;
  if (
    input?.source !== "provider" ||
    input.provider !== "PAGARME" ||
    input.siteId !== c.siteId ||
    input.accountBindingId !== c.accountId ||
    input.accountReference !== c.accountReference ||
    input.environment !== c.environment ||
    !w ||
    typeof w.id !== "string" ||
    !(
      /^(?:with|tran)_[A-Za-z0-9]{1,128}$/.test(w.id) ||
      (rejectedWithdrawalReference.test(w.id) && w.status === "failed")
    ) ||
    w.amountCents !== pagarmeWithdrawalTransferCents(c.amountCents) ||
    w.amountCents !== c.netCents ||
    !(pagarmeWithdrawalStatuses as readonly string[]).includes(w.status) ||
    typeof w.updatedAt !== "string"
  )
    unavailable();
  const observedAt = withdrawalInstant(input.observedAt);
  const updatedAt = withdrawalInstant(w.updatedAt);
  if (
    Date.parse(observedAt) > now.getTime() ||
    Date.parse(observedAt) < Date.parse(original.snapshot.intent.createdAt)
  )
    unavailable();
  return {
    source: "provider",
    provider: "PAGARME",
    siteId: c.siteId,
    accountBindingId: c.accountId,
    accountReference: c.accountReference,
    environment: c.environment,
    observedAt,
    withdrawal: {
      id: w.id,
      amountCents: w.amountCents,
      status: w.status,
      updatedAt,
    },
  };
}

export interface PagarmeWithdrawalAdapterOptions {
  mode: Mode;
  applicationEnvironment: ApplicationEnvironment;
  now(): Date;
  client: Pick<PagarmeRecipientClient, "createWithdrawal" | "getWithdrawal">;
  custody: PagarmeWithdrawalCustody;
  /**
   * Runs the provider POST under the composition's current dispatch authority
   * (locks, lease and balance), releasing them only after the response.
   */
  guardDispatch?(
    original: OriginalWithdrawal,
    fence: DispatchFence,
    send: () => Promise<PagarmeWithdrawal>,
  ): Promise<PagarmeWithdrawal>;
  /** How long after creation an unknown dispatch may be replayed. */
  replayWindowMs?: number;
}

export function createPagarmeWithdrawalAdapter(
  options: PagarmeWithdrawalAdapterOptions,
): WithdrawalDispatchPort & WithdrawalLookupPort {
  const { mode, applicationEnvironment, now, client } = options;
  const record = options.custody.record.bind(options.custody);
  const guard =
    options.guardDispatch ??
    ((_original, _fence, send: () => Promise<PagarmeWithdrawal>) => send());
  const replayWindowMs = options.replayWindowMs ?? defaultReplayWindowMs;
  async function send(
    original: OriginalWithdrawal,
  ): Promise<PagarmeWithdrawal> {
    const c = original.correlation;
    const key = pagarmeWithdrawalIdempotencyKey(c);
    try {
      return await client.createWithdrawal(
        c.accountReference,
        pagarmeWithdrawalTransferCents(c.amountCents),
        key,
      );
    } catch (error) {
      if (
        !(error instanceof PagarmeRejectedError) ||
        !definitiveRejections.has(error.status)
      )
        throw error;
      return {
        id: `rejected_${createHash("sha256").update(key).digest("hex").slice(0, 32)}`,
        amountCents: pagarmeWithdrawalTransferCents(c.amountCents),
        status: "failed",
        updatedAt: now().toISOString(),
      };
    }
  }
  async function observe(
    original: OriginalWithdrawal,
    fence: DispatchFence,
    withdrawal: PagarmeWithdrawal,
  ): Promise<WithdrawalDispatchObservation> {
    const c = original.correlation;
    const observation = capturePagarmeWithdrawal(
      original,
      {
        source: "provider",
        provider: "PAGARME",
        siteId: c.siteId,
        accountBindingId: c.accountId,
        accountReference: c.accountReference,
        environment: c.environment,
        observedAt: now().toISOString(),
        withdrawal,
      },
      now(),
    );
    const reference = await record(original, fence, observation);
    if (!observationReference.test(reference)) unavailable();
    const identity = {
      correlation: original.correlation,
      holderBinding: original.holderBinding,
      fence,
    };
    const status = observation.withdrawal.status;
    if (status === "failed" || status === "canceled")
      return {
        ...identity,
        outcome: "REJECTED",
        reason:
          status === "failed"
            ? "PAGARME_WITHDRAWAL_FAILED"
            : "PAGARME_WITHDRAWAL_CANCELLED",
        proofReference: reference,
        providerReference: observation.withdrawal.id,
        observedAt: observation.observedAt,
      };
    return {
      ...identity,
      outcome: "ACCEPTED",
      providerReference: observation.withdrawal.id,
      observedAt: observation.observedAt,
      proofReference: status === "transferred" ? reference : null,
    };
  }
  return {
    async dispatch(originalInput, fenceInput) {
      const unresolved = {
        outcome: "UNRESOLVED" as const,
        correlation: originalInput.correlation,
        holderBinding: originalInput.holderBinding,
        fence: fenceInput,
      };
      try {
        const { original, fence } = inputs(
          mode,
          applicationEnvironment,
          originalInput,
          fenceInput,
        );
        if (Date.parse(fence.leaseExpiresAt) <= now().getTime()) unavailable();
        const withdrawal = await guard(original, fence, () => {
          if (Date.parse(fence.leaseExpiresAt) <= now().getTime())
            unavailable();
          return send(original);
        });
        return await observe(original, fence, withdrawal);
      } catch {
        // An unknown or unverifiable outcome keeps the hold for lookup.
        return unresolved;
      }
    },
    async lookup(originalInput, fenceInput, providerReference) {
      try {
        const { original, fence } = inputs(
          mode,
          applicationEnvironment,
          originalInput,
          fenceInput,
        );
        const c = original.correlation;
        let withdrawal: PagarmeWithdrawal;
        if (
          providerReference !== null &&
          rejectedWithdrawalReference.test(providerReference)
        )
          return { outcome: "UNRESOLVED" };
        if (providerReference !== null) {
          withdrawal = await client.getWithdrawal(
            c.accountReference,
            providerReference,
          );
          if (withdrawal.id !== providerReference) unavailable();
        } else {
          // The POST response was lost: replaying the same idempotent command
          // returns the original withdrawal instead of creating another one.
          if (
            now().getTime() - Date.parse(original.snapshot.intent.createdAt) >
            replayWindowMs
          )
            return { outcome: "UNRESOLVED" };
          withdrawal = await send(original);
        }
        return {
          outcome: "FOUND",
          observation: await observe(original, fence, withdrawal),
        };
      } catch {
        return { outcome: "UNRESOLVED" };
      }
    },
  };
}

function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(withdrawalInstant(value));
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}
function payload(
  original: OriginalWithdrawal,
  fence: DispatchFence,
  observation: PagarmeWithdrawalObservation,
) {
  return JSON.parse(
    canonical({ version: 1, original, fence, observation }),
  ) as Record<string, unknown>;
}
function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

// Bounded waits keep custody timestamps monotonic between Node and SQL clocks.
function acceptanceClock(now: () => Date) {
  const started = performance.now();
  if (!Number.isFinite(started)) unavailable();
  let previousElapsed = 0;
  let previousNode: bigint | null = null;
  return {
    elapsed() {
      const value = performance.now() - started;
      if (!Number.isFinite(value) || value < previousElapsed || value > 1250)
        unavailable();
      previousElapsed = value;
      return value;
    },
    nodeNow() {
      const value = now();
      const current = databaseTimestampEpochMicroseconds(value);
      if (previousNode !== null && current < previousNode) unavailable();
      previousNode = current;
      return value;
    },
  };
}
type AcceptanceClock = ReturnType<typeof acceptanceClock>;

async function waitForObservationClock(
  tx: ReceivingTransaction,
  observedAt: string,
  clock: AcceptanceClock,
): Promise<void> {
  const observed = databaseTimestampEpochMicroseconds(observedAt);
  let previousSql: bigint | null = null;
  for (let sample = 0; sample < 3; sample++) {
    const result = await tx.execute(
      sql`SELECT clock_timestamp()::text AS "currentTime"`,
    );
    const spent = clock.elapsed();
    if (result.rows.length !== 1) unavailable();
    const current = databaseTimestampEpochMicroseconds(
      (result.rows[0] as { currentTime: unknown }).currentTime,
    );
    if (previousSql !== null && current <= previousSql) unavailable();
    const lag = observed - current;
    if (lag <= 0n) return;
    if (lag > 1_000_000n || sample === 2) unavailable();
    const delay = Number((lag + 999n) / 1000n) + 10;
    if (spent + delay > 1250) unavailable();
    previousSql = current;
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    clock.elapsed();
    clock.nodeNow();
  }
}

async function waitForRecordedClock(
  recorded: bigint,
  clock: AcceptanceClock,
): Promise<void> {
  let previousNode: bigint | null = null;
  for (let sample = 0; sample < 3; sample++) {
    const spent = clock.elapsed();
    const current = databaseTimestampEpochMicroseconds(clock.nodeNow());
    if (previousNode !== null && current <= previousNode) unavailable();
    const lag = recorded - current;
    if (lag <= 0n) return;
    if (lag > 1_000_000n || sample === 2) unavailable();
    const delay = Number((lag + 999n) / 1000n) + 10;
    if (spent + delay > 1250) unavailable();
    previousNode = current;
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
}

export interface PagarmeWithdrawalCustodyOptions {
  mode: Mode;
  applicationEnvironment: ApplicationEnvironment;
  now(): Date;
}

/**
 * Immutable provider evidence. Rows are append-only and content addressed:
 * `pagarme-withdrawal:<sha256 of the canonical payload>`.
 */
export function createPagarmeWithdrawalCustody(
  db: Pick<DatabaseConnection["db"], "transaction">,
  options: PagarmeWithdrawalCustodyOptions,
): PagarmeWithdrawalCustody & {
  loadTerminalFailureInTransaction(
    tx: ReceivingTransaction,
    original: OriginalWithdrawal,
    fence: DispatchFence,
    reference: string,
  ): Promise<WithdrawalTerminalFailureProof | null>;
  loadCompletionProofInTransaction(
    tx: ReceivingTransaction,
    original: OriginalWithdrawal,
    fence: DispatchFence,
    reference: string,
  ): Promise<WithdrawalCompletionProof | null>;
} {
  const { mode, applicationEnvironment, now } = options;
  async function read(
    tx: ReceivingTransaction,
    original: OriginalWithdrawal,
    fence: DispatchFence,
    reference: string,
    clock = acceptanceClock(now),
  ) {
    if (!observationReference.test(reference)) unavailable();
    const c = original.correlation;
    const result = await tx.execute(
      sql`SELECT id,site_id AS "siteId",account_id AS "accountId",environment,operation_id AS "operationId",provider_reference AS "providerReference",payload_hash AS "payloadHash",payload,observed_at AS "observedAt",recorded_at::text AS "recordedAt",clock_timestamp()::text AS "readAt" FROM ${withdrawalProviderObservation} WHERE id=${reference} AND site_id=${c.siteId} AND account_id=${c.accountId} AND environment=${c.environment} AND operation_id=${c.operationId}`,
    );
    clock.elapsed();
    if (result.rows.length !== 1) return null;
    const row = result.rows[0] as Record<string, unknown>;
    const body = row.payload as {
      version: number;
      original: OriginalWithdrawal;
      fence: DispatchFence;
      observation: PagarmeWithdrawalObservation;
    };
    if (
      body?.version !== 1 ||
      row.id !== reference ||
      row.siteId !== c.siteId ||
      row.accountId !== c.accountId ||
      row.environment !== c.environment ||
      row.operationId !== c.operationId ||
      row.payloadHash !== hash(body) ||
      reference !== `pagarme-withdrawal:${row.payloadHash}` ||
      !isDeepStrictEqual(captureOriginalWithdrawal(body.original), original) ||
      !isDeepStrictEqual(captureDispatchFence(body.fence, original), fence)
    )
      unavailable();
    const observation = capturePagarmeWithdrawal(
      original,
      body.observation,
      clock.nodeNow(),
    );
    if (
      !isDeepStrictEqual(body, payload(original, fence, observation)) ||
      row.providerReference !== observation.withdrawal.id ||
      withdrawalInstant(row.observedAt) !== observation.observedAt ||
      databaseTimestampEpochMicroseconds(row.recordedAt) <
        databaseTimestampEpochMicroseconds(row.observedAt) ||
      databaseTimestampEpochMicroseconds(row.recordedAt) >
        databaseTimestampEpochMicroseconds(row.readAt)
    )
      unavailable();
    await waitForRecordedClock(
      databaseTimestampEpochMicroseconds(row.recordedAt),
      clock,
    );
    return { row, observation };
  }
  function identity(original: OriginalWithdrawal, fence: DispatchFence) {
    return {
      correlation: original.correlation,
      holderBinding: original.holderBinding,
      fence,
    };
  }
  return {
    async record(originalInput, fenceInput, observationInput) {
      const { original, fence } = inputs(
        mode,
        applicationEnvironment,
        originalInput,
        fenceInput,
      );
      const clock = acceptanceClock(now);
      const observation = capturePagarmeWithdrawal(
        original,
        observationInput,
        clock.nodeNow(),
      );
      const body = payload(original, fence, observation);
      const payloadHash = hash(body);
      const reference = `pagarme-withdrawal:${payloadHash}`;
      const c = original.correlation;
      return await db.transaction(async (tx) => {
        // Serialize against the original executor before accepting provider custody.
        const operation = await tx.execute(
          sql`SELECT request_hash AS "requestHash",request_snapshot AS "requestSnapshot",state,attempts,lease_owner AS "leaseOwner",lease_token AS "leaseToken",lease_expires_at AS "leaseExpiresAt",provider_operation_reference AS "providerReference" FROM ${financialOperation} WHERE id=${c.operationId} AND site_id=${c.siteId} AND account_id=${c.accountId} AND environment=${c.environment} AND kind='WITHDRAWAL' AND withdrawal_intent_id=${c.withdrawalId} FOR UPDATE`,
        );
        if (operation.rows.length !== 1) unavailable();
        const op = operation.rows[0] as Record<string, unknown>;
        if (
          op.requestHash !== c.requestHash ||
          !isDeepStrictEqual(
            op.requestSnapshot,
            JSON.parse(JSON.stringify(original.snapshot)),
          ) ||
          !["PROCESSING", "UNKNOWN", "SUCCEEDED"].includes(String(op.state)) ||
          op.attempts !== 1 ||
          op.leaseOwner !== fence.leaseOwner ||
          op.leaseToken !== fence.leaseToken ||
          withdrawalInstant(op.leaseExpiresAt) !== fence.leaseExpiresAt ||
          (op.providerReference !== null &&
            op.providerReference !== observation.withdrawal.id)
        )
          unavailable();
        await waitForObservationClock(tx, observation.observedAt, clock);
        capturePagarmeWithdrawal(original, observation, clock.nodeNow());
        await tx.execute(
          sql`INSERT INTO ${withdrawalProviderObservation} (id,site_id,account_id,environment,operation_id,provider_reference,payload_hash,payload,observed_at,recorded_at) VALUES (${reference},${c.siteId},${c.accountId},${c.environment},${c.operationId},${observation.withdrawal.id},${payloadHash},${JSON.stringify(body)}::jsonb,${observation.observedAt}::timestamptz,clock_timestamp()) ON CONFLICT (id) DO NOTHING`,
        );
        const retained = await read(tx, original, fence, reference, clock);
        if (
          !retained ||
          canonical(retained.observation) !== canonical(observation)
        )
          unavailable();
        return reference;
      });
    },
    async loadTerminalFailureInTransaction(
      tx,
      originalInput,
      fenceInput,
      reference,
    ) {
      try {
        const { original, fence } = inputs(
          mode,
          applicationEnvironment,
          originalInput,
          fenceInput,
        );
        const stored = await read(tx, original, fence, reference);
        const status = stored?.observation.withdrawal.status;
        if (!stored || (status !== "failed" && status !== "canceled"))
          return null;
        return {
          ...identity(original, fence),
          outcome: status === "failed" ? "FAILED" : "CANCELLED",
          feeCents: 0,
          proofReference: reference,
          providerReference: stored.observation.withdrawal.id,
          custody: "immutable-durable",
          verification: "verified",
          provenance: "provider",
          observedAt: stored.observation.observedAt,
          recordedAt: withdrawalInstant(stored.row.recordedAt),
        };
      } catch {
        return null;
      }
    },
    async loadCompletionProofInTransaction(
      tx,
      originalInput,
      fenceInput,
      reference,
    ) {
      try {
        const { original, fence } = inputs(
          mode,
          applicationEnvironment,
          originalInput,
          fenceInput,
        );
        const stored = await read(tx, original, fence, reference);
        if (stored?.observation.withdrawal.status !== "transferred")
          return null;
        const c = original.correlation;
        return {
          ...identity(original, fence),
          outcome: "COMPLETED",
          proofReference: reference,
          receiptReference: reference,
          providerReference: stored.observation.withdrawal.id,
          // Pagar.me debits the fixed fee on top of the transferred amount.
          totalDebitCents: c.amountCents,
          feeCents: PAGARME_WITHDRAWAL_FEE_CENTS,
          netCents: stored.observation.withdrawal.amountCents,
          currency: "BRL",
          bankCompleted: true,
          custody: "immutable-durable",
          verification: "verified",
          provenance: "provider",
          observedAt: stored.observation.observedAt,
          recordedAt: withdrawalInstant(stored.row.recordedAt),
        };
      } catch {
        return null;
      }
    },
  };
}
