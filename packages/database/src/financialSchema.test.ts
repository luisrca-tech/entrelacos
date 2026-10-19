import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  financialEventInbox,
  financialLedgerEntry,
  financialOperation,
  financialOperationState,
  giftCheckoutAttempt,
  giftOrder,
  giftPaymentRecord,
  giftQuoteRecord,
  receivingAccount,
  receivingDestination,
  receivingVerificationEvidence,
  withdrawalIntent,
  withdrawalRequest,
} from "./financialSchema";

const dialect = new PgDialect();

describe("durable withdrawal request association", () => {
  it("retains one immutable request identity and one owned OPEN slot", () => {
    const config = getTableConfig(withdrawalRequest);
    expect(config.name).toBe("withdrawal_request");
    expect(
      config.uniqueConstraints
        .find((key) => key.name === "withdrawal_request_identity_key")
        ?.columns.map((column) => column.name),
    ).toEqual(["site_id", "request_id"]);
    const open = config.indexes.find(
      (key) => key.config.name === "withdrawal_request_open_idx",
    );
    expect(open?.config.unique).toBe(true);
    expect(
      open?.config.where && dialect.sqlToQuery(open.config.where).sql,
    ).toContain("OPEN");
    expect(withdrawalRequest.previewSnapshot.notNull).toBe(true);
    expect(withdrawalRequest.previewHash.notNull).toBe(true);
    expect(withdrawalRequest.requestRevision.dataType).toBe("bigint");
    expect(config.foreignKeys.every((key) => key.onDelete === "restrict")).toBe(
      true,
    );
  });
  it("binds account, destination and committed intent to exact stored scope", () => {
    const keys = getTableConfig(withdrawalRequest).foreignKeys;
    for (const suffix of ["account_fk", "destination_fk", "intent_fk"]) {
      expect(
        keys.find(
          (key) => key.reference().name === `withdrawal_request_${suffix}`,
        ),
      ).toBeDefined();
    }
    expect(
      checkSql(withdrawalRequest, "withdrawal_request_lifecycle_check"),
    ).toContain("SEALED_NOT_CREATED");
    expect(
      checkSql(withdrawalRequest, "withdrawal_request_lifecycle_check"),
    ).toContain("withdrawal_intent_id");
    expect(
      checkSql(withdrawalRequest, "withdrawal_request_preview_hash_check"),
    ).toContain("64");
    const intent = keys.find(
      (key) => key.reference().name === "withdrawal_request_intent_fk",
    );
    expect(intent?.reference().columns.map((column) => column.name)).toEqual([
      "site_id",
      "account_id",
      "environment",
      "operator_user_id",
      "destination_version",
      "request_id",
      "withdrawal_intent_id",
    ]);
    expect(
      checkSql(withdrawalRequest, "withdrawal_request_lifecycle_check"),
    ).toContain('"sealed_at" IS NOT NULL');
  });
});

function checkSql(table: PgTable, name: string): string {
  const constraint = getTableConfig(table).checks.find(
    (entry) => entry.name === name,
  );
  expect(constraint, name).toBeDefined();
  return constraint ? dialect.sqlToQuery(constraint.value).sql : "";
}

describe("financial receiving account schema", () => {
  it("retains optional durable webhook registration metadata beside the authentication hash", () => {
    expect(receivingAccount.webhookRegistration.name).toBe(
      "webhook_registration",
    );
    expect(receivingAccount.webhookRegistration.dataType).toBe("json");
    expect(receivingAccount.webhookRegistration.notNull).toBe(false);
  });
  it("starts unapproved without an implicit recipient or remote references", () => {
    expect(receivingAccount.providerAccountState.default).toBe("UNVERIFIED");
    for (const column of [
      receivingAccount.receivingCapability,
      receivingAccount.withdrawalCapability,
      receivingAccount.commercialEnabled,
      receivingAccount.isCurrent,
    ]) {
      expect(column.default).toBe(false);
    }
    for (const column of [
      receivingAccount.operatorUserId,
      receivingAccount.operatorReference,
      receivingAccount.accountReference,
      receivingAccount.recipientReference,
    ]) {
      expect(column.notNull).toBe(false);
      expect(column.default).toBeUndefined();
    }
    expect(Object.hasOwn(receivingAccount, "ready")).toBe(false);
    expect(Object.hasOwn(receivingAccount, "catalogEligible")).toBe(false);
  });

  it("provides inline scope uniqueness before future composite FK references", () => {
    const config = getTableConfig(receivingAccount);
    const scope = config.uniqueConstraints.find(
      (entry) => entry.name === "receiving_account_scope_key",
    );
    expect(scope?.columns.map((column) => column.name)).toEqual([
      "site_id",
      "id",
      "environment",
    ]);
    const provider = config.uniqueConstraints.find(
      (entry) => entry.name === "receiving_account_provider_key",
    );
    expect(provider?.columns.map((column) => column.name)).toEqual([
      "provider",
      "environment",
      "account_reference",
    ]);
    expect(
      config.indexes.find(
        (entry) => entry.config.name === "receiving_account_current_idx",
      )?.config.unique,
    ).toBe(true);
  });

  it("retains financial ownership when a site or designated user is deleted", () => {
    const keys = getTableConfig(receivingAccount).foreignKeys;
    expect(keys).toHaveLength(2);
    expect(keys.every((key) => key.onDelete === "restrict")).toBe(true);
  });

  it("stores only a complete encrypted envelope or no credentials", () => {
    const config = getTableConfig(receivingAccount);
    expect(config.columns.map((column) => column.name)).not.toContain(
      "api_key",
    );
    expect(config.columns.map((column) => column.name)).not.toContain(
      "credential_plaintext",
    );
    const envelope = config.checks.find(
      (entry) => entry.name === "receiving_account_credentials_check",
    );
    expect(envelope).toBeDefined();
    const query = envelope && dialect.sqlToQuery(envelope.value).sql;
    expect(query).toContain("num_nonnulls");
    expect(query).toContain("credential_ciphertext");
    expect(query).toContain("credential_tag");
    for (const column of [
      receivingAccount.credentialVersion,
      receivingAccount.credentialKeyId,
      receivingAccount.credentialNonce,
      receivingAccount.credentialCiphertext,
      receivingAccount.credentialTag,
    ]) {
      expect(column.notNull).toBe(false);
      expect(column.default).toBeUndefined();
    }
  });

  it("binds a webhook capability hash to one stored account without plaintext", () => {
    expect(receivingAccount.webhookTokenHash?.notNull).toBe(false);
    expect(receivingAccount.webhookTokenHash?.default).toBeUndefined();
    expect(
      checkSql(receivingAccount, "receiving_account_webhook_hash_check"),
    ).toContain("64");
    expect(
      getTableConfig(receivingAccount)
        .uniqueConstraints.find(
          (entry) => entry.name === "receiving_account_webhook_hash_key",
        )
        ?.columns.map((column) => column.name),
    ).toEqual(["webhook_token_hash"]);
    expect(Object.hasOwn(receivingAccount, "webhookToken")).toBe(false);
  });
});

describe("versioned receiving evidence and immutable quote identity", () => {
  it("binds destination versions and evidence to the same account/site/environment", () => {
    for (const table of [
      receivingDestination,
      receivingVerificationEvidence,
      giftQuoteRecord,
      giftOrder,
    ]) {
      const key = getTableConfig(table).foreignKeys.find((entry) =>
        entry.reference().name?.endsWith("_account_fk"),
      );
      expect(key?.reference().columns.map((column) => column.name)).toEqual([
        "site_id",
        "account_id",
        "environment",
      ]);
      expect(
        key?.reference().foreignColumns.map((column) => column.name),
      ).toEqual(["site_id", "id", "environment"]);
      expect(key?.onDelete).toBe("restrict");
    }
    const destination = getTableConfig(receivingDestination);
    expect(
      destination.uniqueConstraints
        .find((entry) => entry.name === "receiving_destination_version_key")
        ?.columns.map((column) => column.name),
    ).toEqual(["site_id", "account_id", "environment", "version"]);
    const proofKey = getTableConfig(
      receivingVerificationEvidence,
    ).foreignKeys.find(
      (entry) => entry.reference().name === "receiving_evidence_destination_fk",
    );
    expect(proofKey?.reference().columns.map((column) => column.name)).toEqual([
      "site_id",
      "account_id",
      "environment",
      "destination_version",
    ]);
  });

  it("starts without bank approval or verified observations and excludes raw bank/KYC fields", () => {
    expect(receivingDestination.bankState.default).toBe("UNVERIFIED");
    expect(receivingDestination.bankReference.notNull).toBe(false);
    expect(receivingDestination.isCurrent.default).toBe(false);
    expect(receivingVerificationEvidence.verificationStatus.default).toBe(
      "UNVERIFIED",
    );
    expect(receivingVerificationEvidence.providerAccountState.default).toBe(
      "UNVERIFIED",
    );
    expect(receivingVerificationEvidence.bankState.default).toBe("UNVERIFIED");
    expect(receivingVerificationEvidence.observedAt.notNull).toBe(false);
    expect(receivingVerificationEvidence.bankObservedAt.notNull).toBe(false);
    expect(receivingVerificationEvidence.provenance.default).toBeUndefined();
    expect(
      checkSql(
        receivingVerificationEvidence,
        "receiving_evidence_verified_check",
      ),
    ).toContain("verification_reference");
    expect(
      checkSql(receivingVerificationEvidence, "receiving_evidence_bank_check"),
    ).toContain("bank_observed_at");
    expect(
      checkSql(
        receivingVerificationEvidence,
        "receiving_evidence_environment_check",
      ),
    ).toContain("sandbox");
    const names = getTableConfig(receivingDestination).columns.map(
      (column) => column.name,
    );
    for (const privateField of [
      "cpf",
      "bank_account_number",
      "pix_key",
      "kyc_document",
      "card_number",
    ]) {
      expect(names).not.toContain(privateField);
    }
  });

  it("pins recipient-paid allocation to matching quote and policy markers", () => {
    const allocation = checkSql(giftQuoteRecord, "gift_quote_allocation_check");
    expect(allocation).toContain("RECIPIENT_DEDUCTED");
    expect(allocation).toContain("BUYER_GROSS_UP");
    expect(allocation).toContain("{quote,feeAllocation}");
    expect(allocation).toContain("{pricing,policy,feeAllocation}");
    expect(allocation).toMatch(/coalesce/i);
  });
  it("maps frozen quotes to BRL integer allocations, current destination version and archived gifts", () => {
    expect(giftQuoteRecord.snapshot.getSQLType()).toBe("jsonb");
    expect(giftQuoteRecord.snapshot.notNull).toBe(true);
    expect(giftQuoteRecord.currency.default).toBe("BRL");
    expect(giftQuoteRecord.commissionBasisPoints.default).toBe(200);
    expect(giftQuoteRecord.nominalCents.getSQLType()).toBe("integer");
    expect(checkSql(giftQuoteRecord, "gift_quote_amounts_check")).toContain(
      "2147483647",
    );
    expect(checkSql(giftQuoteRecord, "gift_quote_allocation_check")).toContain(
      "::bigint",
    );
    expect(checkSql(giftQuoteRecord, "gift_quote_commission_check")).toContain(
      "200",
    );
    expect(checkSql(giftQuoteRecord, "gift_quote_expiry_check")).toContain(
      "expires_at",
    );
    const keys = getTableConfig(giftQuoteRecord).foreignKeys;
    expect(
      keys.find((entry) => entry.reference().name === "gift_quote_gift_fk")
        ?.onDelete,
    ).toBe("restrict");
    expect(
      keys
        .find((entry) => entry.reference().name === "gift_quote_destination_fk")
        ?.reference()
        .columns.map((column) => column.name),
    ).toEqual(["site_id", "account_id", "environment", "destination_version"]);
    expect(Object.hasOwn(giftQuoteRecord, "updatedAt")).toBe(false);
  });

  it("keeps one order per frozen quote and binds request replay/conflict hashes", () => {
    const config = getTableConfig(giftOrder);
    const quote = config.foreignKeys.find(
      (entry) => entry.reference().name === "gift_order_quote_fk",
    );
    expect(quote?.reference().columns.map((column) => column.name)).toEqual([
      "site_id",
      "account_id",
      "environment",
      "quote_id",
    ]);
    expect(quote?.onDelete).toBe("restrict");
    expect(
      config.uniqueConstraints
        .find((entry) => entry.name === "gift_order_quote_key")
        ?.columns.map((column) => column.name),
    ).toEqual(["site_id", "account_id", "environment", "quote_id"]);
    expect(
      config.uniqueConstraints
        .find((entry) => entry.name === "gift_order_request_key")
        ?.columns.map((column) => column.name),
    ).toEqual(["site_id", "request_id"]);
    expect(checkSql(giftOrder, "gift_order_request_hash_check")).toContain(
      "64",
    );
    expect(giftOrder.recoveryTokenHash.notNull).toBe(true);
    expect(giftOrder.recoveryTokenHash.default).toBeUndefined();
    expect(checkSql(giftOrder, "gift_order_recovery_hash_check")).toContain(
      "64",
    );
    expect(Object.hasOwn(giftOrder, "recoveryToken")).toBe(false);
    expect(Object.hasOwn(giftOrder, "updatedAt")).toBe(false);
  });
});

describe("durable financial operation metadata", () => {
  it("supports durable claim, retry, unknown and resolution states without a fake success default", () => {
    expect(financialOperationState.enumValues).toEqual([
      "REQUESTED",
      "CLAIMED",
      "PROCESSING",
      "SUCCEEDED",
      "FAILED",
      "CANCELLED",
      "UNKNOWN",
    ]);
    expect(financialOperation.state.default).toBe("REQUESTED");
    expect(financialOperation.attempts.default).toBe(0);
    expect(financialOperation.providerOperationReference.notNull).toBe(false);
    expect(
      checkSql(financialOperation, "financial_operation_lease_check"),
    ).toContain("CLAIMED");
    expect(
      checkSql(financialOperation, "financial_operation_error_check"),
    ).toContain("last_error_code");
    expect(
      getTableConfig(financialOperation)
        .uniqueConstraints.find(
          (entry) => entry.name === "financial_operation_request_key",
        )
        ?.columns.map((column) => column.name),
    ).toEqual(["site_id", "kind", "request_id"]);
    expect(
      getTableConfig(financialOperation)
        .uniqueConstraints.find(
          (entry) => entry.name === "financial_operation_provider_key",
        )
        ?.columns.map((column) => column.name),
    ).toEqual([
      "site_id",
      "account_id",
      "environment",
      "provider_operation_reference",
    ]);
  });

  it("keeps an explicit fencing token separate from worker ownership and lease expiry", () => {
    for (const [table, constraint] of [
      [financialOperation, "financial_operation_lease_check"],
      [financialEventInbox, "financial_event_lease_check"],
    ] as const) {
      for (const column of [
        table.leaseOwner,
        table.leaseToken,
        table.leaseExpiresAt,
      ]) {
        expect(column.notNull).toBe(false);
        expect(column.default).toBeUndefined();
      }
      const lease = checkSql(table, constraint);
      expect(lease).toContain("num_nonnulls");
      expect(lease).toContain("lease_token");
      expect(lease).toContain("lease_expires_at");
      expect(lease).toContain("CLAIMED");
      expect(Object.hasOwn(table, "leaseUntil")).toBe(false);
    }
  });

  it("binds checkout attempts to the same operation and order, retaining unknown remote references", () => {
    const config = getTableConfig(giftCheckoutAttempt);
    const operation = config.foreignKeys.find(
      (entry) =>
        entry.reference().name === "gift_checkout_attempt_operation_fk",
    );
    expect(operation?.reference().columns.map((column) => column.name)).toEqual(
      [
        "site_id",
        "account_id",
        "environment",
        "operation_id",
        "order_id",
        "operation_kind",
      ],
    );
    expect(giftCheckoutAttempt.operationKind?.default).toBe("CHECKOUT_CREATE");
    expect(
      checkSql(
        giftCheckoutAttempt,
        "gift_checkout_attempt_operation_kind_check",
      ),
    ).toContain("CHECKOUT_CREATE");
    expect(operation?.onDelete).toBe("restrict");
    expect(giftCheckoutAttempt.providerReference.notNull).toBe(false);
    expect(giftCheckoutAttempt.hostedUrl.notNull).toBe(false);
    expect(
      config.uniqueConstraints
        .find((entry) => entry.name === "gift_checkout_attempt_number_key")
        ?.columns.map((column) => column.name),
    ).toEqual([
      "site_id",
      "account_id",
      "environment",
      "order_id",
      "attempt_number",
    ]);
  });

  it("stores distinct actual payments rather than assuming one payment per checkout", () => {
    const config = getTableConfig(giftPaymentRecord);
    expect(giftPaymentRecord.providerPaymentReference.notNull).toBe(true);
    expect(giftPaymentRecord.verificationStatus.default).toBe("UNVERIFIED");
    expect(giftPaymentRecord.grossCents.notNull).toBe(false);
    expect(giftPaymentRecord.processingCents.default).toBeUndefined();
    expect(giftPaymentRecord.recipientNetCents.default).toBeUndefined();
    expect(giftPaymentRecord.splitFixedCents.notNull).toBe(false);
    expect(
      config.uniqueConstraints
        .find((entry) => entry.name === "gift_payment_provider_key")
        ?.columns.map((column) => column.name),
    ).toEqual([
      "site_id",
      "account_id",
      "environment",
      "provider_payment_reference",
    ]);
    expect(
      config.uniqueConstraints.some(
        (entry) =>
          entry.columns.map((column) => column.name).join(",") ===
          "site_id,account_id,environment,attempt_id",
      ),
    ).toBe(false);
    expect(
      config.foreignKeys
        .find((entry) => entry.reference().name === "gift_payment_attempt_fk")
        ?.reference()
        .columns.map((column) => column.name),
    ).toEqual([
      "site_id",
      "account_id",
      "environment",
      "attempt_id",
      "order_id",
    ]);
    expect(
      checkSql(giftPaymentRecord, "gift_payment_allocation_check"),
    ).toContain("::bigint");
  });

  it("deduplicates inbox deliveries while retaining bounded authenticated pending correlations", () => {
    const config = getTableConfig(financialEventInbox);
    expect(financialEventInbox.state.default).toBe("RECEIVED");
    expect(financialEventInbox.attempts.default).toBe(0);
    expect(financialEventInbox.authenticatedAt.notNull).toBe(true);
    expect(financialEventInbox.paymentId.notNull).toBe(false);
    expect(financialEventInbox.providerEventReference?.notNull).toBe(false);
    expect(financialEventInbox.eventType?.notNull).toBe(true);
    expect(financialEventInbox.receivedAt?.notNull).toBe(true);
    expect(
      config.uniqueConstraints
        .find((entry) => entry.name === "financial_event_provider_key")
        ?.columns.map((column) => column.name),
    ).toEqual([
      "site_id",
      "account_id",
      "environment",
      "provider_event_reference",
    ]);
    expect(
      checkSql(financialEventInbox, "financial_event_provider_reference_check"),
    ).toContain("[ -~]+");
    expect(
      checkSql(financialEventInbox, "financial_event_provider_reference_check"),
    ).toContain("BETWEEN 1 AND 256");
    expect(
      checkSql(financialEventInbox, "financial_event_hash_check"),
    ).toContain("64");
    expect(
      config.uniqueConstraints
        .find((entry) => entry.name === "financial_event_delivery_key")
        ?.columns.map((column) => column.name),
    ).toEqual(["site_id", "account_id", "environment", "delivery_id"]);
    expect(
      checkSql(financialEventInbox, "financial_event_payload_check"),
    ).toContain("octet_length");
    expect(
      checkSql(financialEventInbox, "financial_event_lease_check"),
    ).toContain("CLAIMED");
  });

  it("deduplicates underlying ledger effects independently from inbox delivery IDs", () => {
    const config = getTableConfig(financialLedgerEntry);
    expect(
      config.uniqueConstraints
        .find((entry) => entry.name === "financial_ledger_effect_key")
        ?.columns.map((column) => column.name),
    ).toEqual(["site_id", "account_id", "environment", "effect_key"]);
    expect(
      config.foreignKeys
        .find(
          (entry) =>
            entry.reference().name === "financial_ledger_compensation_fk",
        )
        ?.reference()
        .columns.map((column) => column.name),
    ).toEqual(["site_id", "account_id", "environment", "compensates_entry_id"]);
    expect(financialLedgerEntry.currency.default).toBe("BRL");
    expect(Object.hasOwn(financialLedgerEntry, "updatedAt")).toBe(false);
    expect(
      checkSql(financialLedgerEntry, "financial_ledger_amount_check"),
    ).toContain("2147483647");
  });

  it("keeps one withdrawal reservation per immutable request and holds UNKNOWN outcomes", () => {
    const config = getTableConfig(withdrawalIntent);
    expect(withdrawalIntent.state.default).toBe("REQUESTED");
    expect(withdrawalIntent.reservationState.default).toBe("HELD");
    expect(withdrawalIntent.reservedCents.notNull).toBe(true);
    expect(withdrawalIntent.reservedCents.default).toBeUndefined();
    expect(withdrawalIntent.operatorUserId.notNull).toBe(true);
    expect(withdrawalIntent.authorizationReference.notNull).toBe(true);
    expect(withdrawalIntent.providerReference.notNull).toBe(false);
    expect(
      config.uniqueConstraints
        .find((entry) => entry.name === "withdrawal_intent_request_key")
        ?.columns.map((column) => column.name),
    ).toEqual(["site_id", "request_id"]);
    expect(
      checkSql(withdrawalIntent, "withdrawal_intent_reservation_check"),
    ).toContain("UNKNOWN");
    expect(
      checkSql(withdrawalIntent, "withdrawal_intent_allocation_check"),
    ).toContain("::bigint");
    expect(
      checkSql(withdrawalIntent, "withdrawal_intent_resolution_check"),
    ).toContain("resolution_observed_at");
  });

  it("protects every financial relationship with restrict and an account/environment FK", () => {
    for (const table of [
      receivingDestination,
      receivingVerificationEvidence,
      giftQuoteRecord,
      giftOrder,
      giftCheckoutAttempt,
      giftPaymentRecord,
      financialOperation,
      financialEventInbox,
      financialLedgerEntry,
      withdrawalIntent,
    ]) {
      const config = getTableConfig(table);
      expect(
        config.foreignKeys.every((entry) => entry.onDelete === "restrict"),
        config.name,
      ).toBe(true);
      const account = config.foreignKeys.find((entry) =>
        entry.reference().name?.endsWith("_account_fk"),
      );
      expect(
        account?.reference().columns.map((column) => column.name),
        config.name,
      ).toEqual(["site_id", "account_id", "environment"]);
      expect(
        config.uniqueConstraints.some(
          (entry) =>
            entry.columns.map((column) => column.name).join(",") ===
            "site_id,account_id,environment,id",
        ),
        config.name,
      ).toBe(true);
    }
  });

  it("has an inline unique target for every FK between new financial tables", () => {
    const tables = [
      receivingAccount,
      receivingDestination,
      receivingVerificationEvidence,
      giftQuoteRecord,
      giftOrder,
      giftCheckoutAttempt,
      giftPaymentRecord,
      financialOperation,
      financialEventInbox,
      financialLedgerEntry,
      withdrawalIntent,
    ];
    for (const table of tables) {
      const config = getTableConfig(table);
      expect(table.environment.notNull, config.name).toBe(true);
      expect(table.environment.default, config.name).toBeUndefined();
      for (const key of config.foreignKeys) {
        const reference = key.reference();
        if (!tables.some((entry) => entry === reference.foreignTable)) continue;
        const target = getTableConfig(reference.foreignTable);
        const columns = reference.foreignColumns.map((column) => column.name);
        expect(
          target.uniqueConstraints.some(
            (entry) =>
              entry.columns.map((column) => column.name).join(",") ===
              columns.join(","),
          ),
          reference.name,
        ).toBe(true);
      }
    }
  });
});
