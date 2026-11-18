import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  giftMinimumNominalCents,
  type PublicGiftItem,
} from "@entrelacos/contracts";
import type { DatabaseConnection } from "@entrelacos/database";
import {
  receivingAccount,
  site,
  siteOrigin,
} from "@entrelacos/database/schema";
import { and, eq } from "drizzle-orm";
import type { ApiOptions } from "./app";
import { createAsaasCheckoutClient } from "./asaasCheckoutClient";
import { readAsaasCheckoutCallbacks } from "./asaasCheckoutPayload";
import type { AsaasFeeQuotesOptions } from "./asaasFeeQuotes";
import type { AsaasStoredAccountReader } from "./asaasHttpClient";
import type { AsaasLegacyConfig } from "./asaasLegacyConfig";
import { createAsaasWebhookReceiver } from "./asaasWebhook";
import { createAsaasWebhookRepository } from "./asaasWebhookRepository";
import { createGiftCheckoutLifecycleWorker } from "./giftCheckoutLifecycle";
import { createGiftCheckoutRepository } from "./giftCheckoutRepository";
import {
  createGiftCheckoutService,
  type GiftCheckoutProviderCommand,
  GiftCheckoutServiceError,
} from "./giftCheckouts";
import { platformTariffPolicy, quoteGiftPurchaseAmounts } from "./giftMoney";
import { createGiftPaymentAdjustmentWorker } from "./giftPaymentAdjustmentWorker";
import { createGiftPaymentCheckoutLookup } from "./giftPaymentCheckoutLookup";
import { createGiftPaymentInboxRepository } from "./giftPaymentInboxRepository";
import { createGiftPaymentPostingRepository } from "./giftPaymentPostingRepository";
import { createGiftPaymentRestrictionWorker } from "./giftPaymentRestrictions";
import { createGiftPaymentWorker } from "./giftPaymentWorker";
import { createGiftPaymentWorkerLoop } from "./giftPaymentWorkerLoop";
import { previewGiftPricing } from "./giftPricingPreview";
import { findPublishedGiftForQuote } from "./giftQuoteLookup";
import { createGiftQuoteRepository } from "./giftQuoteRepository";
import {
  createGiftQuoteService,
  type GiftQuoteServiceDependencies,
  isPlatformAccountSplit,
  loadGiftPricingEvidence,
} from "./giftQuotes";
import { allowsLiveSite } from "./liveSitePolicy";
import { logObservabilityEvent } from "./observability";
import {
  loadReceivingContext,
  loadReceivingContextInTransaction,
  readReceivingReadiness,
} from "./receivingRepository";
import { allowsSandboxBuyerGrossUp } from "./sandboxBuyerGrossUp";

type PaymentPorts = Pick<
  ApiOptions,
  | "receiving"
  | "giftPayments"
  | "previewPricing"
  | "loadPublicGiftPrices"
  | "sandboxBuyerGrossUpAvailable"
  | "asaasWebhook"
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

function inertAsaasReader(): AsaasStoredAccountReader {
  const fail = async (): Promise<never> => unavailable();
  return {
    hasInternalTransferCredit: fail,
    hasUnrestrictedGiftPayment: fail,
    listInstallmentPayments: fail,
    removeInstallment: fail,
    getInstallmentRemoval: fail,
    listCheckoutPayments: fail,
    getAccountFees: fail,
    getPayment: fail,
    getBalance: fail,
  };
}

export function createGiftPaymentComposition(
  config: AsaasLegacyConfig,
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
  const liveSitePolicy = Object.freeze({
    applicationEnvironment: config.applicationEnvironment,
    liveDemoSiteIds: config.liveDemoSiteIds,
  });
  const keyring = new Map(
    [...config.credentialKeyring].map(([id, key]) => [id, new Uint8Array(key)]),
  );
  const db = options.db;
  const now = options.now ?? (() => new Date());
  const fetch = options.fetch ?? globalThis.fetch;
  const publicOrigin = new URL(options.publicOrigin).origin;
  if (publicOrigin !== options.publicOrigin) return unavailable();
  const callback = new URL("/", publicOrigin).href;
  const callbacks = {
    successUrl: callback,
    cancelUrl: callback,
    expiredUrl: callback,
  };
  const instanceId = randomUUID();
  function wakeWorker() {
    try {
      loop.wake();
    } catch {
      // The startup and safety sweeps recover work if the local signal fails.
    }
  }
  const receiving = Object.freeze({
    mode: environment,
    ...liveSitePolicy,
    freshnessMs: 300_000,
    ...(options.refreshReceiving ? { refresh: options.refreshReceiving } : {}),
    now,
  });
  // The legacy Asaas account reader was removed with the Pagar.me withdrawal
  // migration; this composition only ever receives the disabled config.
  const reader = inertAsaasReader();
  const context = (siteId: string) =>
    loadReceivingContext(db, siteId, receiving);
  const gift = (siteId: string, giftId: string) =>
    findPublishedGiftForQuote(db, siteId, giftId, {
      ...liveSitePolicy,
      now,
      readReadiness: (id) => readReceivingReadiness(db, id, receiving),
    });
  const quoteDependencies: GiftQuoteServiceDependencies = {
    sandboxBuyerGrossUpSiteId: config.sandboxBuyerGrossUpSiteId,
    findPublishedGift: gift,
    loadReceivingContext: context,
    // PLATFORM_ACCOUNT_SPLIT_V2: every new quote is priced from the local
    // platform tariff table (giftTariffs.ts), without a provider fee read.
    async loadPricingPolicy(scope) {
      const selected = await storedAccount(
        scope.siteId,
        scope.accountReference,
      );
      if (
        selected.account.operatorReference !== scope.operatorReference ||
        selected.account.recipientReference !== scope.recipientReference ||
        scope.recipientReference === config.platformWalletId ||
        (scope.feeAllocation !== undefined &&
          scope.feeAllocation !== "BUYER_GROSS_UP")
      )
        return null;
      const observedAt = now();
      return {
        ...scope,
        verification: "verified",
        provenance: "platform-tariff-table",
        observedAt,
        expiresAt: new Date(observedAt.getTime() + 300_000),
        policy: platformTariffPolicy(scope.method),
      };
    },
    repository: createGiftQuoteRepository(db, { now }),
    now,
    generateId: () => randomUUID(),
    quoteTtlMs: 300_000,
    pricingFreshnessMs: 300_000,
  };
  const quoteService = createGiftQuoteService(quoteDependencies);
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
      (environment === "live" &&
        row.isDemo &&
        !allowsLiveSite({
          siteId,
          isDemo: row.isDemo,
          mode: environment,
          ...liveSitePolicy,
        })) ||
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
    const developmentDemo =
      config.applicationEnvironment === "development" &&
      environment === "sandbox" &&
      isDemo;
    if (
      command.quoteSnapshot.pricing.policy.feeBasis ===
        "SANDBOX_BUYER_ESTIMATE" &&
      !allowsSandboxBuyerGrossUp({
        siteId: command.siteId,
        sandboxBuyerGrossUpSiteId: config.sandboxBuyerGrossUpSiteId,
        isDemo,
        applicationEnvironment: config.applicationEnvironment,
        environment,
      })
    )
      return unavailable();
    const liveRecipient = allowsLiveSite({
      siteId: command.siteId,
      isDemo,
      mode: environment,
      ...liveSitePolicy,
    });
    if (
      (command.quoteSnapshot.pricing.provenance === "local-test" &&
        !developmentDemo) ||
      (command.quoteSnapshot.pricing.policy.feeBasis === "OBSERVED_ESTIMATE" &&
        !developmentDemo &&
        !(
          liveRecipient &&
          command.quoteSnapshot.pricing.provenance === "provider"
        ))
    )
      return unavailable();
    // Sub-account credentials no longer exist: only platform-account
    // (PLATFORM_ACCOUNT_SPLIT_V2) charges can be created until Phase 3.
    if (
      !isPlatformAccountSplit(command.quoteSnapshot) ||
      account.operatorReference !== binding.operatorReference ||
      account.recipientReference !== binding.recipientReference
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
    return createAsaasCheckoutClient({
      mode: environment,
      binding: { ...binding, accountBindingId: account.id },
      credentials: {
        kind: "PLATFORM_ACCOUNT",
        accessToken: config.platformApiKey,
      },
      fetch,
      timeoutMs: 15_000,
      maxResponseBytes: 262_144,
      now,
      payload: {
        sandboxBuyerGrossUpSiteId: config.sandboxBuyerGrossUpSiteId,
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
        callbacks,
      },
    }).createHostedCheckout(command);
  }
  const checkoutService = createGiftCheckoutService({
    sandboxBuyerGrossUpSiteId: config.sandboxBuyerGrossUpSiteId,
    observe: logObservabilityEvent,
    assertProviderConfiguration() {
      try {
        readAsaasCheckoutCallbacks(publicOrigin, callbacks);
      } catch {
        throw new GiftCheckoutServiceError("CHECKOUT_CONFIGURATION_INVALID");
      }
    },
    async revalidateQuote(snapshot) {
      try {
        const current = await createGiftQuoteService({
          ...quoteDependencies,
          repository: { append: async () => {} },
        }).createQuote(snapshot.quote.siteId, {
          giftId: snapshot.quote.giftId,
          method: snapshot.quote.method,
          ...(snapshot.quote.installmentCount === undefined
            ? {}
            : { installmentCount: snapshot.quote.installmentCount }),
        });
        return (
          [
            "nominalCents",
            "commissionCents",
            "processingCents",
            "totalCents",
            "feeAllocation",
            "policyVersion",
            "title",
            "installmentCount",
            "installmentCents",
            // A not-yet-issued V1 reservation never matches a new V2 quote,
            // so the guest is sent back for fresh V2 terms (spec e.3).
            "settlementVersion",
            "anticipationCents",
          ] as const
        ).every((key) => isDeepStrictEqual(current[key], snapshot.quote[key]));
      } catch {
        return false;
      }
    },
    repository: {
      ...checkoutRepository,
      async saveHostedCheckout(outcome) {
        const stored = await checkoutRepository.saveHostedCheckout(outcome);
        wakeWorker();
        return stored;
      },
    },
    loadReceivingContext: context,
    findPublishedGift: gift,
    createHostedCheckout,
    now,
    generateId: () => randomUUID(),
  });
  async function loadPublicGiftPrices(
    siteId: string,
    gifts: readonly Pick<PublicGiftItem, "id" | "nominalCents">[],
  ) {
    const prices = new Map<string, number>();
    const eligible = gifts.filter(
      (gift) => gift.nominalCents >= giftMinimumNominalCents,
    );
    if (!eligible.length) return prices;
    const policies = await Promise.allSettled(
      (["PIX", "CREDIT_CARD"] as const).map((method) =>
        loadGiftPricingEvidence(
          quoteDependencies,
          siteId,
          method,
          "BUYER_GROSS_UP",
        ),
      ),
    );
    for (const result of policies) {
      if (result.status !== "fulfilled") continue;
      const policy = {
        ...result.value.pricing.policy,
        feeAllocation: "BUYER_GROSS_UP",
      } as const;
      for (const gift of eligible) {
        try {
          const amounts = quoteGiftPurchaseAmounts({
            nominalCents: gift.nominalCents,
            method: policy.method,
            policy,
          });
          const minimum = amounts.installmentOptions
            ? Math.min(
                ...amounts.installmentOptions.map(
                  (option) => option.totalCents,
                ),
              )
            : amounts.totalCents;
          prices.set(
            gift.id,
            Math.min(prices.get(gift.id) ?? minimum, minimum),
          );
        } catch {
          // A fee or amount unavailable for one method does not hide other methods.
        }
      }
    }
    return prices;
  }
  const webhookRepository = createAsaasWebhookRepository(db, environment);
  const webhook = createAsaasWebhookReceiver({
    mode: environment,
    ...liveSitePolicy,
    resolveBinding: webhookRepository.resolveBinding,
    platform: {
      webhookTokenHash: config.platformWebhookTokenHash,
      accountReference: config.platformAccountId,
      route: webhookRepository.routePlatformEvent,
      recordUnroutable: webhookRepository.recordUnroutable,
    },
    repository: {
      async append(input) {
        const result = await webhookRepository.append(input);
        if (result === "INSERTED") wakeWorker();
        return result;
      },
    },
    now,
    generateId: () => randomUUID(),
  });
  const inbox = createGiftPaymentInboxRepository(db, {
    ...liveSitePolicy,
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
    ...liveSitePolicy,
    db,
    environment,
    instanceId,
    reader,
    now,
  });
  const restrictions = createGiftPaymentRestrictionWorker({
    ...liveSitePolicy,
    db,
    environment,
    instanceId,
    reader,
    now,
  });
  const adjustments = createGiftPaymentAdjustmentWorker(db, {
    ...liveSitePolicy,
    environment,
    platformApiKey: config.platformApiKey,
    platformWalletId: config.platformWalletId,
    fetch,
    now,
    reader,
  });
  const loop = (options.createWorkerLoop ?? createGiftPaymentWorkerLoop)({
    worker: {
      async processNextReceivedPayment() {
        const results = await Promise.allSettled([
          worker.processNextReceivedPayment(),
          lifecycle.processNextReceivedPayment(),
          lifecycle.expireNextUnpaidInstallment(),
          restrictions.processNextReceivedPayment(),
          adjustments.processNextReceivedPayment(),
        ]);
        const completed = results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        if (results.some(({ status }) => status === "rejected")) {
          completed.push({ kind: "RETRY" });
        }
        return (
          completed.find(
            ({ kind }) => !["IDLE", "RETRY", "UNRESOLVED"].includes(kind),
          ) ??
          completed.find(({ kind }) => kind !== "IDLE") ?? { kind: "IDLE" }
        );
      },
    },
    async nextDueAt() {
      const deadlines = await Promise.allSettled([
        inbox.nextDueAt(),
        lifecycle.nextDueAt(),
        lifecycle.nextExpiryDueAt(),
        restrictions.nextDueAt(),
        adjustments.nextDueAt(),
      ]);
      let earliest = Infinity;
      for (const deadline of deadlines) {
        if (deadline.status === "rejected") throw deadline.reason;
        if (deadline.value !== null)
          earliest = Math.min(earliest, deadline.value);
      }
      return earliest === Infinity ? null : earliest;
    },
    idleDelayMs: 30 * 60_000,
    retryDelayMs: 5_000,
    maxRetryDelayMs: 30 * 60_000,
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
      sandboxBuyerGrossUpAvailable: (siteId: string) =>
        own(async () => {
          if (
            config.applicationEnvironment !== "development" ||
            environment !== "sandbox" ||
            siteId !== config.sandboxBuyerGrossUpSiteId
          )
            return false;
          const stored = await context(siteId);
          return (
            stored !== null &&
            stored.providerBinding?.environment === "sandbox" &&
            allowsSandboxBuyerGrossUp({
              siteId,
              sandboxBuyerGrossUpSiteId: config.sandboxBuyerGrossUpSiteId,
              isDemo: stored.isDemo,
              applicationEnvironment: stored.environment,
              environment: stored.mode,
            })
          );
        }),
      previewPricing: (siteId: string, input: unknown) =>
        own(() => previewGiftPricing(quoteDependencies, siteId, input)),
      loadPublicGiftPrices: (
        siteId: string,
        gifts: readonly Pick<PublicGiftItem, "id" | "nominalCents">[],
      ) => own(() => loadPublicGiftPrices(siteId, gifts)),
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
        for (const key of keyring.values()) key.fill(0);
        keyring.clear();
        if (settled.some((result) => result.status === "rejected"))
          return unavailable();
      })();
      return closing;
    },
  });
}
