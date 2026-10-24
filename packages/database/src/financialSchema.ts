import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  type PgTableExtraConfigValue,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { giftItem, site, user } from "./schema";

export const financialEnvironment = pgEnum("financial_environment", [
  "sandbox",
  "live",
]);
export const receivingProviderAccountState = pgEnum(
  "receiving_provider_account_state",
  [
    "UNVERIFIED",
    "ONBOARDING",
    "UNDER_REVIEW",
    "APPROVED",
    "BLOCKED",
    "SUSPENDED",
  ],
);
export const receivingBankState = pgEnum("receiving_bank_state", [
  "UNVERIFIED",
  "PENDING",
  "VERIFIED",
  "REJECTED",
]);
export const financialVerificationStatus = pgEnum(
  "financial_verification_status",
  ["UNVERIFIED", "VERIFIED"],
);
export const financialEvidenceProvenance = pgEnum(
  "financial_evidence_provenance",
  ["PROVIDER", "SIMULATION"],
);
export const giftPaymentMethod = pgEnum("gift_payment_method", [
  "PIX",
  "CREDIT_CARD",
]);
export const financialOperationKind = pgEnum("financial_operation_kind", [
  "ACCOUNT_CREATE",
  "CHECKOUT_CREATE",
  "WITHDRAWAL",
  "REFUND",
]);
export const financialOperationState = pgEnum("financial_operation_state", [
  "REQUESTED",
  "CLAIMED",
  "PROCESSING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "UNKNOWN",
]);
export const financialInboxState = pgEnum("financial_inbox_state", [
  "RECEIVED",
  "CLAIMED",
  "PROCESSED",
  "RETRY",
  "DEAD_LETTER",
]);
export const financialLedgerDirection = pgEnum("financial_ledger_direction", [
  "CREDIT",
  "DEBIT",
]);
export const withdrawalIntentState = pgEnum("withdrawal_intent_state", [
  "REQUESTED",
  "AWAITING_AUTHORIZATION",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "UNKNOWN",
]);
export const withdrawalReservationState = pgEnum(
  "withdrawal_reservation_state",
  ["HELD", "RELEASED", "CONSUMED"],
);

function scopedColumns() {
  return {
    id: text("id").primaryKey(),
    siteId: text("site_id")
      .notNull()
      .references(() => site.id, { onDelete: "restrict" }),
    accountId: text("account_id").notNull(),
    environment: financialEnvironment("environment").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  };
}

type ScopeColumns = {
  siteId: AnyPgColumn;
  accountId: AnyPgColumn;
  environment: AnyPgColumn;
};
function accountForeignKey(table: ScopeColumns, name: string) {
  return foreignKey({
    columns: [table.siteId, table.accountId, table.environment],
    foreignColumns: [
      receivingAccount.siteId,
      receivingAccount.id,
      receivingAccount.environment,
    ],
    name,
  })
    .onDelete("restrict")
    .onUpdate("restrict");
}

function destinationForeignKey(
  table: ScopeColumns & { destinationVersion: AnyPgColumn },
  name: string,
) {
  return foreignKey({
    columns: [
      table.siteId,
      table.accountId,
      table.environment,
      table.destinationVersion,
    ],
    foreignColumns: [
      receivingDestination.siteId,
      receivingDestination.accountId,
      receivingDestination.environment,
      receivingDestination.version,
    ],
    name,
  })
    .onDelete("restrict")
    .onUpdate("restrict");
}

export const receivingAccount = pgTable(
  "receiving_account",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id")
      .notNull()
      .references(() => site.id, { onDelete: "restrict" }),
    environment: financialEnvironment("environment").notNull(),
    provider: text("provider").notNull(),
    operatorUserId: text("operator_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    operatorReference: text("operator_reference"),
    accountReference: text("account_reference"),
    recipientReference: text("recipient_reference"),
    providerAccountState: receivingProviderAccountState(
      "provider_account_state",
    )
      .notNull()
      .default("UNVERIFIED"),
    receivingCapability: boolean("receiving_capability")
      .notNull()
      .default(false),
    withdrawalCapability: boolean("withdrawal_capability")
      .notNull()
      .default(false),
    commercialEnabled: boolean("commercial_enabled").notNull().default(false),
    // Current selection never establishes receiving or bank approval.
    isCurrent: boolean("is_current").notNull().default(false),
    credentialVersion: integer("credential_version"),
    credentialKeyId: text("credential_key_id"),
    credentialNonce: text("credential_nonce"),
    credentialCiphertext: text("credential_ciphertext"),
    credentialTag: text("credential_tag"),
    webhookTokenHash: text("webhook_token_hash"),
    webhookRegistration: jsonb("webhook_registration").$type<
      Record<string, unknown>
    >(),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("receiving_account_scope_key").on(
      table.siteId,
      table.id,
      table.environment,
    ),
    unique("receiving_account_provider_key").on(
      table.provider,
      table.environment,
      table.accountReference,
    ),
    unique("receiving_account_webhook_hash_key").on(table.webhookTokenHash),
    uniqueIndex("receiving_account_current_idx")
      .on(table.siteId, table.environment)
      .where(sql`${table.isCurrent} = true`),
    check(
      "receiving_account_provider_check",
      sql`length(trim(${table.provider})) BETWEEN 1 AND 64`,
    ),
    check(
      "receiving_account_references_check",
      sql`(${table.operatorReference} IS NULL OR length(trim(${table.operatorReference})) > 0) AND (${table.accountReference} IS NULL OR length(trim(${table.accountReference})) > 0) AND (${table.recipientReference} IS NULL OR length(trim(${table.recipientReference})) > 0)`,
    ),
    check(
      "receiving_account_credentials_check",
      sql`num_nonnulls(${table.credentialVersion}, ${table.credentialKeyId}, ${table.credentialNonce}, ${table.credentialCiphertext}, ${table.credentialTag}) = 0 OR (num_nonnulls(${table.credentialVersion}, ${table.credentialKeyId}, ${table.credentialNonce}, ${table.credentialCiphertext}, ${table.credentialTag}) = 5 AND ${table.credentialVersion} = 1 AND length(trim(${table.credentialKeyId})) > 0 AND length(${table.credentialNonce}) > 0 AND length(${table.credentialCiphertext}) > 0 AND length(${table.credentialTag}) > 0)`,
    ),
    check(
      "receiving_account_webhook_hash_check",
      sql`${table.webhookTokenHash} IS NULL OR ${table.webhookTokenHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const receivingDestination = pgTable(
  "receiving_destination",
  {
    ...scopedColumns(),
    version: integer("version").notNull(),
    bankReference: text("bank_reference"),
    maskedDescriptor: text("masked_descriptor"),
    bankState: receivingBankState("bank_state").notNull().default("UNVERIFIED"),
    isCurrent: boolean("is_current").notNull().default(false),
  },
  (table) => [
    unique("receiving_destination_scope_key").on(
      table.siteId,
      table.accountId,
      table.environment,
      table.id,
    ),
    unique("receiving_destination_version_key").on(
      table.siteId,
      table.accountId,
      table.environment,
      table.version,
    ),
    uniqueIndex("receiving_destination_current_idx")
      .on(table.siteId, table.accountId, table.environment)
      .where(sql`${table.isCurrent} = true`),
    accountForeignKey(table, "receiving_destination_account_fk"),
    check("receiving_destination_version_check", sql`${table.version} > 0`),
    check(
      "receiving_destination_reference_check",
      sql`${table.bankReference} IS NULL OR length(trim(${table.bankReference})) > 0`,
    ),
    check(
      "receiving_destination_mask_check",
      sql`${table.maskedDescriptor} IS NULL OR length(${table.maskedDescriptor}) <= 120`,
    ),
  ],
);

// External payout configuration does not establish an Asaas receiving bank or readiness.
export const receivingPixDestination = pgTable(
  "receiving_pix_destination",
  {
    ...scopedColumns(),
    version: integer("version").notNull(),
    state: text("state").notNull().default("PENDING"),
    isCurrent: boolean("is_current").notNull().default(false),
    pixConfiguration: jsonb("pix_configuration")
      .$type<Record<string, unknown>>()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("receiving_pix_destination_version_key").on(
      table.siteId,
      table.accountId,
      table.environment,
      table.version,
    ),
    uniqueIndex("receiving_pix_destination_current_idx")
      .on(table.siteId, table.accountId, table.environment)
      .where(sql`${table.isCurrent} = true`),
    accountForeignKey(table, "receiving_pix_destination_account_fk"),
    check("receiving_pix_destination_version_check", sql`${table.version} > 0`),
    check(
      "receiving_pix_destination_pending_check",
      sql`${table.state} = 'PENDING'`,
    ),
  ],
);

export const receivingVerificationEvidence = pgTable(
  "receiving_verification_evidence",
  {
    ...scopedColumns(),
    destinationVersion: integer("destination_version").notNull(),
    accountReference: text("account_reference"),
    recipientReference: text("recipient_reference"),
    operatorReference: text("operator_reference"),
    bankReference: text("bank_reference"),
    verificationStatus: financialVerificationStatus("verification_status")
      .notNull()
      .default("UNVERIFIED"),
    provenance: financialEvidenceProvenance("provenance"),
    verificationReference: text("verification_reference"),
    providerAccountState: receivingProviderAccountState(
      "provider_account_state",
    )
      .notNull()
      .default("UNVERIFIED"),
    bankState: receivingBankState("bank_state").notNull().default("UNVERIFIED"),
    receivingCapability: boolean("receiving_capability")
      .notNull()
      .default(false),
    withdrawalCapability: boolean("withdrawal_capability")
      .notNull()
      .default(false),
    commercialEnabled: boolean("commercial_enabled").notNull().default(false),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    bankObservedAt: timestamp("bank_observed_at", { withTimezone: true }),
  },
  (table) => [
    unique("receiving_evidence_scope_key").on(
      table.siteId,
      table.accountId,
      table.environment,
      table.id,
    ),
    accountForeignKey(table, "receiving_evidence_account_fk"),
    destinationForeignKey(table, "receiving_evidence_destination_fk"),
    check(
      "receiving_evidence_verified_check",
      sql`${table.verificationStatus} <> 'VERIFIED' OR (${table.provenance} IS NOT NULL AND ${table.observedAt} IS NOT NULL AND ${table.verificationReference} IS NOT NULL AND length(trim(${table.verificationReference})) > 0)`,
    ),
    check(
      "receiving_evidence_bank_check",
      sql`${table.bankState} <> 'VERIFIED' OR (${table.verificationStatus} = 'VERIFIED' AND ${table.bankObservedAt} IS NOT NULL AND ${table.bankReference} IS NOT NULL AND length(trim(${table.bankReference})) > 0)`,
    ),
    check(
      "receiving_evidence_environment_check",
      sql`${table.provenance} <> 'SIMULATION' OR ${table.environment} = 'sandbox'`,
    ),
    check(
      "receiving_evidence_time_check",
      sql`(${table.observedAt} IS NULL OR ${table.observedAt} <= ${table.createdAt}) AND (${table.bankObservedAt} IS NULL OR ${table.bankObservedAt} <= ${table.createdAt})`,
    ),
  ],
);

// Adapters whitelist the frozen quote snapshot; JSONB is not a client input contract.
export const giftQuoteRecord = pgTable(
  "gift_quote_record",
  {
    ...scopedColumns(),
    giftId: text("gift_id").notNull(),
    destinationVersion: integer("destination_version").notNull(),
    method: giftPaymentMethod("method").notNull(),
    currency: text("currency").notNull().default("BRL"),
    nominalCents: integer("nominal_cents").notNull(),
    commissionBasisPoints: integer("commission_basis_points")
      .notNull()
      .default(200),
    commissionCents: integer("commission_cents").notNull(),
    processingCents: integer("processing_cents").notNull(),
    totalCents: integer("total_cents").notNull(),
    policyVersion: text("policy_version").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("gift_quote_scope_key").on(
      table.siteId,
      table.accountId,
      table.environment,
      table.id,
    ),
    accountForeignKey(table, "gift_quote_account_fk"),
    destinationForeignKey(table, "gift_quote_destination_fk"),
    foreignKey({
      columns: [table.siteId, table.giftId],
      foreignColumns: [giftItem.siteId, giftItem.id],
      name: "gift_quote_gift_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("gift_quote_currency_check", sql`${table.currency} = 'BRL'`),
    check(
      "gift_quote_amounts_check",
      sql`${table.nominalCents} BETWEEN 1 AND 2147483647 AND ${table.commissionCents} BETWEEN 0 AND 2147483647 AND ${table.processingCents} BETWEEN 0 AND 2147483647 AND ${table.totalCents} BETWEEN 1 AND 2147483647`,
    ),
    check(
      "gift_quote_allocation_check",
      sql`coalesce((
        ((( ${table.snapshot} #> '{quote,feeAllocation}' IS NULL
             AND ${table.snapshot} #> '{pricing,policy,feeAllocation}' IS NULL)
           OR (${table.snapshot} #> '{quote,feeAllocation}' = '"BUYER_GROSS_UP"'::jsonb
               AND ${table.snapshot} #> '{pricing,policy,feeAllocation}' = '"BUYER_GROSS_UP"'::jsonb))
          AND ${table.totalCents}::bigint = ${table.nominalCents}::bigint + ${table.commissionCents}::bigint + ${table.processingCents}::bigint)
        OR (${table.snapshot} #> '{quote,feeAllocation}' = '"RECIPIENT_DEDUCTED"'::jsonb
            AND ${table.snapshot} #> '{pricing,policy,feeAllocation}' = '"RECIPIENT_DEDUCTED"'::jsonb
            AND ${table.totalCents}::bigint = ${table.nominalCents}::bigint
            AND ${table.totalCents}::bigint > ${table.commissionCents}::bigint + ${table.processingCents}::bigint)
      ), false)`,
    ),
    check(
      "gift_quote_commission_check",
      sql`${table.commissionBasisPoints} = 200 AND ${table.commissionCents}::bigint = (${table.nominalCents}::bigint * 200 + 5000) / 10000`,
    ),
    check(
      "gift_quote_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "gift_quote_snapshot_check",
      sql`jsonb_typeof(${table.snapshot}) = 'object' AND ${table.snapshot} ?& ARRAY['quote', 'gift', 'receiving', 'pricing', 'createdAt', 'expiresAt']`,
    ),
    check(
      "gift_quote_policy_check",
      sql`length(trim(${table.policyVersion})) BETWEEN 1 AND 128`,
    ),
  ],
);

// An order preserves one quote's item, method, money and destination without drift.
export const giftOrder = pgTable(
  "gift_order",
  {
    ...scopedColumns(),
    quoteId: text("quote_id").notNull(),
    requestId: text("request_id").notNull(),
    requestHash: text("request_hash").notNull(),
    recoveryTokenHash: text("recovery_token_hash").notNull(),
  },
  (table) => [
    unique("gift_order_scope_key").on(
      table.siteId,
      table.accountId,
      table.environment,
      table.id,
    ),
    unique("gift_order_quote_key").on(
      table.siteId,
      table.accountId,
      table.environment,
      table.quoteId,
    ),
    unique("gift_order_request_key").on(table.siteId, table.requestId),
    accountForeignKey(table, "gift_order_account_fk"),
    foreignKey({
      columns: [
        table.siteId,
        table.accountId,
        table.environment,
        table.quoteId,
      ],
      foreignColumns: [
        giftQuoteRecord.siteId,
        giftQuoteRecord.accountId,
        giftQuoteRecord.environment,
        giftQuoteRecord.id,
      ],
      name: "gift_order_quote_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "gift_order_request_hash_check",
      sql`${table.requestHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "gift_order_recovery_hash_check",
      sql`${table.recoveryTokenHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "gift_order_request_check",
      sql`length(trim(${table.requestId})) BETWEEN 1 AND 128`,
    ),
  ],
);

export const withdrawalIntent = pgTable(
  "withdrawal_intent",
  {
    ...scopedColumns(),
    operatorUserId: text("operator_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    destinationVersion: integer("destination_version").notNull(),
    requestId: text("request_id").notNull(),
    requestHash: text("request_hash").notNull(),
    authorizationReference: text("authorization_reference").notNull(),
    policyVersion: text("policy_version").notNull(),
    amountCents: integer("amount_cents").notNull(),
    feeCents: integer("fee_cents").notNull(),
    netCents: integer("net_cents").notNull(),
    currency: text("currency").notNull().default("BRL"),
    state: withdrawalIntentState("state").notNull().default("REQUESTED"),
    reservationState: withdrawalReservationState("reservation_state")
      .notNull()
      .default("HELD"),
    reservedCents: integer("reserved_cents").notNull(),
    providerReference: text("provider_reference"),
    receiptReference: text("receipt_reference"),
    resolutionObservedAt: timestamp("resolution_observed_at", {
      withTimezone: true,
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("withdrawal_intent_scope_key").on(
      table.siteId,
      table.accountId,
      table.environment,
      table.id,
    ),
    unique("withdrawal_intent_request_key").on(table.siteId, table.requestId),
    unique("withdrawal_intent_consent_key").on(
      table.siteId,
      table.accountId,
      table.environment,
      table.operatorUserId,
      table.destinationVersion,
      table.requestId,
      table.id,
    ),
    unique("withdrawal_intent_provider_key").on(
      table.siteId,
      table.accountId,
      table.environment,
      table.providerReference,
    ),
    accountForeignKey(table, "withdrawal_intent_account_fk"),
    destinationForeignKey(table, "withdrawal_intent_destination_fk"),
    check(
      "withdrawal_intent_request_hash_check",
      sql`${table.requestHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "withdrawal_intent_request_check",
      sql`length(trim(${table.requestId})) BETWEEN 1 AND 128 AND length(trim(${table.policyVersion})) BETWEEN 1 AND 128 AND length(trim(${table.authorizationReference})) > 0`,
    ),
    check("withdrawal_intent_currency_check", sql`${table.currency} = 'BRL'`),
    check(
      "withdrawal_intent_amounts_check",
      sql`${table.amountCents} BETWEEN 1 AND 2147483647 AND ${table.feeCents} BETWEEN 0 AND 2147483647 AND ${table.netCents} BETWEEN 1 AND 2147483647 AND ${table.reservedCents} BETWEEN 0 AND 2147483647`,
    ),
    check(
      "withdrawal_intent_allocation_check",
      sql`${table.amountCents}::bigint = ${table.feeCents}::bigint + ${table.netCents}::bigint`,
    ),
    check(
      "withdrawal_intent_reservation_check",
      sql`(${table.state} IN ('REQUESTED', 'AWAITING_AUTHORIZATION', 'PROCESSING', 'UNKNOWN') AND ${table.reservationState} = 'HELD' AND ${table.reservedCents} = ${table.amountCents}) OR (${table.state} = 'COMPLETED' AND ${table.reservationState} = 'CONSUMED' AND ${table.reservedCents} = 0) OR (${table.state} IN ('FAILED', 'CANCELLED') AND ${table.reservationState} = 'RELEASED' AND ${table.reservedCents} = 0)`,
    ),
    check(
      "withdrawal_intent_resolution_check",
      sql`${table.state} NOT IN ('COMPLETED', 'FAILED', 'CANCELLED') OR ${table.resolutionObservedAt} IS NOT NULL`,
    ),
  ],
);

// Retained consent and no-created-request seals precede financial reservation.
export const withdrawalRequest = pgTable(
  "withdrawal_request",
  {
    ...scopedColumns(),
    operatorUserId: text("operator_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    destinationVersion: integer("destination_version").notNull(),
    requestId: text("request_id").notNull(),
    previewSnapshot: jsonb("preview_snapshot")
      .$type<Record<string, unknown>>()
      .notNull(),
    previewHash: text("preview_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    state: text("state").notNull(),
    requestRevision: bigint("request_revision", { mode: "bigint" }).notNull(),
    withdrawalIntentId: text("withdrawal_intent_id"),
    sealedAt: timestamp("sealed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("withdrawal_request_identity_key").on(table.siteId, table.requestId),
    uniqueIndex("withdrawal_request_open_idx")
      .on(table.siteId, table.operatorUserId, table.environment)
      .where(sql`${table.state} = 'OPEN'`),
    index("withdrawal_request_scope_idx").on(
      table.siteId,
      table.environment,
      table.operatorUserId,
      table.createdAt,
      table.requestId,
    ),
    accountForeignKey(table, "withdrawal_request_account_fk"),
    destinationForeignKey(table, "withdrawal_request_destination_fk"),
    foreignKey({
      name: "withdrawal_request_intent_fk",
      columns: [
        table.siteId,
        table.accountId,
        table.environment,
        table.operatorUserId,
        table.destinationVersion,
        table.requestId,
        table.withdrawalIntentId,
      ],
      foreignColumns: [
        withdrawalIntent.siteId,
        withdrawalIntent.accountId,
        withdrawalIntent.environment,
        withdrawalIntent.operatorUserId,
        withdrawalIntent.destinationVersion,
        withdrawalIntent.requestId,
        withdrawalIntent.id,
      ],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "withdrawal_request_identity_check",
      sql`${table.requestId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND ${table.destinationVersion} > 0`,
    ),
    check(
      "withdrawal_request_preview_hash_check",
      sql`${table.previewHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "withdrawal_request_preview_check",
      sql`jsonb_typeof(${table.previewSnapshot}) = 'object' AND ${table.expiresAt} > ${table.createdAt} AND ${table.updatedAt} >= ${table.createdAt}`,
    ),
    check(
      "withdrawal_request_lifecycle_check",
      sql`(${table.state} = 'OPEN' AND ${table.requestRevision} = 1 AND ${table.withdrawalIntentId} IS NULL AND ${table.sealedAt} IS NULL) OR (${table.state} = 'COMMITTED' AND ${table.requestRevision} = 2 AND ${table.withdrawalIntentId} IS NOT NULL AND ${table.sealedAt} IS NULL) OR (${table.state} = 'SEALED_NOT_CREATED' AND ${table.requestRevision} = 2 AND ${table.withdrawalIntentId} IS NULL AND ${table.sealedAt} IS NOT NULL AND ${table.sealedAt} >= ${table.createdAt})`,
    ),
  ],
);

// Request IDs prevent local replay; providerOperationReference does not promise PSP idempotency.
// Adapters must match leaseToken and leaseExpiresAt atomically before writing results.
export const financialOperation = pgTable(
  "financial_operation",
  {
    ...scopedColumns(),
    kind: financialOperationKind("kind").notNull(),
    orderId: text("order_id"),
    withdrawalIntentId: text("withdrawal_intent_id"),
    paymentId: text("payment_id"),
    state: financialOperationState("state").notNull().default("REQUESTED"),
    requestId: text("request_id").notNull(),
    requestHash: text("request_hash").notNull(),
    requestSnapshot: jsonb("request_snapshot")
      .$type<Record<string, unknown>>()
      .notNull(),
    providerOperationReference: text("provider_operation_reference"),
    leaseOwner: text("lease_owner"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastErrorCode: text("last_error_code"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique("financial_operation_scope_key").on(
      table.siteId,
      table.accountId,
      table.environment,
      table.id,
    ),
    unique("financial_operation_order_key").on(
      table.siteId,
      table.accountId,
      table.environment,
      table.id,
      table.orderId,
      table.kind,
    ),
    unique("financial_operation_request_key").on(
      table.siteId,
      table.kind,
      table.requestId,
    ),
    unique("financial_operation_provider_key").on(
      table.siteId,
      table.accountId,
      table.environment,
      table.providerOperationReference,
    ),
    index("financial_operation_retry_idx").on(table.state, table.nextAttemptAt),
    accountForeignKey(table, "financial_operation_account_fk"),
    foreignKey({
      columns: [
        table.siteId,
        table.accountId,
        table.environment,
        table.orderId,
      ],
      foreignColumns: [
        giftOrder.siteId,
        giftOrder.accountId,
        giftOrder.environment,
        giftOrder.id,
      ],
      name: "financial_operation_order_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      columns: [
        table.siteId,
        table.accountId,
        table.environment,
        table.withdrawalIntentId,
      ],
      foreignColumns: [
        withdrawalIntent.siteId,
        withdrawalIntent.accountId,
        withdrawalIntent.environment,
        withdrawalIntent.id,
      ],
      name: "financial_operation_withdrawal_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      columns: [
        table.siteId,
        table.accountId,
        table.environment,
        table.paymentId,
        table.orderId,
      ],
      foreignColumns: [
        giftPaymentRecord.siteId,
        giftPaymentRecord.accountId,
        giftPaymentRecord.environment,
        giftPaymentRecord.id,
        giftPaymentRecord.orderId,
      ],
      name: "financial_operation_payment_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "financial_operation_target_check",
      sql`(${table.kind} = 'ACCOUNT_CREATE' AND ${table.orderId} IS NULL AND ${table.withdrawalIntentId} IS NULL AND ${table.paymentId} IS NULL) OR (${table.kind} = 'CHECKOUT_CREATE' AND ${table.orderId} IS NOT NULL AND ${table.withdrawalIntentId} IS NULL AND ${table.paymentId} IS NULL) OR (${table.kind} = 'WITHDRAWAL' AND ${table.orderId} IS NULL AND ${table.withdrawalIntentId} IS NOT NULL AND ${table.paymentId} IS NULL) OR (${table.kind} = 'REFUND' AND ${table.orderId} IS NOT NULL AND ${table.paymentId} IS NOT NULL AND ${table.withdrawalIntentId} IS NULL)`,
    ),
    check(
      "financial_operation_request_hash_check",
      sql`${table.requestHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "financial_operation_request_check",
      sql`length(trim(${table.requestId})) BETWEEN 1 AND 128 AND jsonb_typeof(${table.requestSnapshot}) = 'object'`,
    ),
    check(
      "financial_operation_lease_check",
      sql`(num_nonnulls(${table.leaseOwner}, ${table.leaseToken}, ${table.leaseExpiresAt}) = 0 OR (num_nonnulls(${table.leaseOwner}, ${table.leaseToken}, ${table.leaseExpiresAt}) = 3 AND length(trim(${table.leaseOwner})) BETWEEN 1 AND 128 AND length(trim(${table.leaseToken})) BETWEEN 1 AND 128)) AND (${table.state} NOT IN ('CLAIMED', 'PROCESSING') OR num_nonnulls(${table.leaseOwner}, ${table.leaseToken}, ${table.leaseExpiresAt}) = 3)`,
    ),
    check("financial_operation_attempts_check", sql`${table.attempts} >= 0`),
    check(
      "financial_operation_error_check",
      sql`${table.lastErrorCode} IS NULL OR ${table.lastErrorCode} ~ '^[A-Z0-9_]{1,64}$'`,
    ),
  ],
);

export const giftCheckoutAttempt = pgTable(
  "gift_checkout_attempt",
  {
    ...scopedColumns(),
    orderId: text("order_id").notNull(),
    operationId: text("operation_id").notNull(),
    operationKind: financialOperationKind("operation_kind")
      .notNull()
      .default("CHECKOUT_CREATE"),
    attemptNumber: integer("attempt_number").notNull(),
    providerReference: text("provider_reference"),
    hostedUrl: text("hosted_url"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    unique("gift_checkout_attempt_scope_key").on(
      table.siteId,
      table.accountId,
      table.environment,
      table.id,
    ),
    unique("gift_checkout_attempt_order_key").on(
      table.siteId,
      table.accountId,
      table.environment,
      table.id,
      table.orderId,
    ),
    unique("gift_checkout_attempt_number_key").on(
      table.siteId,
      table.accountId,
      table.environment,
      table.orderId,
      table.attemptNumber,
    ),
    unique("gift_checkout_attempt_operation_key").on(
      table.siteId,
      table.accountId,
      table.environment,
      table.operationId,
    ),
    unique("gift_checkout_attempt_provider_key").on(
      table.siteId,
      table.accountId,
      table.environment,
      table.providerReference,
    ),
    accountForeignKey(table, "gift_checkout_attempt_account_fk"),
    foreignKey({
      columns: [
        table.siteId,
        table.accountId,
        table.environment,
        table.orderId,
      ],
      foreignColumns: [
        giftOrder.siteId,
        giftOrder.accountId,
        giftOrder.environment,
        giftOrder.id,
      ],
      name: "gift_checkout_attempt_order_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      columns: [
        table.siteId,
        table.accountId,
        table.environment,
        table.operationId,
        table.orderId,
        table.operationKind,
      ],
      foreignColumns: [
        financialOperation.siteId,
        financialOperation.accountId,
        financialOperation.environment,
        financialOperation.id,
        financialOperation.orderId,
        financialOperation.kind,
      ],
      name: "gift_checkout_attempt_operation_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "gift_checkout_attempt_number_check",
      sql`${table.attemptNumber} > 0`,
    ),
    check(
      "gift_checkout_attempt_operation_kind_check",
      sql`${table.operationKind} = 'CHECKOUT_CREATE'`,
    ),
  ],
);

// Multiple observed payments can belong to one checkout. Unknown amounts stay null.
export const giftPaymentRecord = pgTable(
  "gift_payment_record",
  {
    ...scopedColumns(),
    orderId: text("order_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    providerPaymentReference: text("provider_payment_reference").notNull(),
    providerStatus: text("provider_status"),
    verificationStatus: financialVerificationStatus("verification_status")
      .notNull()
      .default("UNVERIFIED"),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    currency: text("currency").notNull().default("BRL"),
    grossCents: integer("gross_cents"),
    processingCents: integer("processing_cents"),
    commissionCents: integer("commission_cents"),
    recipientNetCents: integer("recipient_net_cents"),
    splitProviderReference: text("split_provider_reference"),
    splitFixedCents: integer("split_fixed_cents"),
  },
  (table): PgTableExtraConfigValue[] => [
    unique("gift_payment_scope_key").on(
      table.siteId,
      table.accountId,
      table.environment,
      table.id,
    ),
    unique("gift_payment_order_key").on(
      table.siteId,
      table.accountId,
      table.environment,
      table.id,
      table.orderId,
    ),
    unique("gift_payment_provider_key").on(
      table.siteId,
      table.accountId,
      table.environment,
      table.providerPaymentReference,
    ),
    accountForeignKey(table, "gift_payment_account_fk"),
    foreignKey({
      columns: [
        table.siteId,
        table.accountId,
        table.environment,
        table.attemptId,
        table.orderId,
      ],
      foreignColumns: [
        giftCheckoutAttempt.siteId,
        giftCheckoutAttempt.accountId,
        giftCheckoutAttempt.environment,
        giftCheckoutAttempt.id,
        giftCheckoutAttempt.orderId,
      ],
      name: "gift_payment_attempt_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "gift_payment_reference_check",
      sql`length(trim(${table.providerPaymentReference})) > 0`,
    ),
    check("gift_payment_currency_check", sql`${table.currency} = 'BRL'`),
    check(
      "gift_payment_amounts_check",
      sql`(${table.grossCents} IS NULL OR ${table.grossCents} BETWEEN 1 AND 2147483647) AND (${table.processingCents} IS NULL OR ${table.processingCents} BETWEEN 0 AND 2147483647) AND (${table.commissionCents} IS NULL OR ${table.commissionCents} BETWEEN 0 AND 2147483647) AND (${table.recipientNetCents} IS NULL OR ${table.recipientNetCents} BETWEEN 0 AND 2147483647) AND (${table.splitFixedCents} IS NULL OR ${table.splitFixedCents} BETWEEN 0 AND 2147483647)`,
    ),
    check(
      "gift_payment_allocation_check",
      sql`num_nonnulls(${table.processingCents}, ${table.commissionCents}, ${table.recipientNetCents}) < 3 OR (${table.grossCents} IS NOT NULL AND ${table.grossCents}::bigint = ${table.processingCents}::bigint + ${table.commissionCents}::bigint + ${table.recipientNetCents}::bigint)`,
    ),
    check(
      "gift_payment_verified_check",
      sql`${table.verificationStatus} <> 'VERIFIED' OR (${table.observedAt} IS NOT NULL AND ${table.providerStatus} IS NOT NULL AND ${table.grossCents} IS NOT NULL)`,
    ),
  ],
);

// Payload and its hash contain only normalized event identity/correlation references.
// The future adapter authenticates, bounds and whitelists them; raw webhooks are not stored.
export const financialEventInbox = pgTable(
  "financial_event_inbox",
  {
    ...scopedColumns(),
    deliveryId: text("delivery_id").notNull(),
    providerEventReference: text("provider_event_reference"),
    eventType: text("event_type").notNull(),
    payloadHash: text("payload_hash").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    authenticatedAt: timestamp("authenticated_at", {
      withTimezone: true,
    }).notNull(),
    paymentId: text("payment_id"),
    state: financialInboxState("state").notNull().default("RECEIVED"),
    leaseOwner: text("lease_owner"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastErrorCode: text("last_error_code"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    unique("financial_event_scope_key").on(
      table.siteId,
      table.accountId,
      table.environment,
      table.id,
    ),
    unique("financial_event_delivery_key").on(
      table.siteId,
      table.accountId,
      table.environment,
      table.deliveryId,
    ),
    unique("financial_event_provider_key").on(
      table.siteId,
      table.accountId,
      table.environment,
      table.providerEventReference,
    ),
    index("financial_event_retry_idx").on(table.state, table.nextAttemptAt),
    accountForeignKey(table, "financial_event_account_fk"),
    foreignKey({
      columns: [
        table.siteId,
        table.accountId,
        table.environment,
        table.paymentId,
      ],
      foreignColumns: [
        giftPaymentRecord.siteId,
        giftPaymentRecord.accountId,
        giftPaymentRecord.environment,
        giftPaymentRecord.id,
      ],
      name: "financial_event_payment_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "financial_event_hash_check",
      sql`${table.payloadHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "financial_event_delivery_check",
      sql`length(trim(${table.deliveryId})) BETWEEN 1 AND 256`,
    ),
    check(
      "financial_event_provider_reference_check",
      sql`${table.providerEventReference} IS NULL OR (${table.providerEventReference} ~ '^[ -~]+$' AND length(${table.providerEventReference}) BETWEEN 1 AND 256 AND length(trim(${table.providerEventReference})) > 0)`,
    ),
    check(
      "financial_event_type_check",
      sql`length(trim(${table.eventType})) BETWEEN 1 AND 128`,
    ),
    check(
      "financial_event_payload_check",
      sql`jsonb_typeof(${table.payload}) = 'object' AND octet_length(${table.payload}::text) <= 262144`,
    ),
    check(
      "financial_event_lease_check",
      sql`(num_nonnulls(${table.leaseOwner}, ${table.leaseToken}, ${table.leaseExpiresAt}) = 0 OR (num_nonnulls(${table.leaseOwner}, ${table.leaseToken}, ${table.leaseExpiresAt}) = 3 AND length(trim(${table.leaseOwner})) BETWEEN 1 AND 128 AND length(trim(${table.leaseToken})) BETWEEN 1 AND 128)) AND (${table.state} <> 'CLAIMED' OR num_nonnulls(${table.leaseOwner}, ${table.leaseToken}, ${table.leaseExpiresAt}) = 3)`,
    ),
    check("financial_event_attempts_check", sql`${table.attempts} >= 0`),
    check(
      "financial_event_error_check",
      sql`${table.lastErrorCode} IS NULL OR ${table.lastErrorCode} ~ '^[A-Z0-9_]{1,64}$'`,
    ),
  ],
);

// Insert/compensation model only; DB permissions or append-only triggers remain pending.
export const financialLedgerEntry = pgTable(
  "financial_ledger_entry",
  {
    ...scopedColumns(),
    effectKey: text("effect_key").notNull(),
    kind: text("kind").notNull(),
    direction: financialLedgerDirection("direction").notNull(),
    currency: text("currency").notNull().default("BRL"),
    amountCents: integer("amount_cents").notNull(),
    paymentId: text("payment_id"),
    withdrawalIntentId: text("withdrawal_intent_id"),
    operationId: text("operation_id"),
    eventId: text("event_id"),
    compensatesEntryId: text("compensates_entry_id"),
  },
  (table): PgTableExtraConfigValue[] => [
    unique("financial_ledger_scope_key").on(
      table.siteId,
      table.accountId,
      table.environment,
      table.id,
    ),
    unique("financial_ledger_effect_key").on(
      table.siteId,
      table.accountId,
      table.environment,
      table.effectKey,
    ),
    accountForeignKey(table, "financial_ledger_account_fk"),
    foreignKey({
      columns: [
        table.siteId,
        table.accountId,
        table.environment,
        table.paymentId,
      ],
      foreignColumns: [
        giftPaymentRecord.siteId,
        giftPaymentRecord.accountId,
        giftPaymentRecord.environment,
        giftPaymentRecord.id,
      ],
      name: "financial_ledger_payment_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      columns: [
        table.siteId,
        table.accountId,
        table.environment,
        table.withdrawalIntentId,
      ],
      foreignColumns: [
        withdrawalIntent.siteId,
        withdrawalIntent.accountId,
        withdrawalIntent.environment,
        withdrawalIntent.id,
      ],
      name: "financial_ledger_withdrawal_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      columns: [
        table.siteId,
        table.accountId,
        table.environment,
        table.operationId,
      ],
      foreignColumns: [
        financialOperation.siteId,
        financialOperation.accountId,
        financialOperation.environment,
        financialOperation.id,
      ],
      name: "financial_ledger_operation_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      columns: [
        table.siteId,
        table.accountId,
        table.environment,
        table.eventId,
      ],
      foreignColumns: [
        financialEventInbox.siteId,
        financialEventInbox.accountId,
        financialEventInbox.environment,
        financialEventInbox.id,
      ],
      name: "financial_ledger_event_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      columns: [
        table.siteId,
        table.accountId,
        table.environment,
        table.compensatesEntryId,
      ],
      foreignColumns: [
        table.siteId,
        table.accountId,
        table.environment,
        table.id,
      ],
      name: "financial_ledger_compensation_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("financial_ledger_currency_check", sql`${table.currency} = 'BRL'`),
    check(
      "financial_ledger_amount_check",
      sql`${table.amountCents} BETWEEN 1 AND 2147483647`,
    ),
    check(
      "financial_ledger_identity_check",
      sql`length(trim(${table.effectKey})) BETWEEN 1 AND 256 AND ${table.kind} ~ '^[A-Z0-9_]{1,64}$'`,
    ),
    check(
      "financial_ledger_source_check",
      sql`${table.paymentId} IS NOT NULL OR ${table.withdrawalIntentId} IS NOT NULL OR ${table.compensatesEntryId} IS NOT NULL`,
    ),
    check(
      "financial_ledger_compensation_check",
      sql`${table.compensatesEntryId} IS NULL OR ${table.compensatesEntryId} <> ${table.id}`,
    ),
  ],
);

export type NewFinancialLedgerEntry = typeof financialLedgerEntry.$inferInsert;

// Provider observations are append-only. Workflow state remains in financial_operation.
export const withdrawalProviderObservation = pgTable(
  "withdrawal_provider_observation",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id").notNull(),
    accountId: text("account_id").notNull(),
    environment: financialEnvironment("environment").notNull(),
    operationId: text("operation_id").notNull(),
    providerReference: text("provider_reference").notNull(),
    payloadHash: text("payload_hash").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "withdrawal_observation_operation_fk",
      columns: [
        table.siteId,
        table.accountId,
        table.environment,
        table.operationId,
      ],
      foreignColumns: [
        financialOperation.siteId,
        financialOperation.accountId,
        financialOperation.environment,
        financialOperation.id,
      ],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "withdrawal_observation_hash_check",
      sql`${table.payloadHash} ~ '^[a-f0-9]{64}$' AND ${table.id} = 'asaas-transfer:' || ${table.payloadHash}`,
    ),
    check(
      "withdrawal_observation_payload_check",
      sql`jsonb_typeof(${table.payload}) = 'object' AND octet_length(${table.payload}::text) <= 32768`,
    ),
    check(
      "withdrawal_observation_time_check",
      sql`${table.recordedAt} >= ${table.observedAt}`,
    ),
    check(
      "withdrawal_observation_provider_check",
      sql`${table.providerReference} ~ '^[A-Za-z0-9_-]{1,128}$'`,
    ),
  ],
);

// The callback authorizes an existing native transfer; neither table is monetary state.
export const withdrawalAuthorizationCandidate = pgTable(
  "withdrawal_authorization_candidate",
  {
    environment: financialEnvironment("environment").notNull(),
    providerReference: text("provider_reference").notNull(),
    siteId: text("site_id").notNull(),
    accountId: text("account_id").notNull(),
    operationId: text("operation_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.environment, table.providerReference] }),
    unique("withdrawal_authorization_operation_unique").on(
      table.environment,
      table.operationId,
    ),
    foreignKey({
      name: "withdrawal_authorization_operation_fk",
      columns: [
        table.siteId,
        table.accountId,
        table.environment,
        table.operationId,
      ],
      foreignColumns: [
        financialOperation.siteId,
        financialOperation.accountId,
        financialOperation.environment,
        financialOperation.id,
      ],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "withdrawal_authorization_candidate_environment_check",
      sql`${table.environment} IN ('sandbox', 'live')`,
    ),
    check(
      "withdrawal_authorization_candidate_hash_check",
      sql`${table.payloadHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "withdrawal_authorization_candidate_provider_check",
      sql`${table.providerReference} ~ '^[A-Za-z0-9_-]{1,128}$'`,
    ),
    check(
      "withdrawal_authorization_candidate_payload_check",
      sql`jsonb_typeof(${table.payload}) = 'object' AND octet_length(${table.payload}::text) <= 32768`,
    ),
  ],
);
export const withdrawalAuthorizationDecision = pgTable(
  "withdrawal_authorization_decision",
  {
    environment: financialEnvironment("environment").notNull(),
    providerReference: text("provider_reference").notNull(),
    payloadHash: text("payload_hash").notNull(),
    status: text("status").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.environment, table.providerReference] }),
    foreignKey({
      name: "withdrawal_authorization_candidate_fk",
      columns: [table.environment, table.providerReference],
      foreignColumns: [
        withdrawalAuthorizationCandidate.environment,
        withdrawalAuthorizationCandidate.providerReference,
      ],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "withdrawal_authorization_decision_hash_check",
      sql`${table.payloadHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "withdrawal_authorization_decision_status_check",
      sql`${table.status} = 'APPROVED'`,
    ),
  ],
);
