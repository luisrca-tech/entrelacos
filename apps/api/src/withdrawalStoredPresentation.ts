import { siteIdSchema, withdrawalPreviewSchema } from "@entrelacos/contracts";
import {
  receivingAccount,
  receivingDestination,
  receivingVerificationEvidence,
  site,
  user,
} from "@entrelacos/database/schema";
import { sql } from "drizzle-orm";
import {
  databaseTimestampEpochMicroseconds,
  readDatabaseTimestamp,
} from "./databaseTimestamp";
import { evaluateReceivingReadiness } from "./receivingReadiness";
import type { ReceivingTransaction } from "./receivingRepository";
import type { WithdrawalStoredPresentationLoader } from "./withdrawalReservationRepository";
import type {
  WithdrawalFeeScope,
  WithdrawalPresentationScope,
  WithdrawalStoredPresentation,
  WithdrawalVerifiedPresentation,
} from "./withdrawalReservations";

export type WithdrawalStoredPresentationOptions =
  | { mode: "disabled" }
  | {
      mode: "sandbox" | "live";
      applicationEnvironment: "development" | "test" | "production";
      freshnessMs: number;
      now(): Date;
    };

const scopeKeys = [
  "siteId",
  "accountId",
  "accountReference",
  "environment",
  "bankReference",
  "destinationVersion",
];
const rowKeys = [
  "siteId",
  "isDemo",
  "accountId",
  "environment",
  "provider",
  "operatorUserId",
  "operatorReference",
  "accountReference",
  "recipientReference",
  "accountIsCurrent",
  "accountState",
  "accountReceiving",
  "accountWithdrawal",
  "accountCommercial",
  "accountObservedAt",
  "destinationId",
  "destinationVersion",
  "bankReference",
  "maskedDestination",
  "destinationIsCurrent",
  "destinationBankState",
  "profileUserId",
  "profileRole",
  "profileState",
  "operatorDisplayName",
  "operatorProfileUpdatedAt",
  "evidenceId",
  "evidenceSiteId",
  "evidenceAccountId",
  "evidenceEnvironment",
  "evidenceDestinationVersion",
  "evidenceOperatorReference",
  "evidenceAccountReference",
  "evidenceRecipientReference",
  "evidenceBankReference",
  "evidenceVerification",
  "evidenceProvenance",
  "verificationReference",
  "evidenceAccountState",
  "evidenceBankState",
  "evidenceReceiving",
  "evidenceWithdrawal",
  "evidenceCommercial",
  "evidenceObservedAt",
  "bankObservedAt",
  "evidenceCreatedAt",
];
const commonKeys = rowKeys.filter(
  (key) =>
    !key.startsWith("evidence") &&
    key !== "bankObservedAt" &&
    key !== "verificationReference",
);

function unavailable(): never {
  throw new TypeError("Stored presentation unavailable");
}

function data(
  value: unknown,
  keys?: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return unavailable();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype)
    return unavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (
    keys &&
    (names.length !== keys.length ||
      names.some((key) => typeof key !== "string" || !keys.includes(key)))
  )
    return unavailable();
  const result: Record<string, unknown> = {};
  for (const key of names) {
    if (typeof key !== "string" || !("value" in descriptors[key]))
      return unavailable();
    const field = descriptors[key].value;
    result[key] = field instanceof Date ? readDatabaseTimestamp(field) : field;
  }
  return result;
}

function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  )
    return unavailable();
  return value;
}

function reference(value: unknown): string {
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,256}$/.test(value))
    return unavailable();
  return value;
}

function storedDate(value: unknown): Date {
  const result = readDatabaseTimestamp(value);
  if (databaseTimestampEpochMicroseconds(result) < 0n) return unavailable();
  return result;
}

function clockTime(value: unknown): bigint {
  if (
    !(value instanceof Date) ||
    !Number.isSafeInteger(value.getTime()) ||
    value.getTime() < 0 ||
    value.getUTCFullYear() > 9999
  )
    return unavailable();
  return BigInt(value.getTime()) * 1000n;
}

function captureScope(
  value: unknown,
  mode: "sandbox" | "live",
): WithdrawalPresentationScope | WithdrawalFeeScope {
  const captured = data(value);
  const hasMoney = "amountCents" in captured || "currency" in captured;
  data(
    captured,
    hasMoney ? [...scopeKeys, "amountCents", "currency"] : scopeKeys,
  );
  if (
    captured.environment !== mode ||
    !Number.isSafeInteger(captured.destinationVersion) ||
    Number(captured.destinationVersion) < 1
  )
    return unavailable();
  const base: WithdrawalPresentationScope = {
    siteId: siteIdSchema.parse(captured.siteId),
    accountId: id(captured.accountId),
    accountReference: reference(captured.accountReference),
    environment: mode,
    bankReference: reference(captured.bankReference),
    destinationVersion: Number(captured.destinationVersion),
  };
  if (!hasMoney) return Object.freeze(base);
  const amount = withdrawalPreviewSchema.shape.amountCents.safeParse(
    captured.amountCents,
  );
  if (!amount.success || captured.currency !== "BRL") return unavailable();
  return Object.freeze({
    ...base,
    amountCents: amount.data,
    currency: "BRL" as const,
  });
}

function captureRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2)
    return unavailable();
  return value.map((raw) => {
    const row = data(raw, rowKeys);
    for (const key of [
      "accountObservedAt",
      "operatorProfileUpdatedAt",
      "evidenceCreatedAt",
    ])
      row[key] = storedDate(row[key]);
    return row;
  });
}

export function createWithdrawalStoredPresentationLoader(
  options: WithdrawalStoredPresentationOptions,
): WithdrawalStoredPresentationLoader {
  try {
    const configured = data(options);
    if (configured.mode === "disabled") return async () => null;
    data(configured, ["mode", "applicationEnvironment", "freshnessMs", "now"]);
    if (
      (configured.mode !== "sandbox" && configured.mode !== "live") ||
      typeof configured.applicationEnvironment !== "string" ||
      !["development", "test", "production"].includes(
        configured.applicationEnvironment,
      ) ||
      (configured.applicationEnvironment === "production" &&
        configured.mode !== "live") ||
      !Number.isSafeInteger(configured.freshnessMs) ||
      Number(configured.freshnessMs) <= 0 ||
      typeof configured.now !== "function"
    )
      return async () => null;
    const mode = configured.mode;
    const applicationEnvironment = configured.applicationEnvironment as
      | "development"
      | "test"
      | "production";
    const freshnessMs = Number(configured.freshnessMs);
    const now = configured.now.bind(Object.freeze(configured));

    function load(
      tx: ReceivingTransaction,
      scope: WithdrawalFeeScope,
    ): Promise<WithdrawalVerifiedPresentation | null>;
    function load(
      tx: ReceivingTransaction,
      scope: WithdrawalPresentationScope,
    ): Promise<WithdrawalStoredPresentation | null>;
    async function load(
      tx: ReceivingTransaction,
      input: WithdrawalPresentationScope | WithdrawalFeeScope,
    ): Promise<
      WithdrawalStoredPresentation | WithdrawalVerifiedPresentation | null
    > {
      try {
        const scope = captureScope(input, mode);
        const startedAt = clockTime(now());
        const result = await tx.execute(sql`SELECT
          st.id AS "siteId",st.is_demo AS "isDemo",a.id AS "accountId",a.environment,a.provider,
          a.operator_user_id AS "operatorUserId",a.operator_reference AS "operatorReference",a.account_reference AS "accountReference",a.recipient_reference AS "recipientReference",
          a.is_current AS "accountIsCurrent",a.provider_account_state AS "accountState",a.receiving_capability AS "accountReceiving",a.withdrawal_capability AS "accountWithdrawal",a.commercial_enabled AS "accountCommercial",a.observed_at AS "accountObservedAt",
          d.id AS "destinationId",d.version AS "destinationVersion",d.bank_reference AS "bankReference",d.masked_descriptor AS "maskedDestination",d.is_current AS "destinationIsCurrent",d.bank_state AS "destinationBankState",
          u.id AS "profileUserId",u.role AS "profileRole",u.state AS "profileState",u.name AS "operatorDisplayName",u.updated_at AS "operatorProfileUpdatedAt",
          e.id AS "evidenceId",e.site_id AS "evidenceSiteId",e.account_id AS "evidenceAccountId",e.environment AS "evidenceEnvironment",e.destination_version AS "evidenceDestinationVersion",
          e.operator_reference AS "evidenceOperatorReference",e.account_reference AS "evidenceAccountReference",e.recipient_reference AS "evidenceRecipientReference",e.bank_reference AS "evidenceBankReference",
          e.verification_status AS "evidenceVerification",e.provenance AS "evidenceProvenance",e.verification_reference AS "verificationReference",e.provider_account_state AS "evidenceAccountState",e.bank_state AS "evidenceBankState",
          e.receiving_capability AS "evidenceReceiving",e.withdrawal_capability AS "evidenceWithdrawal",e.commercial_enabled AS "evidenceCommercial",e.observed_at AS "evidenceObservedAt",e.bank_observed_at AS "bankObservedAt",e.created_at AS "evidenceCreatedAt"
          FROM ${receivingAccount} a
          JOIN ${site} st ON st.id=a.site_id
          JOIN ${receivingDestination} d ON d.site_id=a.site_id AND d.account_id=a.id AND d.environment=a.environment
          JOIN ${user} u ON u.id=a.operator_user_id
          JOIN LATERAL (SELECT ev.id,ev.site_id,ev.account_id,ev.environment,ev.destination_version,ev.operator_reference,ev.account_reference,ev.recipient_reference,ev.bank_reference,ev.verification_status,ev.provenance,ev.verification_reference,ev.provider_account_state,ev.bank_state,ev.receiving_capability,ev.withdrawal_capability,ev.commercial_enabled,ev.observed_at,ev.bank_observed_at,ev.created_at
            FROM ${receivingVerificationEvidence} ev WHERE ev.site_id=a.site_id AND ev.account_id=a.id AND ev.environment=a.environment AND ev.destination_version=d.version
            ORDER BY ev.created_at DESC,ev.id DESC LIMIT 2) e ON true
          WHERE a.site_id=${scope.siteId} AND a.id=${scope.accountId} AND a.environment=${scope.environment} AND a.account_reference=${scope.accountReference} AND a.is_current=true
            AND d.version=${scope.destinationVersion} AND d.bank_reference=${scope.bankReference} AND d.is_current=true ORDER BY e.created_at DESC,e.id DESC LIMIT 3`);
        const rows = captureRows(result.rows);
        const row = rows[0];
        const evidenceObservedAt = storedDate(row.evidenceObservedAt);
        const bankObservedAt = storedDate(row.bankObservedAt);
        const settledAt = clockTime(now());
        if (settledAt < startedAt) return null;
        for (const selected of rows) {
          for (const key of commonKeys) {
            const same =
              selected[key] instanceof Date && row[key] instanceof Date
                ? databaseTimestampEpochMicroseconds(selected[key]) ===
                  databaseTimestampEpochMicroseconds(row[key])
                : selected[key] === row[key];
            if (!same) return null;
          }
          if (
            selected.evidenceSiteId !== scope.siteId ||
            selected.evidenceAccountId !== scope.accountId ||
            selected.evidenceEnvironment !== scope.environment ||
            selected.evidenceDestinationVersion !== scope.destinationVersion
          )
            return null;
          id(selected.evidenceId);
          if (
            databaseTimestampEpochMicroseconds(selected.evidenceCreatedAt) >
            settledAt
          )
            return null;
        }
        if (
          rows[1] &&
          (rows[1].evidenceId === row.evidenceId ||
            databaseTimestampEpochMicroseconds(rows[1].evidenceCreatedAt) >=
              databaseTimestampEpochMicroseconds(row.evidenceCreatedAt))
        )
          return null;
        if (
          row.siteId !== scope.siteId ||
          row.accountId !== scope.accountId ||
          row.environment !== mode ||
          row.accountReference !== scope.accountReference ||
          row.bankReference !== scope.bankReference ||
          row.destinationVersion !== scope.destinationVersion ||
          row.provider !== "ASAAS" ||
          typeof row.isDemo !== "boolean" ||
          (mode === "live" && row.isDemo) ||
          row.accountIsCurrent !== true ||
          row.destinationIsCurrent !== true ||
          row.accountState !== "APPROVED" ||
          row.evidenceAccountState !== "APPROVED" ||
          row.destinationBankState !== "VERIFIED" ||
          row.evidenceBankState !== "VERIFIED" ||
          row.evidenceVerification !== "VERIFIED" ||
          row.profileUserId !== row.operatorUserId ||
          row.profileState !== "ACTIVE" ||
          typeof row.profileRole !== "string" ||
          !["SITE_ADMIN", "SITE_ASSISTANT"].includes(row.profileRole) ||
          row.evidenceOperatorReference !== row.operatorReference ||
          row.evidenceAccountReference !== scope.accountReference ||
          row.evidenceRecipientReference !== row.recipientReference ||
          row.evidenceBankReference !== scope.bankReference
        )
          return null;
        const operatorUserId = id(row.operatorUserId);
        const operatorReference = reference(row.operatorReference);
        const recipientReference = reference(row.recipientReference);
        const destinationId = id(row.destinationId);
        const verificationReference = reference(row.verificationReference);
        const provenance =
          row.evidenceProvenance === "PROVIDER"
            ? "provider"
            : row.evidenceProvenance === "SIMULATION"
              ? "simulation"
              : null;
        if (
          !provenance ||
          (provenance === "simulation" &&
            (mode !== "sandbox" ||
              !row.isDemo ||
              applicationEnvironment === "production"))
        )
          return null;
        const accountObservedAt = storedDate(row.accountObservedAt);
        const operatorProfileUpdatedAt = storedDate(
          row.operatorProfileUpdatedAt,
        );
        const createdAt = databaseTimestampEpochMicroseconds(
          row.evidenceCreatedAt,
        );
        for (const value of [
          accountObservedAt,
          evidenceObservedAt,
          bankObservedAt,
        ]) {
          const observed = databaseTimestampEpochMicroseconds(value);
          if (
            observed > settledAt ||
            settledAt - observed > BigInt(freshnessMs) * 1000n
          )
            return null;
        }
        if (
          databaseTimestampEpochMicroseconds(operatorProfileUpdatedAt) >
            settledAt ||
          databaseTimestampEpochMicroseconds(evidenceObservedAt) > createdAt ||
          databaseTimestampEpochMicroseconds(bankObservedAt) > createdAt
        )
          return null;
        const binding = {
          ...scope,
          provider: "ASAAS",
          operatorReference,
          recipientReference,
        };
        const readiness = evaluateReceivingReadiness({
          siteId: scope.siteId,
          isDemo: row.isDemo,
          environment: applicationEnvironment,
          mode,
          providerBinding: binding,
          evidence: {
            ...binding,
            verification: "verified",
            provenance,
            accountState: "approved",
            bankState: "verified",
            observedAt:
              accountObservedAt < evidenceObservedAt
                ? accountObservedAt
                : evidenceObservedAt,
            bankObservedAt,
            capabilities: {
              receiving:
                row.accountReceiving === true && row.evidenceReceiving === true,
              withdrawal:
                row.accountWithdrawal === true &&
                row.evidenceWithdrawal === true,
            },
            commercialEnabled:
              row.accountCommercial === true && row.evidenceCommercial === true,
          },
          now: new Date(Number(settledAt / 1000n)),
          freshnessMs,
        });
        const mask = withdrawalPreviewSchema.shape.maskedDestination.safeParse(
          row.maskedDestination,
        );
        const name =
          withdrawalPreviewSchema.shape.operatorDisplayName.safeParse(
            row.operatorDisplayName,
          );
        if (readiness.state !== "READY" || !mask.success || !name.success)
          return null;
        return Object.freeze({
          ...scope,
          source: "stored" as const,
          verification: "verified" as const,
          provenance,
          operatorUserId,
          recipientReference,
          destinationId,
          evidenceId: id(row.evidenceId),
          verificationReference,
          evidenceObservedAt,
          bankObservedAt,
          operatorProfileUpdatedAt,
          maskedDestination: mask.data,
          operatorDisplayName: name.data,
        });
      } catch {
        return null;
      }
    }
    return load;
  } catch {
    return async () => null;
  }
}
