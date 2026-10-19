import { randomUUID } from "node:crypto";
import type { DatabaseConnection } from "@entrelacos/database";
import {
  receivingAccount,
  site,
  siteOrigin,
} from "@entrelacos/database/schema";
import { and, eq } from "drizzle-orm";
import type { ApiOptions } from "./app";
import { createAsaasCheckoutClient } from "./asaasCheckoutClient";
import {
  type AsaasFeeQuotesOptions,
  createAsaasFeeQuotes,
} from "./asaasFeeQuotes";
import { createAsaasStoredAccountReader } from "./asaasStoredAccountReader";
import { createAsaasWebhookReceiver } from "./asaasWebhook";
import { createAsaasWebhookRepository } from "./asaasWebhookRepository";
import {
  type FinancialAccountBinding,
  loadFinancialOverview,
} from "./financialOverview";
import { createFinancialOverviewRepository } from "./financialOverviewRepository";
import { createGiftCheckoutLifecycleWorker } from "./giftCheckoutLifecycle";
import { createGiftCheckoutRepository } from "./giftCheckoutRepository";
import {
  createGiftCheckoutService,
  type GiftCheckoutProviderCommand,
} from "./giftCheckouts";
import { createGiftPaymentCheckoutLookup } from "./giftPaymentCheckoutLookup";
import type { GiftPaymentConfig } from "./giftPaymentConfig";
import { createGiftPaymentInboxRepository } from "./giftPaymentInboxRepository";
import { createGiftPaymentPostingRepository } from "./giftPaymentPostingRepository";
import { createGiftPaymentRestrictionWorker } from "./giftPaymentRestrictions";
import { createGiftPaymentWorker } from "./giftPaymentWorker";
import { createGiftPaymentWorkerLoop } from "./giftPaymentWorkerLoop";
import { findPublishedGiftForQuote } from "./giftQuoteLookup";
import { createGiftQuoteRepository } from "./giftQuoteRepository";
import { createGiftQuoteService } from "./giftQuotes";
import {
  decryptProviderCredential,
  type ProviderCredentialContext,
} from "./providerCredentials";
import {
  loadReceivingContext,
  loadReceivingContextInTransaction,
  readReceivingReadiness,
} from "./receivingRepository";
import { loadSandboxDemoPricing } from "./sandboxDemoPricing";
import { createWithdrawalComposition } from "./withdrawalComposition";
import { createWithdrawalHistoryRepository } from "./withdrawalHistoryRepository";

type PaymentPorts = Pick<
  ApiOptions,
  | "receiving"
  | "giftPayments"
  | "asaasWebhook"
  | "finance"
  | "withdrawalReservation"
>;
export interface GiftPaymentComposition {
  readonly ports: Readonly<PaymentPorts>;
  start(): void;
  close(): Promise<void>;
}
export interface GiftPaymentCompositionOptions {
  db: DatabaseConnection["db"];
  // This server-selected origin is checked against the site's registered origins.
  publicOrigin: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  refreshReceiving?: (siteId: string) => Promise<void>;
  resolveFeeProfile?: AsaasFeeQuotesOptions["resolveFeeProfile"];
  createWorkerLoop?: typeof createGiftPaymentWorkerLoop;
}
function unavailable(): never {
  throw new Error("Gift payment composition unavailable");
}

export function createGiftPaymentComposition(
  config: GiftPaymentConfig,
  options: GiftPaymentCompositionOptions,
): GiftPaymentComposition {
  if (config.mode === "disabled") {
    return Object.freeze({
      ports: Object.freeze({}),
      start() {},
      async close() {},
    });
  }
  if (
    (config.mode !== "sandbox" && config.mode !== "live") ||
    !["development", "test", "production"].includes(
      config.applicationEnvironment,
    ) ||
    (config.applicationEnvironment === "production" && config.mode !== "live")
  )
    return unavailable();
  const environment = config.mode;
  const keyring = new Map(
    [...config.credentialKeyring].map(([id, key]) => [id, new Uint8Array(key)]),
  );
  const db = options.db;
  const now = options.now ?? (() => new Date());
  const fetch = options.fetch ?? globalThis.fetch;
  const publicOrigin = new URL(options.publicOrigin).origin;
  if (publicOrigin !== options.publicOrigin) return unavailable();
  const instanceId = randomUUID();
  const receiving = Object.freeze({
    mode: environment,
    applicationEnvironment: config.applicationEnvironment,
    freshnessMs: 300_000,
    ...(options.refreshReceiving ? { refresh: options.refreshReceiving } : {}),
    now,
  });
  const reader = createAsaasStoredAccountReader(db, {
    mode: environment,
    applicationEnvironment: config.applicationEnvironment,
    keyring,
    fetch,
    timeoutMs: 15_000,
    maxResponseBytes: 262_144,
    now,
  });
  const withdrawals = createWithdrawalComposition(config, {
    db,
    now,
    fetch,
    ...(options.refreshReceiving
      ? { refreshReceiving: options.refreshReceiving }
      : {}),
  });
  const fees = createAsaasFeeQuotes({
    readAccountFees: reader.getAccountFees,
    // Account fees alone cannot establish consent or a future contractual guarantee.
    resolveFeeProfile: options.resolveFeeProfile ?? (async () => null),
    now,
    pricingFreshnessMs: 300_000,
    withdrawalFreshnessMs: 60_000,
  });
  const context = (siteId: string) =>
    loadReceivingContext(db, siteId, receiving);
  const gift = (siteId: string, giftId: string) =>
    findPublishedGiftForQuote(db, siteId, giftId, {
      now,
      readReadiness: (id) => readReceivingReadiness(db, id, receiving),
    });
  const quoteService = createGiftQuoteService({
    findPublishedGift: gift,
    loadReceivingContext: context,
    async loadPricingPolicy(scope) {
      if (
        config.applicationEnvironment === "development" &&
        environment === "sandbox"
      ) {
        const selected = await storedAccount(
          scope.siteId,
          scope.accountReference,
        );
        if (selected.isDemo) {
          if (
            selected.account.operatorReference !== scope.operatorReference ||
            selected.account.recipientReference !== scope.recipientReference
          )
            return null;
          return loadSandboxDemoPricing(
            scope,
            {
              provider: "ASAAS",
              siteId: scope.siteId,
              accountBindingId: selected.account.id,
              accountReference: scope.accountReference,
              environment: "sandbox",
              isDemo: true,
              applicationEnvironment: "development",
            },
            { readAccountFees: reader.getAccountFees, now },
          );
        }
      }
      return fees.loadPricingPolicy(scope);
    },
    repository: createGiftQuoteRepository(db, { now }),
    now,
    generateId: () => randomUUID(),
    quoteTtlMs: 300_000,
    pricingFreshnessMs: 300_000,
  });
  const checkoutRepository = createGiftCheckoutRepository(db, {
    instanceId,
    leaseMs: 60_000,
    now,
    async loadStoredReceivingContext(tx, scope) {
      const loaded = await loadReceivingContextInTransaction(
        tx,
        scope.siteId,
        receiving,
      );
      if (scope.environment !== environment) return null;
      return loaded;
    },
  });
  async function storedAccount(siteId: string, accountReference?: string) {
    const rows = await db
      .select({ account: receivingAccount, isDemo: site.isDemo })
      .from(receivingAccount)
      .innerJoin(site, eq(site.id, receivingAccount.siteId))
      .where(
        and(
          eq(receivingAccount.siteId, siteId),
          eq(receivingAccount.provider, "ASAAS"),
          eq(receivingAccount.environment, environment),
          eq(receivingAccount.isCurrent, true),
          accountReference
            ? eq(receivingAccount.accountReference, accountReference)
            : undefined,
        ),
      )
      .limit(2);
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row ||
      row.account.siteId !== siteId ||
      row.account.environment !== environment ||
      row.account.provider !== "ASAAS" ||
      row.account.isCurrent !== true ||
      typeof row.isDemo !== "boolean" ||
      (environment === "live" && row.isDemo) ||
      !row.account.accountReference ||
      (accountReference !== undefined &&
        row.account.accountReference !== accountReference)
    )
      return unavailable();
    return row;
  }
  async function createHostedCheckout(command: GiftCheckoutProviderCommand) {
    const binding = command.quoteSnapshot.receiving;
    if (
      binding.siteId !== command.siteId ||
      binding.environment !== environment
    )
      return unavailable();
    const { account, isDemo } = await storedAccount(
      command.siteId,
      binding.accountReference,
    );
    if (
      (command.quoteSnapshot.pricing.provenance === "local-test" ||
        command.quoteSnapshot.pricing.policy.feeBasis ===
          "OBSERVED_ESTIMATE") &&
      (config.applicationEnvironment !== "development" ||
        environment !== "sandbox" ||
        !isDemo)
    )
      return unavailable();
    if (
      account.operatorReference !== binding.operatorReference ||
      account.recipientReference !== binding.recipientReference ||
      account.credentialVersion !== 1 ||
      !account.credentialKeyId ||
      !account.credentialNonce ||
      !account.credentialCiphertext ||
      !account.credentialTag
    )
      return unavailable();
    const origins = await db
      .select({ origin: siteOrigin.origin })
      .from(siteOrigin)
      .where(
        and(
          eq(siteOrigin.siteId, command.siteId),
          eq(siteOrigin.origin, publicOrigin),
        ),
      )
      .limit(1);
    if (origins[0]?.origin !== publicOrigin) return unavailable();
    const credentialContext: ProviderCredentialContext = {
      provider: "ASAAS",
      siteId: command.siteId,
      accountBindingId: account.id,
      environment,
    };
    const accessToken = decryptProviderCredential(
      {
        version: 1,
        keyId: account.credentialKeyId,
        nonce: account.credentialNonce,
        ciphertext: account.credentialCiphertext,
        tag: account.credentialTag,
      },
      credentialContext,
      keyring,
    );
    const callback = new URL("/", publicOrigin).href;
    return createAsaasCheckoutClient({
      mode: environment,
      binding: { ...binding, accountBindingId: account.id },
      credentials: { context: credentialContext, accessToken },
      fetch,
      timeoutMs: 15_000,
      maxResponseBytes: 262_144,
      now,
      payload: {
        environment,
        platformWalletId: config.platformWalletId,
        publicOrigin,
        minutesToExpire: 60,
        ...(config.applicationEnvironment === "development" &&
        environment === "sandbox" &&
        isDemo
          ? {
              sandboxDemoPricing: {
                siteId: command.siteId,
                accountReference: binding.accountReference,
                isDemo: true,
                applicationEnvironment: "development" as const,
              },
            }
          : {}),
        callbacks: {
          successUrl: callback,
          cancelUrl: callback,
          expiredUrl: callback,
        },
      },
    }).createHostedCheckout(command);
  }
  const checkoutService = createGiftCheckoutService({
    repository: checkoutRepository,
    loadReceivingContext: context,
    findPublishedGift: gift,
    createHostedCheckout,
    now,
    generateId: () => randomUUID(),
  });
  const webhookRepository = createAsaasWebhookRepository(db, environment);
  const webhook = createAsaasWebhookReceiver({
    mode: environment,
    applicationEnvironment: config.applicationEnvironment,
    resolveBinding: webhookRepository.resolveBinding,
    repository: webhookRepository,
    now,
    generateId: () => randomUUID(),
  });
  const inbox = createGiftPaymentInboxRepository(db, {
    environment,
    instanceId,
    leaseMs: 60_000,
    maxAttempts: 12,
    retryDelayMs: 5_000,
    now,
    generateLeaseToken: randomUUID,
  });
  const worker = createGiftPaymentWorker({
    environment,
    inbox,
    loadCheckout: createGiftPaymentCheckoutLookup(db).loadCheckout,
    reader,
    posting: createGiftPaymentPostingRepository(db, {
      environment,
      platformWalletId: config.platformWalletId,
      retryDelayMs: 5_000,
      now,
      generateId: () => randomUUID(),
    }),
  });
  const lifecycle = createGiftCheckoutLifecycleWorker({
    db,
    environment,
    instanceId,
    reader,
    now,
  });
  const restrictions = createGiftPaymentRestrictionWorker({
    db,
    environment,
    instanceId,
    reader,
    now,
  });
  const loop = (options.createWorkerLoop ?? createGiftPaymentWorkerLoop)({
    worker: {
      async processNextReceivedPayment() {
        const results = await Promise.allSettled([
          worker.processNextReceivedPayment(),
          lifecycle.processNextReceivedPayment(),
          restrictions.processNextReceivedPayment(),
          withdrawals.reconcilePending(),
        ]);
        if (results.some((result) => result.status === "rejected"))
          return { kind: "RETRY" };
        const completed = results
          .slice(0, 3)
          .flatMap((result) =>
            result.status === "fulfilled" && result.value ? [result.value] : [],
          );
        return (
          completed.find((result) => result.kind !== "IDLE") ?? { kind: "IDLE" }
        );
      },
    },
    idleDelayMs: 1_000,
    retryDelayMs: 5_000,
    maxRetryDelayMs: 30_000,
  });
  const financeRepository = createFinancialOverviewRepository(db, {
    environment,
    now,
    ...(withdrawals.loadCompletionProofInTransaction
      ? {
          loadWithdrawalCompletionProofInTransaction:
            withdrawals.loadCompletionProofInTransaction,
        }
      : {}),
  });
  const withdrawalHistory = createWithdrawalHistoryRepository(db, {
    mode: environment,
  });
  let closing: Promise<void> | undefined;
  let stopped = false;
  let started = false;
  let run: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  function own<T>(operation: () => Promise<T>): Promise<T> {
    if (stopped)
      return Promise.reject(new Error("Gift payment composition unavailable"));
    const promise = Promise.resolve().then(operation);
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  }
  return Object.freeze({
    ports: Object.freeze({
      receiving,
      ...(withdrawals.service
        ? { withdrawalReservation: withdrawals.service }
        : {}),
      giftPayments: {
        createQuote: (siteId: unknown, input: unknown) =>
          own(() => quoteService.createQuote(siteId, input)),
        createCheckout: (siteId: unknown, input: unknown) =>
          own(() => checkoutService.createCheckout(siteId, input)),
        getStatus: (siteId: unknown, input: unknown) =>
          own(() => checkoutService.getStatus(siteId, input)),
      },
      asaasWebhook: {
        receive: (token: unknown, rawBody: unknown) =>
          own(() => webhook.receive(token, rawBody)),
      },
      finance: {
        listWithdrawals: (siteId: string) =>
          own(async () =>
            Promise.all(
              (await withdrawalHistory.listWithdrawals(siteId)).map(
                withdrawals.decorateIntent,
              ),
            ),
          ),
        readOverview: (siteId: string) =>
          own(async () => {
            const { account } = await storedAccount(siteId);
            const binding: FinancialAccountBinding = {
              provider: "ASAAS",
              siteId,
              accountBindingId: account.id,
              accountReference: account.accountReference as string,
              environment,
            };
            return loadFinancialOverview({
              mode: environment,
              binding,
              repository: financeRepository,
              providerBalance: reader,
              now,
              freshnessMs: 60_000,
            });
          }),
      },
    }),
    start() {
      if (stopped) return unavailable();
      if (!started) {
        started = true;
        run = loop.start();
        void run.catch(() => {});
      }
    },
    close() {
      if (closing) return closing;
      stopped = true;
      closing = (async () => {
        const workerStopping = started
          ? [Promise.resolve().then(() => loop.stop()), run]
          : [];
        const [, settled] = await Promise.all([
          Promise.allSettled([...pending]),
          Promise.allSettled(workerStopping),
        ]);
        await withdrawals.close();
        for (const key of keyring.values()) key.fill(0);
        keyring.clear();
        if (settled.some((result) => result.status === "rejected"))
          return unavailable();
      })();
      return closing;
    },
  });
}
