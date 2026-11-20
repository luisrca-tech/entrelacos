import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  receivingSetupConsentVersion,
  type WithdrawalIntent,
  type WithdrawalPageQuery,
} from "@entrelacos/contracts";
import type { DatabaseConnection } from "@entrelacos/database";
import { sql } from "drizzle-orm";
import type { ApiOptions } from "./app";
import { insertFinancialOperatorAlert } from "./financialOperatorAlertRepository";
import {
  type FinancialAccountBinding,
  FinancialOverviewServiceError,
  loadFinancialOverview,
} from "./financialOverview";
import { createFinancialOverviewRepository } from "./financialOverviewRepository";
import { readFinancialWorkDueAt } from "./financialWorkSchedule";
import type { GiftPaymentConfig } from "./giftPaymentConfig";
import type { GiftPaymentWorkerResult } from "./giftPaymentWorker";
import { createGiftPaymentWorkerLoop } from "./giftPaymentWorkerLoop";
import { liveDemoSiteIdsSql } from "./liveSitePolicy";
import { mapWithConcurrency } from "./mapWithConcurrency";
import {
  createPagarmeRecipientClient,
  PAGARME_WITHDRAWAL_FEE_CENTS,
} from "./pagarmeRecipientClient";
import {
  createPagarmeWithdrawalAdapter,
  createPagarmeWithdrawalCustody,
  PAGARME_WITHDRAWAL_POLICY_VERSION,
  type ProviderBalanceObservation,
  readPagarmeBalanceObservation,
} from "./pagarmeWithdrawalClient";
import { evaluateReceivingReadiness } from "./receivingReadiness";
import {
  loadReceivingContextInTransaction,
  type ReceivingTransaction,
} from "./receivingRepository";
import { resolveSiteAccess } from "./siteAccess";
import {
  createWithdrawalExecutionService,
  type DispatchFence,
  genuineWithdrawalPromise,
  type OriginalWithdrawal,
  usesAcceptedMaximumWithdrawalDispatch,
  type WithdrawalCompletionProof,
  type WithdrawalTerminalFailureProof,
  withdrawalCorrelation,
  withdrawalInstant,
} from "./withdrawalExecution";
import { createWithdrawalHistoryRepository } from "./withdrawalHistoryRepository";
import { createWithdrawalPostingRepository } from "./withdrawalPostingRepository";
import {
  createWithdrawalReservationRepository,
  type WithdrawalStoredPresentationLoader,
} from "./withdrawalReservationRepository";
import {
  createWithdrawalReservationService,
  type WithdrawalConsentRecord,
  type WithdrawalFeeQuote,
  type WithdrawalFeeScope,
  type WithdrawalProtectedRequestAttempt,
  type WithdrawalReservationContext,
  type WithdrawalReservationService,
  WithdrawalReservationServiceError,
  type WithdrawalReservationSnapshot,
} from "./withdrawalReservations";
import { createWithdrawalStoredPresentationLoader } from "./withdrawalStoredPresentation";

const withdrawalFreshnessMs = 300_000;
const balanceFreshnessMs = 60_000;
// Each withdrawal decoration opens its own transaction; cap them per request.
const withdrawalDecorationConcurrency = 4;

type WithdrawalPorts = Pick<ApiOptions, "finance" | "withdrawalReservation">;
export interface WithdrawalCompositionOptions {
  db: DatabaseConnection["db"];
  now?(): Date;
  fetch?: typeof globalThis.fetch;
  refreshReceiving?(siteId: string): Promise<void>;
  createWorkerLoop?: typeof createGiftPaymentWorkerLoop;
}
export interface WithdrawalComposition {
  readonly ports: Readonly<WithdrawalPorts>;
  service?: WithdrawalReservationService;
  nextRecoveryDueAt(): Promise<number | null>;
  reconcilePending(): Promise<GiftPaymentWorkerResult>;
  decorateIntent(intent: WithdrawalIntent): Promise<WithdrawalIntent>;
  loadTerminalFailureInTransaction?(
    tx: ReceivingTransaction,
    withdrawalId: string,
    reference: string,
  ): Promise<WithdrawalTerminalFailureProof | null>;
  loadCompletionProofInTransaction?(
    tx: ReceivingTransaction,
    withdrawalId: string,
    reference: string,
  ): Promise<WithdrawalCompletionProof | null>;
  /** Starts the recovery worker for in-flight withdrawals. */
  start(): void;
  close(): Promise<void>;
}
function unavailable(): never {
  throw new WithdrawalReservationServiceError(503, "WITHDRAWAL_UNAVAILABLE");
}
function one<T = Record<string, unknown>>(result: { rows: unknown[] }): T {
  if (result.rows.length !== 1) unavailable();
  return result.rows[0] as T;
}

/**
 * Pagar.me charges a fixed fee on top of the transferred amount, so the gross
 * amount is debited exactly and the recipient receives amount - fee.
 */
export function quotePagarmeWithdrawalFee(
  scope: WithdrawalFeeScope,
  now: Date,
): WithdrawalFeeQuote {
  if (
    !Number.isSafeInteger(scope.amountCents) ||
    scope.amountCents <= PAGARME_WITHDRAWAL_FEE_CENTS
  )
    throw new WithdrawalReservationServiceError(400, "WITHDRAWAL_INVALID");
  if (
    !["sandbox", "live"].includes(scope.environment) ||
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime())
  )
    unavailable();
  return {
    ...scope,
    feeCents: PAGARME_WITHDRAWAL_FEE_CENTS,
    feeSemantics:
      scope.environment === "live" ? "MAXIMUM_WITH_MINIMUM_NET" : "MAXIMUM",
    policyVersion: PAGARME_WITHDRAWAL_POLICY_VERSION,
    provenance: "provider",
    verification: "verified",
    observedAt: new Date(now),
    expiresAt: new Date(now.getTime() + withdrawalFreshnessMs),
  };
}

/** The available balance must still cover this hold and every other one. */
export function verifyPagarmeWithdrawalDispatchBudget(
  original: OriginalWithdrawal,
  balance: ProviderBalanceObservation,
  otherHeldCents: bigint,
  at: Date,
): void {
  const c = original.correlation;
  if (
    c.feeCents !== PAGARME_WITHDRAWAL_FEE_CENTS ||
    c.netCents + c.feeCents !== c.amountCents ||
    typeof otherHeldCents !== "bigint" ||
    otherHeldCents < 0n ||
    balance.source !== "provider" ||
    balance.provider !== "PAGARME" ||
    balance.currency !== "BRL" ||
    balance.environment !== c.environment ||
    balance.siteId !== c.siteId ||
    balance.accountBindingId !== c.accountId ||
    balance.accountReference !== c.accountReference ||
    !(balance.observedAt instanceof Date) ||
    !Number.isFinite(balance.observedAt.getTime()) ||
    balance.observedAt.getTime() > at.getTime() ||
    at.getTime() - balance.observedAt.getTime() > balanceFreshnessMs ||
    !Number.isSafeInteger(balance.balanceCents) ||
    balance.balanceCents < 0 ||
    BigInt(balance.balanceCents) < BigInt(c.amountCents) + otherHeldCents
  )
    unavailable();
}

interface StoredWithdrawalAccount {
  id: string;
  site_id: string;
  environment: string;
  provider: string;
  account_reference: string;
  recipient_reference: string;
  operator_user_id: string;
  is_current: boolean;
  isDemo: boolean;
}
interface StoredWithdrawalHolder {
  id: string;
  holderUserId: string;
  consentId: string;
  consentVersion: string;
  consentAt: Date | string;
}
function inertComposition(): WithdrawalComposition {
  return {
    ports: Object.freeze({}),
    async nextRecoveryDueAt() {
      return null;
    },
    async reconcilePending() {
      return { kind: "IDLE" };
    },
    async decorateIntent(intent) {
      return intent;
    },
    start() {},
    async close() {},
  };
}

export function createWithdrawalComposition(
  config: GiftPaymentConfig,
  options: WithdrawalCompositionOptions,
): WithdrawalComposition {
  if (
    config.mode === "disabled" ||
    (config.mode === "live" &&
      config.applicationEnvironment !== "production") ||
    (config.mode === "sandbox" &&
      config.applicationEnvironment === "production")
  )
    return inertComposition();
  const db = options.db;
  const platformRecipientId = config.platformRecipientId;
  const mode = config.mode;
  const applicationEnvironment = config.applicationEnvironment;
  const liveDemoSiteIds = config.liveDemoSiteIds;
  const liveSitePolicy = { applicationEnvironment, liveDemoSiteIds };
  const now = options.now ?? (() => new Date());
  const recipients = createPagarmeRecipientClient({
    secretKey: config.secretKey,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  function own<T>(operation: () => Promise<T>): Promise<T> {
    if (closed)
      return Promise.reject(new Error("Withdrawal composition closed"));
    const promise = Promise.resolve().then(operation);
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  }
  const receiving = {
    mode,
    applicationEnvironment,
    liveDemoSiteIds,
    freshnessMs: withdrawalFreshnessMs,
    now,
    ...(options.refreshReceiving ? { refresh: options.refreshReceiving } : {}),
  };
  async function readBalance(binding: {
    siteId: string;
    accountBindingId: string;
    accountReference: string;
  }): Promise<ProviderBalanceObservation> {
    // The platform recipient holds commissions; it is never a withdrawal source.
    if (binding.accountReference === platformRecipientId) unavailable();
    const balance = await recipients.getBalance(binding.accountReference);
    return readPagarmeBalanceObservation(
      { ...binding, environment: mode },
      balance,
      now(),
    );
  }
  async function account(
    tx: ReceivingTransaction,
    scope: { siteId: string; accountId?: string; accountReference?: string },
    current: boolean,
    lock = false,
  ) {
    const result = await tx.execute(
      sql`SELECT a.id,a.site_id,a.environment,a.provider,a.account_reference,a.recipient_reference,a.operator_user_id,a.is_current,st.is_demo AS "isDemo" FROM receiving_account a JOIN site st ON st.id=a.site_id WHERE a.site_id=${scope.siteId} AND a.environment=${mode} AND a.provider='PAGARME' ${scope.accountId ? sql`AND a.id=${scope.accountId}` : sql``} ${scope.accountReference ? sql`AND a.account_reference=${scope.accountReference}` : sql``} ${current ? sql`AND a.is_current=true` : sql``} LIMIT 2 ${lock ? sql`FOR UPDATE OF a` : sql``}`,
    );
    const row = one<StoredWithdrawalAccount>(result);
    if (
      row.site_id !== scope.siteId ||
      row.environment !== mode ||
      row.provider !== "PAGARME" ||
      (mode === "sandbox" && row.isDemo !== true) ||
      !row.account_reference ||
      row.recipient_reference !== row.account_reference ||
      !row.operator_user_id ||
      (current && row.is_current !== true) ||
      row.account_reference === platformRecipientId
    )
      unavailable();
    return row;
  }
  async function holder(tx: ReceivingTransaction, a: StoredWithdrawalAccount) {
    const h = one<StoredWithdrawalHolder>(
      await tx.execute(
        sql`SELECT id,holder_user_id AS "holderUserId",consent_id AS "consentId",consent_version AS "consentVersion",consent_at AS "consentAt" FROM receiving_setup_holder WHERE site_id=${a.site_id} AND environment=${mode}`,
      ),
    );
    if (
      h.holderUserId !== a.operator_user_id ||
      h.consentVersion !== receivingSetupConsentVersion ||
      !h.consentId ||
      !h.consentAt ||
      new Date(h.consentAt).getTime() > now().getTime()
    )
      unavailable();
    return h;
  }
  const storedPresentation = createWithdrawalStoredPresentationLoader({
    mode,
    applicationEnvironment,
    ...(liveDemoSiteIds ? { liveDemoSiteIds } : {}),
    freshnessMs: withdrawalFreshnessMs,
    now,
  });
  // Payouts go to the recipient's default bank account; only provider-verified
  // destinations are presented ("Conta **** 1234").
  const loadPresentation = (async (
    tx: ReceivingTransaction,
    scope: WithdrawalFeeScope,
  ) => {
    const presented = await storedPresentation(tx, scope);
    return presented?.provenance === "provider" ? presented : null;
  }) as WithdrawalStoredPresentationLoader;
  async function context(
    tx: ReceivingTransaction,
    siteId: string,
  ): Promise<WithdrawalReservationContext> {
    const loaded = await loadReceivingContextInTransaction(
      tx,
      siteId,
      receiving,
    );
    const a = await account(tx, { siteId }, true);
    const b = loaded?.providerBinding;
    if (
      !loaded ||
      !b?.accountReference ||
      !b.recipientReference ||
      !b.bankReference ||
      !b.destinationVersion
    )
      unavailable();
    return {
      siteId,
      isDemo: loaded.isDemo,
      mode,
      verification: loaded.evidence?.verification ?? "unverified",
      accountId: a.id,
      bankReference: b.bankReference,
      recipientBinding: {
        siteId,
        operatorUserId: a.operator_user_id,
        environment: mode,
        accountReference: b.accountReference,
        recipientReference: b.recipientReference,
        destinationVersion: b.destinationVersion,
      },
      readiness: evaluateReceivingReadiness({
        ...loaded,
        liveDemoSiteIds,
        siteId,
        now: now(),
      }),
    };
  }
  const reservationRepository = createWithdrawalReservationRepository(db, {
    mode,
    applicationEnvironment,
    liveDemoSiteIds,
    maxAuthAgeMs: 300000,
    freshnessMs: withdrawalFreshnessMs,
    now,
    loadVerifiedPresentationInTransaction: loadPresentation,
  });
  const reservation = createWithdrawalReservationService({
    mode,
    applicationEnvironment,
    liveDemoSiteIds,
    maxAuthAgeMs: 300000,
    freshnessMs: withdrawalFreshnessMs,
    now,
    generateId: () => randomUUID(),
    async loadContext(siteId) {
      await options.refreshReceiving?.(siteId);
      return db.transaction((tx) => context(tx, siteId));
    },
    loadVerifiedPresentation: (scope) =>
      db.transaction((tx) => loadPresentation(tx, scope)),
    feeQuotes: {
      async quoteWithdrawal(scope) {
        return quotePagarmeWithdrawalFee(scope, now());
      },
    },
    balance: {
      getBalance: (scope) =>
        readBalance({
          siteId: scope.siteId,
          accountBindingId: scope.accountId,
          accountReference: scope.accountReference,
        }),
    },
    repository: reservationRepository,
  });
  const custody = createPagarmeWithdrawalCustody(db, {
    mode,
    applicationEnvironment,
    now,
  });
  async function originalHolder(
    tx: ReceivingTransaction,
    snapshot: WithdrawalReservationSnapshot,
    consent: WithdrawalConsentRecord,
  ) {
    const a = await account(
      tx,
      {
        siteId: snapshot.intent.siteId,
        accountId: snapshot.accountId,
        accountReference: snapshot.accountReference,
      },
      false,
    );
    const h = await holder(tx, a);
    if (
      a.operator_user_id !== snapshot.operatorUserId ||
      h.holderUserId !== snapshot.operatorUserId
    )
      unavailable();
    return {
      correlation: withdrawalCorrelation(snapshot),
      consentHash: consent.previewHash,
      bindingReference: `withdrawal-holder:${createHash("sha256")
        .update(
          JSON.stringify([
            h.id,
            h.consentId,
            snapshot.requestHash,
            consent.previewHash,
          ]),
        )
        .digest("hex")}`,
      holderUserId: h.holderUserId,
      holderConsentReference: h.consentId,
      actingUserId: snapshot.operatorUserId,
      holderRole: "BRIDE_HOLDER" as const,
      provenance: "durable" as const,
      verification: "verified" as const,
    };
  }
  // The reviewed bank destination must still be the current one.
  async function checkDestination(
    tx: ReceivingTransaction,
    original: OriginalWithdrawal,
  ) {
    const c = original.correlation;
    const presented = original.consent.snapshot.presentation;
    const destination = one<{
      id: string;
      version: number;
      bankReference: string;
      maskedDescriptor: string;
    }>(
      await tx.execute(
        sql`SELECT id,version,bank_reference AS "bankReference",masked_descriptor AS "maskedDescriptor" FROM receiving_destination WHERE site_id=${c.siteId} AND account_id=${c.accountId} AND environment=${mode} AND is_current=true LIMIT 2`,
      ),
    );
    if (
      destination.id !== presented.destinationId ||
      destination.version !== c.destinationVersion ||
      destination.bankReference !== c.bankReference ||
      destination.maskedDescriptor !== presented.maskedDestination
    )
      unavailable();
  }
  async function checkBudget(
    tx: ReceivingTransaction,
    original: OriginalWithdrawal,
  ) {
    const c = original.correlation;
    const held = one<{ otherHeldCents: string }>(
      await tx.execute(
        sql`SELECT COALESCE(SUM(w.reserved_cents),0)::text AS "otherHeldCents" FROM withdrawal_intent w WHERE w.site_id=${c.siteId} AND w.account_id=${c.accountId} AND w.environment=${c.environment} AND w.reservation_state='HELD' AND w.id<>${c.withdrawalId}`,
      ),
    );
    if (
      typeof held.otherHeldCents !== "string" ||
      !/^(0|[1-9]\d*)$/.test(held.otherHeldCents)
    )
      unavailable();
    const balance = await readBalance({
      siteId: c.siteId,
      accountBindingId: c.accountId,
      accountReference: c.accountReference,
    });
    verifyPagarmeWithdrawalDispatchBudget(
      original,
      balance,
      BigInt(held.otherHeldCents),
      now(),
    );
  }
  const posting = createWithdrawalPostingRepository(db, {
    mode,
    applicationEnvironment,
    liveDemoSiteIds,
    maxAuthAgeMs: 300000,
    freshnessMs: withdrawalFreshnessMs,
    leaseOwner: `withdrawal-${randomUUID()}`,
    leaseDurationMs: 60000,
    now,
    generateLeaseToken: randomUUID,
    ports: {
      loadOriginalHolderConsentInTransaction: originalHolder,
      loadCompletionProofInTransaction:
        custody.loadCompletionProofInTransaction,
      loadTerminalFailureInTransaction:
        custody.loadTerminalFailureInTransaction,
      async loadDispatchAuthorityInTransaction(tx, original, attempt) {
        const actor = attempt.actor;
        if (!actor) return null;
        await checkBudget(tx, original);
        const access = await resolveSiteAccess(tx, {
          userId: actor.userId,
          platformRole: "SITE_ADMIN",
          siteId: actor.siteId,
        });
        const current = await context(tx, actor.siteId);
        const presented = await loadPresentation(
          tx,
          original.consent.snapshot.scope,
        );
        const frozen = original.consent.snapshot.presentation;
        if (
          !presented ||
          presented.destinationId !== frozen.destinationId ||
          presented.maskedDestination !== frozen.maskedDestination ||
          !attempt.recentAuth
        )
          return null;
        return {
          actor,
          access,
          recentAuth: attempt.recentAuth,
          context: current,
          presentation: presented,
          holderBinding: await originalHolder(
            tx,
            original.snapshot,
            original.consent,
          ),
        };
      },
    },
  });
  // Holds the site and account locks through the provider POST so reviewed
  // destination changes and concurrent holds cannot race the dispatch.
  async function guardDispatch<T>(
    original: OriginalWithdrawal,
    fence: DispatchFence,
    send: () => Promise<T>,
  ): Promise<T> {
    return db.transaction(async (tx) => {
      const c = original.correlation;
      await tx.execute(
        sql`SELECT id FROM site WHERE id=${c.siteId} FOR UPDATE`,
      );
      const a = await account(
        tx,
        {
          siteId: c.siteId,
          accountId: c.accountId,
          accountReference: c.accountReference,
        },
        true,
        true,
      );
      const op = one(
        await tx.execute(
          sql`SELECT request_hash AS "requestHash",request_snapshot AS "requestSnapshot",state,attempts,lease_token AS "leaseToken",lease_owner AS "leaseOwner",lease_expires_at AS "leaseExpiresAt" FROM financial_operation WHERE id=${c.operationId} AND site_id=${c.siteId} AND account_id=${c.accountId} AND environment=${mode} AND kind='WITHDRAWAL' AND withdrawal_intent_id=${c.withdrawalId} FOR UPDATE`,
        ),
      );
      if (
        op.requestHash !== c.requestHash ||
        !isDeepStrictEqual(
          op.requestSnapshot,
          JSON.parse(JSON.stringify(original.snapshot)),
        ) ||
        op.state !== "PROCESSING" ||
        op.attempts !== 1 ||
        op.leaseToken !== fence.leaseToken ||
        op.leaseOwner !== fence.leaseOwner ||
        withdrawalInstant(op.leaseExpiresAt) !== fence.leaseExpiresAt ||
        new Date(fence.leaseExpiresAt).getTime() <= now().getTime() ||
        a.operator_user_id !== c.operatorUserId ||
        (!usesAcceptedMaximumWithdrawalDispatch(
          original,
          applicationEnvironment,
        ) &&
          (now().getTime() >=
            Date.parse(original.snapshot.feeQuote.expiresAt) ||
            now().getTime() >=
              Date.parse(original.consent.snapshot.preview.expiresAt)))
      )
        unavailable();
      await originalHolder(tx, original.snapshot, original.consent);
      await checkDestination(tx, original);
      await checkBudget(tx, original);
      // Provider GETs can outlive the fresh SQL dispatch authority.
      const current = one<{ valid: boolean }>(
        await tx.execute(
          sql`SELECT lease_expires_at>clock_timestamp() AS valid FROM financial_operation WHERE id=${c.operationId} AND site_id=${c.siteId} AND account_id=${c.accountId} AND environment=${c.environment} AND state='PROCESSING' AND attempts=1 AND lease_owner=${fence.leaseOwner} AND lease_token=${fence.leaseToken} AND lease_expires_at=${fence.leaseExpiresAt}::timestamptz`,
        ),
      );
      if (
        current.valid !== true ||
        now().getTime() >= Date.parse(fence.leaseExpiresAt)
      )
        unavailable();
      return send();
    });
  }
  const adapter = createPagarmeWithdrawalAdapter({
    mode,
    applicationEnvironment,
    now,
    client: recipients,
    custody,
    guardDispatch,
    async onUnresolved(original, reason) {
      const c = original.correlation;
      await insertFinancialOperatorAlert(db, {
        kind: "WITHDRAWAL_UNRESOLVED",
        severity: "critical",
        environment: c.environment,
        siteId: c.siteId,
        accountId: c.accountId,
        paymentReference: `withdrawal:${c.operationId}`,
        details: { reason, withdrawalId: c.withdrawalId },
      });
    },
  });
  let loop: ReturnType<typeof createGiftPaymentWorkerLoop> | undefined;
  const execution = createWithdrawalExecutionService({
    mode,
    applicationEnvironment,
    maxAuthAgeMs: 300000,
    now,
    repository: {
      ...posting,
      async armExisting(attempt) {
        const armed = await posting.armExisting(attempt);
        if (armed.outcome === "ARMED") {
          try {
            loop?.wake();
          } catch {
            // The safety sweep recovers work if the local signal fails.
          }
        }
        return armed;
      },
    },
    dispatch: adapter,
    lookup: adapter,
  });
  async function loadProof(
    tx: ReceivingTransaction,
    withdrawalId: string,
    reference: string,
    failure = false,
  ) {
    const selected = await tx.execute(
      sql`SELECT payload FROM withdrawal_provider_observation WHERE id=${reference} AND environment=${mode} AND payload->'original'->'correlation'->>'withdrawalId'=${withdrawalId} LIMIT 2`,
    );
    if (selected.rows.length !== 1) return null;
    const body = one<{
      payload: { original: OriginalWithdrawal; fence: DispatchFence };
    }>(selected).payload;
    if (!body?.original || !body?.fence) return null;
    return (
      failure
        ? custody.loadTerminalFailureInTransaction
        : custody.loadCompletionProofInTransaction
    )(tx, body.original, body.fence, reference);
  }
  async function decorateIntent(
    intent: WithdrawalIntent,
  ): Promise<WithdrawalIntent> {
    return db.transaction(async (tx) => {
      const row = one<{
        reference: string;
        snapshot: WithdrawalReservationSnapshot;
      }>(
        await tx.execute(
          sql`SELECT w.receipt_reference AS reference,op.request_snapshot AS snapshot FROM withdrawal_intent w JOIN financial_operation op ON op.withdrawal_intent_id=w.id AND op.site_id=w.site_id AND op.account_id=w.account_id AND op.environment=w.environment AND op.kind='WITHDRAWAL' WHERE w.id=${intent.id} AND w.site_id=${intent.siteId} AND w.environment=${mode}`,
        ),
      );
      if (
        !["MAXIMUM", "MAXIMUM_WITH_MINIMUM_NET"].includes(
          row.snapshot?.feeQuote?.feeSemantics ?? "",
        )
      )
        return intent;
      if (intent.state !== "COMPLETED")
        return { ...intent, feeSemantics: row.snapshot.feeQuote.feeSemantics };
      const proof = await loadProof(tx, intent.id, row.reference);
      if (
        proof?.outcome !== "COMPLETED" ||
        proof.correlation.siteId !== intent.siteId
      )
        unavailable();
      return {
        ...intent,
        feeSemantics: row.snapshot.feeQuote.feeSemantics,
        settlement: {
          totalDebitCents: proof.totalDebitCents,
          feeCents: proof.feeCents,
          netCents: proof.netCents,
          releasedCents: intent.amountCents - proof.totalDebitCents,
        },
      };
    });
  }
  async function finish(
    attempt: WithdrawalProtectedRequestAttempt,
    confirm: boolean,
  ) {
    const initial = confirm
      ? await reservation.confirmNew(attempt)
      : await reservation.recoverExisting(attempt);
    if (!confirm && initial.state === "REQUESTED" && options.refreshReceiving) {
      await genuineWithdrawalPromise(options.refreshReceiving(initial.siteId));
    }
    let result = await execution.executeExisting(attempt);
    if (result.outcome === "EXISTING")
      result = await execution.reconcileExisting({
        siteId: initial.siteId,
        requestId: attempt.requestId,
      });
    const record = await reservationRepository.findByRequest(
      initial.siteId,
      attempt.requestId,
    );
    if (record) return decorateIntent(record.intent);
    if ("stored" in result)
      return decorateIntent({
        ...initial,
        state: result.stored.state,
        updatedAt: now().toISOString(),
      });
    return initial;
  }
  const service: WithdrawalReservationService = {
    ...reservation,
    readContext: (attempt) =>
      own(async () => {
        let context = await reservation.readContext(attempt);
        if (
          context.reason === "DESTINATION_UNAVAILABLE" &&
          options.refreshReceiving
        ) {
          try {
            await options.refreshReceiving(context.siteId);
          } catch {
            unavailable();
          }
          context = await reservation.readContext(attempt);
        }
        return {
          ...context,
          recoverableRequests: await Promise.all(
            context.recoverableRequests.map(async (request) =>
              request.state === "EXISTING"
                ? {
                    ...request,
                    withdrawal: await decorateIntent(request.withdrawal),
                  }
                : request,
            ),
          ),
        };
      }),
    createPreview: (attempt) => own(() => reservation.createPreview(attempt)),
    createWithdrawal: (attempt) =>
      own(() => reservation.createWithdrawal(attempt)),
    sealUncreatedRequest: (attempt) =>
      own(() => reservation.sealUncreatedRequest(attempt)),
    confirmNew: (attempt) => own(() => finish(attempt, true)),
    recoverExisting: (attempt) => own(() => finish(attempt, false)),
    readRequest: (attempt) =>
      own(async () => {
        const result = await reservation.readRequest(attempt);
        return result.state === "EXISTING"
          ? { ...result, withdrawal: await decorateIntent(result.withdrawal) }
          : result;
      }),
  };
  const loadCompletionProofInTransaction = (
    tx: ReceivingTransaction,
    id: string,
    reference: string,
  ) =>
    loadProof(tx, id, reference) as Promise<WithdrawalCompletionProof | null>;
  const loadTerminalFailureInTransaction = (
    tx: ReceivingTransaction,
    id: string,
    reference: string,
  ) =>
    loadProof(
      tx,
      id,
      reference,
      true,
    ) as Promise<WithdrawalTerminalFailureProof | null>;
  const financeRepository = createFinancialOverviewRepository(db, {
    ...liveSitePolicy,
    environment: mode,
    now,
    loadWithdrawalTerminalFailureInTransaction:
      loadTerminalFailureInTransaction,
    loadWithdrawalCompletionProofInTransaction:
      loadCompletionProofInTransaction,
  });
  const withdrawalHistory = createWithdrawalHistoryRepository(db, {
    ...liveSitePolicy,
    mode,
  });
  async function readOverview(siteId: string) {
    let binding: FinancialAccountBinding;
    try {
      const a = await db.transaction((tx) => account(tx, { siteId }, true));
      binding = {
        provider: "PAGARME",
        siteId,
        accountBindingId: a.id,
        accountReference: a.account_reference,
        environment: mode,
      };
    } catch {
      throw new FinancialOverviewServiceError();
    }
    return loadFinancialOverview({
      mode,
      binding,
      repository: financeRepository,
      providerBalance: { getBalance: readBalance },
      now,
      freshnessMs: balanceFreshnessMs,
    });
  }
  const recoveryDueAt = sql`GREATEST(op.next_attempt_at,op.lease_expires_at)`;
  // In-flight withdrawals of the previous provider's account are left to an
  // operator: only Pagar.me accounts are recovered here.
  const eligibleRecoveries = sql`
    FROM financial_operation op
    JOIN withdrawal_intent w ON w.id=op.withdrawal_intent_id AND w.site_id=op.site_id
      AND w.account_id=op.account_id AND w.environment=op.environment
    JOIN site st ON st.id=w.site_id
    JOIN receiving_account ra ON ra.id=w.account_id AND ra.site_id=w.site_id
      AND ra.environment::text=w.environment::text AND ra.provider='PAGARME'
    WHERE op.environment=${mode} AND op.kind='WITHDRAWAL' AND op.attempts=1
      AND op.state IN ('PROCESSING','UNKNOWN') AND w.state IN ('PROCESSING','UNKNOWN')
      AND (${mode}<>'live' OR NOT st.is_demo OR st.id = ANY(${liveDemoSiteIdsSql(liveDemoSiteIds)}))
  `;
  const nextRecoveryDueAt = () =>
    own(() => readFinancialWorkDueAt(db, recoveryDueAt, eligibleRecoveries));
  const reconcilePending = () =>
    own(async (): Promise<GiftPaymentWorkerResult> => {
      // Commit the next observation time before calling the provider.
      const claimed = await db.execute(sql`
        WITH candidate AS (
          SELECT op.id,w.site_id,w.request_id
          ${eligibleRecoveries}
            AND ${recoveryDueAt}<=clock_timestamp()
          ORDER BY ${recoveryDueAt},op.id
          LIMIT 1 FOR UPDATE OF op SKIP LOCKED
        )
        UPDATE financial_operation op SET next_attempt_at=clock_timestamp()+interval '5 minutes'
        FROM candidate c WHERE op.id=c.id
        RETURNING op.id,c.site_id AS "siteId",c.request_id AS "requestId",
          op.next_attempt_at::text AS "recoveryLease"
      `);
      const row = claimed.rows[0];
      if (!row) return { kind: "IDLE" };
      await execution.reconcileExisting({
        siteId: String(row.siteId),
        requestId: String(row.requestId),
      });
      await db.execute(sql`
        UPDATE financial_operation op SET next_attempt_at=clock_timestamp()+CASE
          WHEN op.lease_expires_at>clock_timestamp()-interval '10 minutes' THEN interval '30 seconds'
          WHEN op.lease_expires_at>clock_timestamp()-interval '1 hour' THEN interval '10 minutes'
          ELSE interval '30 minutes'
        END
        WHERE op.id=${row.id} AND op.environment=${mode} AND op.kind='WITHDRAWAL'
          AND op.attempts=1 AND op.state IN ('PROCESSING','UNKNOWN')
          AND op.next_attempt_at=${row.recoveryLease}::timestamptz
      `);
      return { kind: "OBSERVED" };
    });
  loop = (options.createWorkerLoop ?? createGiftPaymentWorkerLoop)({
    worker: { processNextReceivedPayment: reconcilePending },
    nextDueAt: nextRecoveryDueAt,
    idleDelayMs: 30 * 60_000,
    retryDelayMs: 5_000,
    maxRetryDelayMs: 30 * 60_000,
  });
  const worker = loop;
  let started = false;
  let run: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  return {
    ports: Object.freeze({
      withdrawalReservation: service,
      finance: {
        listWithdrawals: (siteId: string) =>
          own(async () =>
            mapWithConcurrency(
              await withdrawalHistory.listWithdrawals(siteId),
              withdrawalDecorationConcurrency,
              decorateIntent,
            ),
          ),
        listWithdrawalPage: (siteId: string, query: WithdrawalPageQuery) =>
          own(async () => {
            const page = await withdrawalHistory.listWithdrawalPage(
              siteId,
              query,
            );
            return {
              ...page,
              withdrawals: await mapWithConcurrency(
                page.withdrawals,
                withdrawalDecorationConcurrency,
                decorateIntent,
              ),
            };
          }),
        readOverview: (siteId: string) => own(() => readOverview(siteId)),
      },
    }),
    service,
    decorateIntent: (intent) => own(() => decorateIntent(intent)),
    loadCompletionProofInTransaction,
    loadTerminalFailureInTransaction,
    nextRecoveryDueAt,
    reconcilePending,
    start() {
      if (closed) throw new Error("Withdrawal composition closed");
      if (started) return;
      started = true;
      run = worker.start();
      void run.catch(() => {});
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        if (started)
          await Promise.allSettled([
            Promise.resolve().then(() => worker.stop()),
            run,
          ]);
        await Promise.allSettled([...pending]);
      })();
      return closing;
    },
  };
}
