import { createHash, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseConnection } from "@entrelacos/database";
import { sql } from "drizzle-orm";
import {
  type AsaasTransferObservation,
  readAsaasTransferBankAccount,
} from "./asaasHttpClient";
import { captureAsaasWithdrawalTransfer } from "./asaasTransferClient";
import { parseBrlCents } from "./giftMoney";
import type { ReceivingTransaction } from "./receivingRepository";
import {
  captureDispatchFence,
  captureOriginalWithdrawal,
  type DispatchFence,
  type OriginalWithdrawal,
  withdrawalInstant,
} from "./withdrawalExecution";

export interface AsaasWithdrawalAuthorizationReceiver {
  receive(
    token: string,
    rawBody: string,
  ): Promise<{ status: "APPROVED" | "REFUSED" }>;
}
interface AuthorizationOptions {
  mode: "disabled" | "sandbox";
  applicationEnvironment: "development" | "test" | "production";
  token: string;
  now(): Date;
  verifyConsentInTransaction(
    tx: ReceivingTransaction,
    original: OriginalWithdrawal,
  ): Promise<void>;
}
function unavailable(): never {
  throw new TypeError("Withdrawal authorization unavailable");
}
function object(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    unavailable();
  return input as Record<string, unknown>;
}
function canonical(input: unknown): string {
  if (input === null || typeof input !== "object") return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
  const raw = object(input);
  return `{${Object.keys(raw)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(raw[key])}`)
    .join(",")}}`;
}
function hash(input: unknown): string {
  return createHash("sha256").update(canonical(input)).digest("hex");
}
function keyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// Reject duplicate keys, including escaped duplicates, before interpreting financial data.
function decode(text: string): unknown {
  if (typeof text !== "string" || Buffer.byteLength(text) > 65536)
    unavailable();
  let position = 0;
  const space = () => {
    while (/[\x20\t\r\n]/.test(text[position] ?? "") && position < text.length)
      position++;
  };
  function string(): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: JSON strings must reject literal control characters.
    const token = /^"(?:[^"\\\x00-\x1f]|\\["\\/bfnrt]|\\u[\da-fA-F]{4})*"/.exec(
      text.slice(position),
    )?.[0];
    if (!token) unavailable();
    position += token.length;
    return JSON.parse(token) as string;
  }
  function value(key = "", depth = 0): unknown {
    if (depth > 12) unavailable();
    space();
    if (text[position] === '"') return string();
    if (text[position] === "{") {
      position++;
      space();
      const result = Object.create(null) as Record<string, unknown>;
      if (text[position] === "}") {
        position++;
        return result;
      }
      for (let keys = 0; keys < 128; keys++) {
        space();
        const name = string();
        space();
        if (Object.hasOwn(result, name) || text[position++] !== ":")
          unavailable();
        result[name] = value(name, depth + 1);
        space();
        const next = text[position++];
        if (next === "}") return result;
        if (next !== ",") unavailable();
      }
      unavailable();
    }
    if (text[position] === "[") {
      position++;
      space();
      const result: unknown[] = [];
      if (text[position] === "]") {
        position++;
        return result;
      }
      for (let entries = 0; entries < 128; entries++) {
        result.push(value("", depth + 1));
        space();
        const next = text[position++];
        if (next === "]") return result;
        if (next !== ",") unavailable();
      }
      unavailable();
    }
    const token =
      /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(
        text.slice(position),
      )?.[0];
    if (!token) unavailable();
    position += token.length;
    if (["value", "netValue", "transferFee"].includes(key)) {
      if (!/^(0|[1-9]\d*)(?:\.\d{1,2})?$/.test(token)) unavailable();
      return parseBrlCents(token);
    }
    return JSON.parse(token) as unknown;
  }
  const result = value();
  space();
  if (position !== text.length) unavailable();
  return result;
}
interface CandidatePayload {
  version: 1;
  original: OriginalWithdrawal;
  fence: DispatchFence;
  pixKeyHash: string;
  bankAccountHash: string;
}
function captureCandidate(row: Record<string, unknown>): CandidatePayload {
  const raw = object(row.payload);
  const original = captureOriginalWithdrawal(raw.original);
  const fence = captureDispatchFence(raw.fence, original);
  const c = original.correlation;
  if (
    raw.version !== 1 ||
    row.environment !== "sandbox" ||
    c.environment !== "sandbox" ||
    row.siteId !== c.siteId ||
    row.accountId !== c.accountId ||
    row.operationId !== c.operationId ||
    typeof row.providerReference !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(row.providerReference) ||
    typeof raw.pixKeyHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw.pixKeyHash) ||
    typeof raw.bankAccountHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw.bankAccountHash)
  )
    unavailable();
  const result = {
    version: 1 as const,
    original,
    fence,
    pixKeyHash: raw.pixKeyHash,
    bankAccountHash: raw.bankAccountHash,
  };
  if (
    row.payloadHash !== hash(result) ||
    !isDeepStrictEqual(raw, JSON.parse(JSON.stringify(result)))
  )
    unavailable();
  return result;
}
export function createAsaasWithdrawalAuthorization(
  db: Pick<DatabaseConnection["db"], "transaction">,
  options: AuthorizationOptions,
): AsaasWithdrawalAuthorizationReceiver & {
  recordCandidateInTransaction(
    tx: ReceivingTransaction,
    original: OriginalWithdrawal,
    fence: DispatchFence,
    observation: AsaasTransferObservation,
    key: { key: string; type: string; reviewedMaskedCpfCnpj: string },
  ): Promise<void>;
} {
  const expectedToken = createHash("sha256").update(options.token).digest();
  const enabled =
    options.mode === "sandbox" &&
    ["development", "test"].includes(options.applicationEnvironment) &&
    /^[\x21-\x7e]{32,255}$/.test(options.token);
  async function readCandidate(
    tx: ReceivingTransaction,
    reference: string,
    lock = false,
  ) {
    const result = await tx.execute(
      sql`SELECT environment,provider_reference AS "providerReference",site_id AS "siteId",account_id AS "accountId",operation_id AS "operationId",payload_hash AS "payloadHash",payload FROM withdrawal_authorization_candidate WHERE environment='sandbox' AND provider_reference=${reference} ${lock ? sql`FOR UPDATE` : sql``}`,
    );
    if (result.rows.length !== 1) unavailable();
    const row = object(result.rows[0]);
    if (row.providerReference !== reference) unavailable();
    return { row, candidate: captureCandidate(row) };
  }
  return {
    async recordCandidateInTransaction(
      tx,
      originalInput,
      fenceInput,
      observationInput,
      key,
    ) {
      if (!enabled) unavailable();
      const original = captureOriginalWithdrawal(originalInput);
      const fence = captureDispatchFence(fenceInput, original);
      const observation = captureAsaasWithdrawalTransfer(
        original,
        observationInput,
        options.now(),
      );
      const c = original.correlation;
      const bank = readAsaasTransferBankAccount(
        observation.transfer.bankAccount,
      );
      const payout = original.consent.snapshot.presentation.payout;
      const taxId = bank.cpfCnpj;
      const masked = /^\d{11}$/.test(taxId)
        ? `***.${taxId.slice(3, 6)}.${taxId.slice(6, 9)}-**`
        : /^\d{14}$/.test(taxId)
          ? `**.***.${taxId.slice(5, 8)}/****-**`
          : /^[\d.*\-/ ]+$/.test(taxId) && taxId.includes("*")
            ? taxId
            : null;
      if (
        !payout ||
        bank.pixAddressKey !== key.key ||
        payout.keyType !== key.type ||
        bank.ownerName !== payout.ownerName ||
        masked === null ||
        masked !== key.reviewedMaskedCpfCnpj ||
        observation.transfer.status !== "PENDING"
      )
        unavailable();
      const payload: CandidatePayload = {
        version: 1,
        original,
        fence,
        pixKeyHash: keyHash(key.key),
        bankAccountHash: hash(bank),
      };
      const payloadHash = hash(payload);
      await tx.execute(
        sql`INSERT INTO withdrawal_authorization_candidate (environment,provider_reference,site_id,account_id,operation_id,payload_hash,payload) VALUES ('sandbox',${observation.transfer.id},${c.siteId},${c.accountId},${c.operationId},${payloadHash},${JSON.stringify(payload)}::jsonb) ON CONFLICT DO NOTHING`,
      );
      const retained = await readCandidate(tx, observation.transfer.id);
      if (retained.row.payloadHash !== payloadHash) unavailable();
    },
    async receive(token, rawBody) {
      try {
        if (
          !enabled ||
          typeof token !== "string" ||
          token.length > 255 ||
          !timingSafeEqual(
            expectedToken,
            createHash("sha256").update(token).digest(),
          )
        )
          unavailable();
        const body = object(decode(rawBody));
        if (
          body.type !== "TRANSFER" ||
          Object.keys(body).some((key) => !["type", "transfer"].includes(key))
        )
          unavailable();
        const transfer = object(body.transfer);
        if (
          transfer.object !== "transfer" ||
          transfer.status !== "PENDING" ||
          transfer.type !== "BANK_ACCOUNT" ||
          transfer.operationType !== "PIX" ||
          typeof transfer.id !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(transfer.id)
        )
          unavailable();
        const bank = readAsaasTransferBankAccount(transfer.bankAccount);
        if (!bank.pixAddressKey) unavailable();
        // The decision commits before APPROVED is returned. No monetary state is written here.
        return await db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL lock_timeout = '1000ms'`);
          await tx.execute(sql`SET LOCAL statement_timeout = '2000ms'`);
          const { candidate } = await readCandidate(
            tx,
            transfer.id as string,
            true,
          );
          const { original, fence } = candidate;
          const c = original.correlation;
          if (
            transfer.value !== c.netCents ||
            transfer.netValue !== c.netCents ||
            transfer.transferFee !== 0 ||
            c.netCents > c.amountCents ||
            candidate.pixKeyHash !== keyHash(bank.pixAddressKey as string) ||
            candidate.bankAccountHash !== hash(bank) ||
            (transfer.externalReference !== undefined &&
              transfer.externalReference !== c.operationId) ||
            ["accountId", "siteId", "accountReference", "environment"].some(
              (key) => Object.hasOwn(transfer, key),
            )
          )
            unavailable();
          const payloadHash = hash({
            candidateHash: hash(candidate),
            transferId: transfer.id,
            value: transfer.value,
            netValue: transfer.netValue,
            transferFee: transfer.transferFee,
            bankAccountHash: hash(bank),
          });
          const existing = await tx.execute(
            sql`SELECT payload_hash AS "payloadHash",status FROM withdrawal_authorization_decision WHERE environment='sandbox' AND provider_reference=${transfer.id}`,
          );
          if (existing.rows.length !== 0) {
            const prior = object(existing.rows[0]);
            if (
              existing.rows.length !== 1 ||
              prior.payloadHash !== payloadHash ||
              prior.status !== "APPROVED"
            )
              unavailable();
            return { status: "APPROVED" as const };
          }
          await options.verifyConsentInTransaction(tx, original);
          const operation = await tx.execute(
            sql`SELECT op.request_hash AS "requestHash",op.request_snapshot AS "requestSnapshot",op.state,op.attempts,op.lease_owner AS "leaseOwner",op.lease_token AS "leaseToken",op.lease_expires_at AS "leaseExpiresAt",op.provider_operation_reference AS "providerReference",w.provider_reference AS "withdrawalProviderReference",w.state AS "withdrawalState",w.reservation_state AS "reservationState",w.reserved_cents AS "reservedCents",r.id AS "consentId",r.preview_snapshot AS "consentSnapshot",r.preview_hash AS "consentHash",r.state AS "consentState",r.request_revision::text AS "requestRevision",r.sealed_at AS "sealedAt" FROM financial_operation op JOIN withdrawal_intent w ON w.id=op.withdrawal_intent_id AND w.site_id=op.site_id AND w.account_id=op.account_id AND w.environment=op.environment JOIN withdrawal_request r ON r.id=${original.associationId} AND r.withdrawal_intent_id=w.id AND r.site_id=w.site_id AND r.account_id=w.account_id AND r.environment=w.environment AND r.request_id=op.request_id WHERE op.id=${c.operationId} AND op.site_id=${c.siteId} AND op.account_id=${c.accountId} AND op.environment='sandbox' AND op.kind='WITHDRAWAL' AND op.withdrawal_intent_id=${c.withdrawalId} AND op.request_id=${c.requestId} AND w.request_id=${c.requestId} AND w.request_hash=${c.requestHash} AND w.operator_user_id=${c.operatorUserId} AND w.destination_version=${c.destinationVersion} AND w.amount_cents=${c.amountCents} AND w.fee_cents=${c.feeCents} AND w.net_cents=${c.netCents} AND w.currency='BRL' AND w.authorization_reference=${original.snapshot.authenticationAuditHash} AND w.policy_version=${c.policyVersion} AND r.operator_user_id=${c.operatorUserId} AND r.destination_version=${c.destinationVersion} FOR UPDATE OF op,w,r`,
          );
          if (operation.rows.length !== 1) unavailable();
          const op = object(operation.rows[0]);
          if (
            op.requestHash !== c.requestHash ||
            !isDeepStrictEqual(
              op.requestSnapshot,
              JSON.parse(JSON.stringify(original.snapshot)),
            ) ||
            op.state !== "PROCESSING" ||
            op.withdrawalState !== "PROCESSING" ||
            op.reservationState !== "HELD" ||
            Number(op.reservedCents) !== c.amountCents ||
            op.attempts !== 1 ||
            op.leaseOwner !== fence.leaseOwner ||
            op.leaseToken !== fence.leaseToken ||
            withdrawalInstant(op.leaseExpiresAt) !== fence.leaseExpiresAt ||
            [op.providerReference, op.withdrawalProviderReference].some(
              (reference) => reference !== null && reference !== transfer.id,
            ) ||
            op.consentId !== original.associationId ||
            op.consentState !== "COMMITTED" ||
            op.consentHash !== original.consent.previewHash ||
            op.requestRevision !== original.consent.requestRevision ||
            op.sealedAt !== null ||
            !isDeepStrictEqual(
              op.consentSnapshot,
              JSON.parse(JSON.stringify(original.consent.snapshot)),
            )
          )
            unavailable();
          await tx.execute(
            sql`INSERT INTO withdrawal_authorization_decision (environment,provider_reference,payload_hash,status) VALUES ('sandbox',${transfer.id},${payloadHash},'APPROVED')`,
          );
          return { status: "APPROVED" as const };
        });
      } catch {
        return { status: "REFUSED" };
      }
    },
  };
}
