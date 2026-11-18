import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  giftMinimumNominalCents,
  type PublicGiftItem,
} from "@entrelacos/contracts";
import type { DatabaseConnection } from "@entrelacos/database";
import { receivingAccount, site } from "@entrelacos/database/schema";
import { and, eq } from "drizzle-orm";
import type { ApiOptions } from "./app";
import { createGiftCheckoutRepository } from "./giftCheckoutRepository";
import { createGiftCheckoutService } from "./giftCheckouts";
import { platformTariffPolicy, quoteGiftPurchaseAmounts } from "./giftMoney";
import type { GiftPaymentConfig } from "./giftPaymentConfig";
import { createGiftPaymentInboxRepository } from "./giftPaymentInboxRepository";
import { createGiftPaymentPostingRepository } from "./giftPaymentPostingRepository";
import { createGiftPaymentReconciliation } from "./giftPaymentReconciliation";
import { createGiftPaymentWorker } from "./giftPaymentWorker";
import { createGiftPaymentWorkerLoop } from "./giftPaymentWorkerLoop";
import { previewGiftPricing } from "./giftPricingPreview";
import { findPublishedGiftForQuote } from "./giftQuoteLookup";
import { createGiftQuoteRepository } from "./giftQuoteRepository";
import {
  createGiftQuoteService,
  type GiftQuoteServiceDependencies,
  loadGiftPricingEvidence,
} from "./giftQuotes";
import { allowsLiveSite } from "./liveSitePolicy";
import { logObservabilityEvent } from "./observability";
import { createPagarmeOrderClient } from "./pagarmeOrderClient";
import { createPagarmeWebhookReceiver } from "./pagarmeWebhook";
import {
  loadReceivingContext,
  loadReceivingContextInTransaction,
  readReceivingReadiness,
} from "./receivingRepository";

type PaymentPorts = Pick<
  ApiOptions,
  | "receiving"
  | "giftPayments"
  | "previewPricing"
  | "loadPublicGiftPrices"
  | "sandboxBuyerGrossUpAvailable"
  | "pagarmeWebhook"
>;
export interface GiftPaymentComposition {
  readonly ports: Readonly<PaymentPorts>;
  start(): void;
  close(): Promise<void>;
}
export interface GiftPaymentCompositionOptions {
  db: DatabaseConnection["db"];
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  refreshReceiving?: (siteId: string) => Promise<void>;
  createWorkerLoop?: typeof createGiftPaymentWorkerLoop;
}

function unavailable(): never {
  throw new Error("Gift payment composition unavailable");
}

export function createGiftPaymentComposition(
  settings: GiftPaymentConfig,
  options: GiftPaymentCompositionOptions,
): GiftPaymentComposition {
  if (settings.mode === "disabled") {
    return Object.freeze({
      ports: Object.freeze({}),
      start() {},
      async close() {},
    });
  }
  const config = settings;
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
  const db = options.db;
  const now = options.now ?? (() => new Date());
  const instanceId = randomUUID();
  const orders = createPagarmeOrderClient({
    secretKey: config.secretKey,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    timeoutMs: 15_000,
  });
  function wakeWorker() {
    try {
      loop.wake();
    } catch {
      // The scheduled sweep recovers work if the local signal fails.
    }
  }
  const receiving = Object.freeze({
    mode: environment,
    ...liveSitePolicy,
    freshnessMs: 300_000,
    ...(options.refreshReceiving ? { refresh: options.refreshReceiving } : {}),
    now,
  });
  const context = (siteId: string) =>
    loadReceivingContext(db, siteId, receiving);
  const gift = (siteId: string, giftId: string) =>
    findPublishedGiftForQuote(db, siteId, giftId, {
      ...liveSitePolicy,
      now,
      readReadiness: (id) => readReceivingReadiness(db, id, receiving),
    });
  async function currentRecipient(siteId: string, accountReference?: string) {
    const rows = await db
      .select({ account: receivingAccount, isDemo: site.isDemo })
      .from(receivingAccount)
      .innerJoin(site, eq(site.id, receivingAccount.siteId))
      .where(
        and(
          eq(receivingAccount.siteId, siteId),
          eq(receivingAccount.provider, "PAGARME"),
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
      !row.account.recipientReference ||
      row.account.recipientReference === config.platformRecipientId ||
      (environment === "live" &&
        row.isDemo &&
        !allowsLiveSite({
          siteId,
          isDemo: row.isDemo,
          mode: environment,
          ...liveSitePolicy,
        }))
    )
      return unavailable();
    return row;
  }
  const quoteDependencies: GiftQuoteServiceDependencies = {
    findPublishedGift: gift,
    loadReceivingContext: context,
    // Every quote is priced from the local Pagar.me tariff table (giftTariffs.ts).
    async loadPricingPolicy(scope) {
      const selected = await currentRecipient(
        scope.siteId,
        scope.accountReference,
      );
      if (
        selected.account.operatorReference !== scope.operatorReference ||
        selected.account.recipientReference !== scope.recipientReference ||
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
      if (scope.environment !== environment) return null;
      return loadReceivingContextInTransaction(tx, scope.siteId, receiving);
    },
  });
  const inbox = createGiftPaymentInboxRepository(db, {
    environment,
    instanceId,
    leaseMs: 60_000,
    maxAttempts: 12,
    retryDelayMs: 5_000,
    now,
    generateId: () => randomUUID(),
  });
  const posting = createGiftPaymentPostingRepository(db, {
    generateId: () => randomUUID(),
  });
  const reconciliation = createGiftPaymentReconciliation(db, {
    environment,
    now,
    enqueue: (tx, target, sequence) =>
      inbox.enqueueReconcile(tx, target, sequence),
    onEnqueued: wakeWorker,
  });
  const worker = createGiftPaymentWorker({
    inbox,
    checkouts: checkoutRepository,
    orders,
    posting,
    ...(options.refreshReceiving
      ? { refreshReceiving: options.refreshReceiving }
      : {}),
    now,
  });
  const checkoutService = createGiftCheckoutService({
    observe: logObservabilityEvent,
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
            "settlementVersion",
            "anticipationCents",
          ] as const
        ).every((key) => isDeepStrictEqual(current[key], snapshot.quote[key]));
      } catch {
        return false;
      }
    },
    repository: checkoutRepository,
    loadReceivingContext: context,
    findPublishedGift: gift,
    orders,
    platformRecipientId: config.platformRecipientId,
    // A card is usually decided in the creating call: let the worker re-read
    // and post it right away instead of waiting for the webhook.
    async applyOrder(binding, order) {
      const result = await db.transaction((tx) =>
        inbox.enqueueReconcile(
          tx,
          {
            siteId: binding.siteId,
            accountId: binding.accountId,
            environment: binding.environment,
            attemptId: binding.attemptId,
            providerOrderId: order.id,
          },
          "created",
        ),
      );
      if (result === "INSERTED") wakeWorker();
    },
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
  const webhook = createPagarmeWebhookReceiver({
    webhookCredentialsHash: config.webhookCredentialsHash,
    repository: inbox,
    now,
    onInserted: wakeWorker,
  });
  const loop = (options.createWorkerLoop ?? createGiftPaymentWorkerLoop)({
    worker: {
      async processNextReceivedPayment() {
        const results = await Promise.allSettled([
          worker.processNextReceivedPayment(),
          reconciliation.processNextReceivedPayment(),
        ]);
        const completed = results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        if (results.some(({ status }) => status === "rejected"))
          completed.push({ kind: "RETRY" });
        return (
          completed.find(
            ({ kind }) => !["IDLE", "RETRY", "UNRESOLVED"].includes(kind),
          ) ??
          completed.find(({ kind }) => kind !== "IDLE") ?? { kind: "IDLE" }
        );
      },
    },
    async nextDueAt() {
      const deadlines = await Promise.all([
        inbox.nextDueAt(),
        reconciliation.nextDueAt(),
      ]);
      const due = deadlines.filter((value): value is number => value !== null);
      return due.length ? Math.min(...due) : null;
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
      sandboxBuyerGrossUpAvailable: async () => false,
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
      pagarmeWebhook: {
        receive: (authorization: string | undefined, rawBody: unknown) =>
          own(() => webhook.receive(authorization, rawBody)),
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
        if (settled.some((result) => result.status === "rejected"))
          return unavailable();
      })();
      return closing;
    },
  });
}
