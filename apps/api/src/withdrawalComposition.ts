import { createHash, hkdfSync, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  receivingPixDestinationInputSchema,
  receivingSetupConsentVersion,
  type WithdrawalIntent,
} from "@entrelacos/contracts";
import type { DatabaseConnection } from "@entrelacos/database";
import { sql } from "drizzle-orm";
import {
  type AsaasAccountFeesObservation,
  createAsaasHttpClient,
} from "./asaasHttpClient";
import { createAsaasStoredAccountReader } from "./asaasStoredAccountReader";
import { createAsaasWithdrawalTransferAdapter } from "./asaasTransferClient";
import { createAsaasWithdrawalCustody } from "./asaasWithdrawalCustody";
import { parseBrlCents } from "./giftMoney";
import type { GiftPaymentConfig } from "./giftPaymentConfig";
import { decryptProviderCredential } from "./providerCredentials";
import type { ReceivingPixConfiguration } from "./receivingPixDestinationSetup";
import { evaluateReceivingReadiness } from "./receivingReadiness";
import {
  loadReceivingContextInTransaction,
  type ReceivingTransaction,
} from "./receivingRepository";
import { resolveSiteAccess } from "./siteAccess";
import {
  createWithdrawalExecutionService,
  type DispatchFence,
  type OriginalWithdrawal,
  type WithdrawalCompletionProof,
  withdrawalCorrelation,
  withdrawalInstant,
} from "./withdrawalExecution";
import {
  createWithdrawalPayoutBinding,
  sameWithdrawalPayout,
} from "./withdrawalPayout";
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
  type WithdrawalPresentationScope,
  type WithdrawalProtectedRequestAttempt,
  type WithdrawalReservationContext,
  type WithdrawalReservationService,
  WithdrawalReservationServiceError,
  type WithdrawalReservationSnapshot,
} from "./withdrawalReservations";
import { createWithdrawalStoredPresentationLoader } from "./withdrawalStoredPresentation";

export interface WithdrawalCompositionOptions {
  db: DatabaseConnection["db"];
  now?(): Date;
  fetch?: typeof globalThis.fetch;
  refreshReceiving?(siteId: string): Promise<void>;
}
export interface WithdrawalComposition {
  service?: WithdrawalReservationService;
  reconcilePending(): Promise<void>;
  decorateIntent(intent: WithdrawalIntent): Promise<WithdrawalIntent>;
  loadCompletionProofInTransaction?(
    tx: ReceivingTransaction,
    withdrawalId: string,
    reference: string,
  ): Promise<WithdrawalCompletionProof | null>;
  close(): Promise<void>;
}
function unavailable(): never {
  throw new WithdrawalReservationServiceError(503, "WITHDRAWAL_UNAVAILABLE");
}
function one<T = Record<string, unknown>>(result: { rows: unknown[] }): T {
  if (result.rows.length !== 1) unavailable();
  return result.rows[0] as T;
}

export function quoteAsaasWithdrawalMaximumFee(
  scope: WithdrawalFeeScope,
  observation: AsaasAccountFeesObservation,
  now: Date,
): WithdrawalFeeQuote {
  const base = observation.fees.transfer?.pix?.feeValue;
  if (
    observation.source !== "provider" ||
    observation.provider !== "ASAAS" ||
    observation.currency !== "BRL" ||
    observation.environment !== "sandbox" ||
    scope.environment !== "sandbox" ||
    observation.siteId !== scope.siteId ||
    observation.accountBindingId !== scope.accountId ||
    observation.accountReference !== scope.accountReference ||
    typeof base !== "string" ||
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime()) ||
    !(observation.observedAt instanceof Date) ||
    !(observation.completedAt instanceof Date) ||
    !Number.isFinite(observation.observedAt.getTime()) ||
    !Number.isFinite(observation.completedAt.getTime())
  )
    unavailable();
  const feeCents = parseBrlCents(base);
  if (
    feeCents >= scope.amountCents ||
    now.getTime() < observation.completedAt.getTime() ||
    observation.completedAt.getTime() < observation.observedAt.getTime() ||
    now.getTime() - observation.observedAt.getTime() > 60000
  )
    unavailable();
  // The full observed base fee is an approved ceiling, never a promised quota exemption.
  return {
    ...scope,
    feeCents,
    feeSemantics: "MAXIMUM",
    policyVersion: `asaas-pix-max-v1-${feeCents}`,
    provenance: "provider",
    verification: "verified",
    observedAt: new Date(observation.observedAt),
    expiresAt: new Date(observation.observedAt.getTime() + 60000),
  };
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
  credential_version: 1;
  credential_key_id: string;
  credential_nonce: string;
  credential_ciphertext: string;
  credential_tag: string;
}
interface StoredWithdrawalHolder {
  id: string;
  holderUserId: string;
  consentId: string;
  consentVersion: string;
  consentAt: Date | string;
}
export function createWithdrawalComposition(
  config: GiftPaymentConfig,
  options: WithdrawalCompositionOptions,
): WithdrawalComposition {
  if (
    config.mode !== "sandbox" ||
    config.applicationEnvironment === "production"
  )
    return {
      async reconcilePending() {},
      async decorateIntent(intent) {
        return intent;
      },
      async close() {},
    };
  const db = options.db;
  const platformAccountId = config.platformAccountId;
  const mode = "sandbox" as const;
  const applicationEnvironment = config.applicationEnvironment;
  const now = options.now ?? (() => new Date());
  const fetch = options.fetch ?? globalThis.fetch;
  const keyring = new Map(
    [...config.credentialKeyring].map(([id, key]) => [id, new Uint8Array(key)]),
  );
  const destinationKeys = new Map(
    [...keyring].map(([id, key]) => [
      id,
      new Uint8Array(
        hkdfSync(
          "sha256",
          key,
          "entrelacos.receiving-pix-destination.v1",
          "destination",
          32,
        ),
      ),
    ]),
  );
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  let nextRecoveryAt = 0;
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
    freshnessMs: 300000,
    now,
    ...(options.refreshReceiving ? { refresh: options.refreshReceiving } : {}),
  };
  const reader = createAsaasStoredAccountReader(db, {
    mode,
    applicationEnvironment,
    keyring,
    fetch,
    timeoutMs: 15000,
    maxResponseBytes: 262144,
    now,
  });
  const basePresentation = createWithdrawalStoredPresentationLoader({
    mode,
    applicationEnvironment,
    freshnessMs: receiving.freshnessMs,
    now,
  });
  async function account(
    tx: ReceivingTransaction,
    scope: { siteId: string; accountId?: string; accountReference?: string },
    current: boolean,
    lock = false,
  ) {
    const result = await tx.execute(
      sql`SELECT a.*,st.is_demo AS "isDemo" FROM receiving_account a JOIN site st ON st.id=a.site_id WHERE a.site_id=${scope.siteId} AND a.environment='sandbox' AND a.provider='ASAAS' ${scope.accountId ? sql`AND a.id=${scope.accountId}` : sql``} ${scope.accountReference ? sql`AND a.account_reference=${scope.accountReference}` : sql``} ${current ? sql`AND a.is_current=true` : sql``} LIMIT 2 ${lock ? sql`FOR UPDATE OF a` : sql``}`,
    );
    const row = one<StoredWithdrawalAccount>(result);
    if (
      row.site_id !== scope.siteId ||
      row.environment !== mode ||
      row.provider !== "ASAAS" ||
      row.isDemo !== true ||
      !row.account_reference ||
      !row.recipient_reference ||
      !row.operator_user_id ||
      (current && row.is_current !== true) ||
      row.account_reference === platformAccountId
    )
      unavailable();
    return row;
  }
  async function holder(tx: ReceivingTransaction, a: StoredWithdrawalAccount) {
    const h = one<StoredWithdrawalHolder>(
      await tx.execute(
        sql`SELECT id,holder_user_id AS "holderUserId",consent_id AS "consentId",consent_version AS "consentVersion",consent_at AS "consentAt" FROM receiving_setup_holder WHERE site_id=${a.site_id} AND environment='sandbox'`,
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
  async function payout(
    tx: ReceivingTransaction,
    scope: WithdrawalPresentationScope,
    expected?: OriginalWithdrawal["consent"]["snapshot"]["presentation"]["payout"],
  ) {
    const a = await account(tx, scope, true);
    const h = await holder(tx, a);
    const row = one<{
      id: string;
      version: number;
      state: string;
      isCurrent: boolean;
      configuration: ReceivingPixConfiguration;
    }>(
      await tx.execute(
        sql`SELECT id,version,state,is_current AS "isCurrent",pix_configuration AS configuration FROM receiving_pix_destination WHERE site_id=${scope.siteId} AND account_id=${scope.accountId} AND environment='sandbox' AND is_current=true LIMIT 2`,
      ),
    );
    if (row.isCurrent !== true || row.state !== "PENDING" || !row.configuration)
      unavailable();
    const bound = createWithdrawalPayoutBinding(
      {
        siteId: scope.siteId,
        accountId: scope.accountId,
        accountReference: scope.accountReference,
        environment: mode,
        operatorUserId: a.operator_user_id,
        holderId: h.id,
        holderConsentId: h.consentId,
      },
      {
        id: row.id,
        version: row.version,
        configuration: row.configuration as ReceivingPixConfiguration,
      },
      now(),
    );
    if (expected && !sameWithdrawalPayout(expected, bound)) unavailable();
    return {
      account: a,
      holder: h,
      configuration: row.configuration as ReceivingPixConfiguration,
      binding: bound,
    };
  }
  async function presentation(
    tx: ReceivingTransaction,
    scope: WithdrawalFeeScope | WithdrawalPresentationScope,
  ) {
    const base =
      "amountCents" in scope
        ? await basePresentation(tx, scope)
        : await basePresentation(tx, scope);
    if (base?.provenance !== "provider") return null;
    try {
      const selected = await payout(tx, scope);
      return {
        ...base,
        payout: selected.binding,
        maskedDestination: `Pix ${selected.binding.keyType}: ${selected.binding.maskedKey}`,
      };
    } catch {
      return null;
    }
  }
  const loadPresentation = presentation as WithdrawalStoredPresentationLoader;
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
      readiness: evaluateReceivingReadiness({ ...loaded, siteId, now: now() }),
    };
  }
  const reservationRepository = createWithdrawalReservationRepository(db, {
    mode,
    applicationEnvironment,
    maxAuthAgeMs: 300000,
    freshnessMs: 300000,
    now,
    loadVerifiedPresentationInTransaction: loadPresentation,
  });
  const reservation = createWithdrawalReservationService({
    mode,
    applicationEnvironment,
    maxAuthAgeMs: 300000,
    freshnessMs: 300000,
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
        const observation = await reader.getAccountFees({
          provider: "ASAAS",
          siteId: scope.siteId,
          accountBindingId: scope.accountId,
          accountReference: scope.accountReference,
          environment: mode,
        });
        return quoteAsaasWithdrawalMaximumFee(scope, observation, now());
      },
    },
    balance: {
      getBalance: (scope) =>
        reader.getBalance({
          provider: "ASAAS",
          siteId: scope.siteId,
          accountBindingId: scope.accountId,
          accountReference: scope.accountReference,
          environment: mode,
        }),
    },
    repository: reservationRepository,
  });
  const custody = createAsaasWithdrawalCustody(db, {
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
    const frozen = consent.snapshot.presentation.payout;
    if (
      !frozen ||
      frozen.holderId !== h.id ||
      frozen.holderConsentId !== h.consentId ||
      a.operator_user_id !== snapshot.operatorUserId
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
  const posting = createWithdrawalPostingRepository(db, {
    mode,
    applicationEnvironment,
    maxAuthAgeMs: 300000,
    freshnessMs: 300000,
    leaseOwner: `withdrawal-${randomUUID()}`,
    leaseDurationMs: 60000,
    now,
    generateLeaseToken: randomUUID,
    ports: {
      loadOriginalHolderConsentInTransaction: originalHolder,
      loadCompletionProofInTransaction:
        custody.loadCompletionProofInTransaction,
      async loadDispatchAuthorityInTransaction(tx, original, attempt) {
        const actor = attempt.actor;
        if (!actor) return null;
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
        if (
          !presented ||
          !sameWithdrawalPayout(
            presented.payout,
            original.consent.snapshot.presentation.payout,
          ) ||
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
  function decryptKey(selected: Awaited<ReturnType<typeof payout>>) {
    const c = selected.configuration;
    const plaintext = JSON.parse(
      decryptProviderCredential(
        c.key,
        {
          provider: "ASAAS",
          siteId: selected.account.site_id,
          accountBindingId: selected.account.id,
          environment: mode,
        },
        destinationKeys,
      ),
    );
    if (plaintext.purpose !== "receiving-pix-key.v1") unavailable();
    const input = receivingPixDestinationInputSchema.parse({
      type: plaintext.type,
      key: plaintext.key,
    });
    if (input.type !== selected.binding.keyType) unavailable();
    return input;
  }
  async function dispatchCheck(
    tx: ReceivingTransaction,
    original: OriginalWithdrawal,
    fence: DispatchFence,
  ) {
    const c = original.correlation;
    await tx.execute(sql`SELECT id FROM site WHERE id=${c.siteId} FOR UPDATE`);
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
        sql`SELECT request_hash AS "requestHash",request_snapshot AS "requestSnapshot",state,attempts,lease_token AS "leaseToken",lease_owner AS "leaseOwner",lease_expires_at AS "leaseExpiresAt" FROM financial_operation WHERE id=${c.operationId} AND site_id=${c.siteId} AND account_id=${c.accountId} AND environment='sandbox' AND kind='WITHDRAWAL' AND withdrawal_intent_id=${c.withdrawalId} FOR UPDATE`,
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
      new Date(fence.leaseExpiresAt).getTime() <= now().getTime()
    )
      unavailable();
    if (
      a.operator_user_id !== c.operatorUserId ||
      !original.consent.snapshot.presentation.payout ||
      now().getTime() >= Date.parse(original.snapshot.feeQuote.expiresAt) ||
      now().getTime() >= Date.parse(original.consent.snapshot.preview.expiresAt)
    )
      unavailable();
    await originalHolder(tx, original.snapshot, original.consent);
    const selected = await payout(
      tx,
      original.consent.snapshot.scope,
      original.consent.snapshot.presentation.payout,
    );
    return { selected, key: decryptKey(selected) };
  }
  async function loadClient(
    original: OriginalWithdrawal,
    fence: DispatchFence,
  ) {
    const c = original.correlation;
    const a = await db.transaction((tx) =>
      account(
        tx,
        {
          siteId: c.siteId,
          accountId: c.accountId,
          accountReference: c.accountReference,
        },
        false,
      ),
    );
    const credentialContext = {
      provider: "ASAAS" as const,
      siteId: c.siteId,
      accountBindingId: c.accountId,
      environment: mode,
    };
    const accessToken = decryptProviderCredential(
      {
        version: a.credential_version,
        keyId: a.credential_key_id,
        nonce: a.credential_nonce,
        ciphertext: a.credential_ciphertext,
        tag: a.credential_tag,
      },
      credentialContext,
      keyring,
    );
    const client = createAsaasHttpClient({
      mode,
      binding: { ...credentialContext, accountReference: c.accountReference },
      credentials: { context: credentialContext, accessToken },
      fetch,
      timeoutMs: 15000,
      maxResponseBytes: 262144,
      now,
    });
    return {
      getTransfer: client.getTransfer,
      listTransfers: client.listTransfers,
      async createPixTransfer(
        command: Parameters<typeof client.createPixTransfer>[0],
      ) {
        // Retain the account lock through dispatch so reviewed payout changes cannot race the POST.
        return db.transaction(async (tx) => {
          const checked = await dispatchCheck(tx, original, fence);
          const freshFees = await client.getAccountFees();
          const feeValue = freshFees.fees.transfer?.pix?.feeValue;
          if (
            typeof feeValue !== "string" ||
            parseBrlCents(feeValue) > c.feeCents ||
            now().getTime() >= Date.parse(fence.leaseExpiresAt)
          )
            unavailable();
          if (
            command.valueCents !== c.netCents ||
            command.externalReference !== c.operationId ||
            command.pixAddressKey !== checked.key.key ||
            command.pixAddressKeyType !== checked.key.type
          )
            unavailable();
          return client.createPixTransfer(command);
        });
      },
    };
  }
  const adapter = createAsaasWithdrawalTransferAdapter({
    mode,
    applicationEnvironment,
    now,
    custody,
    loadClient,
    async loadDestination(original, fence) {
      return db.transaction(async (tx) => {
        const checked = await dispatchCheck(tx, original, fence);
        const c = original.correlation;
        return {
          siteId: c.siteId,
          accountId: c.accountId,
          accountReference: c.accountReference,
          environment: mode,
          recipientReference: c.recipientReference,
          bankReference: c.bankReference,
          destinationVersion: c.destinationVersion,
          pixAddressKey: checked.key.key,
          pixAddressKeyType: checked.key.type,
          provenance: "provider",
          verification: "verified",
          payout: checked.selected.binding,
        };
      });
    },
  });
  const execution = createWithdrawalExecutionService({
    mode,
    applicationEnvironment,
    maxAuthAgeMs: 300000,
    now,
    repository: posting,
    dispatch: adapter,
    lookup: adapter,
  });
  async function loadProof(
    tx: ReceivingTransaction,
    withdrawalId: string,
    reference: string,
  ) {
    const selected = await tx.execute(
      sql`SELECT payload FROM withdrawal_provider_observation WHERE id=${reference} AND environment='sandbox' AND payload->'original'->'correlation'->>'withdrawalId'=${withdrawalId} LIMIT 2`,
    );
    if (selected.rows.length !== 1) return null;
    const body = one<{
      payload: { original: OriginalWithdrawal; fence: DispatchFence };
    }>(selected).payload;
    if (!body?.original || !body?.fence) return null;
    return custody.loadCompletionProofInTransaction(
      tx,
      body.original,
      body.fence,
      reference,
    );
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
          sql`SELECT w.receipt_reference AS reference,op.request_snapshot AS snapshot FROM withdrawal_intent w JOIN financial_operation op ON op.withdrawal_intent_id=w.id AND op.site_id=w.site_id AND op.account_id=w.account_id AND op.environment=w.environment AND op.kind='WITHDRAWAL' WHERE w.id=${intent.id} AND w.site_id=${intent.siteId} AND w.environment='sandbox'`,
        ),
      );
      if (row.snapshot?.feeQuote?.feeSemantics !== "MAXIMUM") return intent;
      if (intent.state !== "COMPLETED")
        return { ...intent, feeSemantics: "MAXIMUM" };
      const proof = await loadProof(tx, intent.id, row.reference);
      if (!proof || proof.correlation.siteId !== intent.siteId) unavailable();
      return {
        ...intent,
        feeSemantics: "MAXIMUM",
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
    readContext: (attempt) => own(() => reservation.readContext(attempt)),
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
  return {
    service,
    decorateIntent: (intent) => own(() => decorateIntent(intent)),
    loadCompletionProofInTransaction: loadProof,
    async reconcilePending() {
      if (now().getTime() < nextRecoveryAt) return;
      nextRecoveryAt = now().getTime() + 30000;
      return own(async () => {
        const rows = await db.execute(
          sql`SELECT w.site_id AS "siteId",w.request_id AS "requestId" FROM withdrawal_intent w JOIN financial_operation op ON op.withdrawal_intent_id=w.id AND op.site_id=w.site_id AND op.account_id=w.account_id AND op.environment=w.environment AND op.kind='WITHDRAWAL' WHERE w.environment='sandbox' AND w.state IN ('PROCESSING','UNKNOWN') AND op.attempts=1 ORDER BY w.updated_at LIMIT 20`,
        );
        for (const row of rows.rows)
          await execution.reconcileExisting({
            siteId: String(row.siteId),
            requestId: String(row.requestId),
          });
      });
    },
    async close() {
      closed = true;
      await Promise.allSettled([...pending]);
      for (const key of [...keyring.values(), ...destinationKeys.values()])
        key.fill(0);
      keyring.clear();
      destinationKeys.clear();
    },
  };
}
