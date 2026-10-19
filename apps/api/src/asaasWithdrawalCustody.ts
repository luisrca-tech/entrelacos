import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseConnection } from "@entrelacos/database";
import {
  financialOperation,
  withdrawalProviderObservation,
} from "@entrelacos/database/schema";
import { sql } from "drizzle-orm";
import type { AsaasTransferObservation } from "./asaasHttpClient";
import {
  type AsaasWithdrawalCustody,
  captureAsaasWithdrawalTransfer,
} from "./asaasTransferClient";
import type { ReceivingTransaction } from "./receivingRepository";
import {
  captureDispatchFence,
  captureOriginalWithdrawal,
  captureWithdrawalValue,
  type DispatchFence,
  type OriginalWithdrawal,
  type WithdrawalCompletionProof,
  withdrawalInstant,
} from "./withdrawalExecution";

export interface AsaasWithdrawalCustodyOptions {
  mode: "disabled" | "sandbox";
  applicationEnvironment: "development" | "test" | "production";
  now(): Date;
}
type CustodyDatabase = Pick<DatabaseConnection["db"], "transaction">;
function unavailable(): never {
  throw new TypeError("Withdrawal provider custody unavailable");
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
  observation: AsaasTransferObservation,
) {
  return JSON.parse(
    canonical({ version: 1, original, fence, observation }),
  ) as Record<string, unknown>;
}
function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function createAsaasWithdrawalCustody(
  db: CustodyDatabase,
  options: AsaasWithdrawalCustodyOptions,
): AsaasWithdrawalCustody & {
  loadCompletionProofInTransaction(
    tx: ReceivingTransaction,
    original: OriginalWithdrawal,
    fence: DispatchFence,
    reference: string,
  ): Promise<WithdrawalCompletionProof | null>;
} {
  const mode = options.mode;
  const applicationEnvironment = options.applicationEnvironment;
  const now = options.now;
  function inputs(
    originalInput: OriginalWithdrawal,
    fenceInput: DispatchFence,
  ) {
    const original = captureOriginalWithdrawal(originalInput);
    const fence = captureDispatchFence(fenceInput, original);
    if (
      mode !== "sandbox" ||
      !["development", "test"].includes(applicationEnvironment) ||
      original.correlation.environment !== "sandbox"
    )
      unavailable();
    return { original, fence };
  }
  async function read(
    tx: ReceivingTransaction,
    original: OriginalWithdrawal,
    fence: DispatchFence,
    reference: string,
  ) {
    if (!/^asaas-transfer:[a-f0-9]{64}$/.test(reference)) unavailable();
    const c = original.correlation;
    const result = await tx.execute(
      sql`SELECT id,site_id AS "siteId",account_id AS "accountId",environment,operation_id AS "operationId",provider_reference AS "providerReference",payload_hash AS "payloadHash",payload,observed_at AS "observedAt",recorded_at AS "recordedAt" FROM ${withdrawalProviderObservation} WHERE id=${reference} AND site_id=${c.siteId} AND account_id=${c.accountId} AND environment=${c.environment} AND operation_id=${c.operationId}`,
    );
    if (result.rows.length !== 1) return null;
    const row = captureWithdrawalValue(result.rows[0]) as Record<
      string,
      unknown
    >;
    const body = row.payload as {
      version: number;
      original: OriginalWithdrawal;
      fence: DispatchFence;
      observation: AsaasTransferObservation;
    };
    if (
      body?.version !== 1 ||
      row.id !== reference ||
      row.siteId !== c.siteId ||
      row.accountId !== c.accountId ||
      row.environment !== c.environment ||
      row.operationId !== c.operationId ||
      row.payloadHash !== hash(body) ||
      reference !== `asaas-transfer:${row.payloadHash}` ||
      !isDeepStrictEqual(captureOriginalWithdrawal(body.original), original) ||
      !isDeepStrictEqual(captureDispatchFence(body.fence, original), fence)
    )
      unavailable();
    const observation = captureAsaasWithdrawalTransfer(
      original,
      body.observation,
      now(),
    );
    if (
      !isDeepStrictEqual(body, payload(original, fence, observation)) ||
      row.providerReference !== observation.transfer.id ||
      withdrawalInstant(row.observedAt) !==
        withdrawalInstant(observation.observedAt) ||
      new Date(withdrawalInstant(row.recordedAt)).getTime() <
        new Date(withdrawalInstant(row.observedAt)).getTime() ||
      new Date(withdrawalInstant(row.recordedAt)).getTime() > now().getTime()
    )
      unavailable();
    return { row, observation };
  }
  return {
    async record(originalInput, fenceInput, observationInput) {
      const { original, fence } = inputs(originalInput, fenceInput);
      const observation = captureAsaasWithdrawalTransfer(
        original,
        observationInput,
        now(),
      );
      const body = payload(original, fence, observation);
      const payloadHash = hash(body);
      const reference = `asaas-transfer:${payloadHash}`;
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
            op.providerReference !== observation.transfer.id)
        )
          unavailable();
        await tx.execute(
          sql`INSERT INTO ${withdrawalProviderObservation} (id,site_id,account_id,environment,operation_id,provider_reference,payload_hash,payload,observed_at) VALUES (${reference},${c.siteId},${c.accountId},${c.environment},${c.operationId},${observation.transfer.id},${payloadHash},${JSON.stringify(body)}::jsonb,${withdrawalInstant(observation.observedAt)}::timestamptz) ON CONFLICT (id) DO NOTHING`,
        );
        const retained = await read(tx, original, fence, reference);
        if (
          !retained ||
          canonical(retained.observation) !== canonical(observation)
        )
          unavailable();
        return reference;
      });
    },
    async loadCompletionProofInTransaction(
      tx,
      originalInput,
      fenceInput,
      reference,
    ) {
      try {
        const { original, fence } = inputs(originalInput, fenceInput);
        const stored = await read(tx, original, fence, reference);
        if (stored?.observation.transfer.status !== "DONE") return null;
        return {
          outcome: "COMPLETED",
          correlation: original.correlation,
          holderBinding: original.holderBinding,
          fence,
          proofReference: reference,
          receiptReference: reference,
          providerReference: stored.observation.transfer.id,
          totalDebitCents: original.correlation.netCents,
          feeCents: 0,
          netCents: original.correlation.netCents,
          currency: "BRL",
          bankCompleted: true,
          custody: "immutable-durable",
          verification: "verified",
          provenance: "provider",
          observedAt: withdrawalInstant(stored.observation.observedAt),
          recordedAt: withdrawalInstant(stored.row.recordedAt),
        };
      } catch {
        return null;
      }
    },
  };
}
