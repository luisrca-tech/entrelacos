import {
  decideGiftOrderTransition,
  type GiftCheckoutOrderBinding,
} from "./giftCheckoutLifecycle";
import type { GiftCheckoutIdentity } from "./giftCheckouts";
import type { GiftPaymentInboxClaim } from "./giftPaymentInboxRepository";
import type { GiftPaymentPostingRepository } from "./giftPaymentPostingRepository";
import { GIFT_PAYMENT_RECONCILE_AFTER_MS } from "./giftPaymentReconciliation";
import { PagarmeRejectedError } from "./pagarmeHttpClient";
import type {
  PagarmeOrderClient,
  PagarmeOrderObservation,
} from "./pagarmeOrderClient";

export interface GiftPaymentWorkerResult {
  kind:
    | "IDLE"
    | "DEAD_LETTER"
    | "POSTED"
    | "OBSERVED"
    | "DUPLICATE"
    | "NO_REGRESSION"
    | "RETRY"
    | "UNRESOLVED";
}

export interface GiftPaymentWorker {
  processNextReceivedPayment(): Promise<GiftPaymentWorkerResult>;
  /** Processes one specific inbox event now (e.g. the checkout's own re-read). */
  processDelivery?(deliveryId: string): Promise<GiftPaymentWorkerResult>;
}

export interface GiftPaymentWorkerOptions {
  inbox: {
    claimNext(): Promise<GiftPaymentInboxClaim | null>;
    claimDelivery?(deliveryId: string): Promise<GiftPaymentInboxClaim | null>;
    complete(
      claim: GiftPaymentInboxClaim,
      paymentId: string | null,
    ): Promise<void>;
    defer(
      claim: GiftPaymentInboxClaim,
      errorCode: string,
    ): Promise<"RETRY" | "DEAD_LETTER">;
  };
  checkouts: {
    loadBinding(identity: {
      siteId: string;
      attemptId: string;
    }): Promise<GiftCheckoutOrderBinding | null>;
    /** Binds an order recovered by code to an attempt whose outcome was unknown. */
    bindRecoveredOrder(
      binding: GiftCheckoutOrderBinding,
      order: PagarmeOrderObservation,
      observedAt: string,
    ): Promise<void>;
    /** Closes an attempt Pagar.me never created (no order with its code). */
    closeMissingOrder(
      binding: GiftCheckoutOrderBinding,
      observedAt: string,
    ): Promise<void>;
  };
  orders: Pick<PagarmeOrderClient, "getOrder" | "findOrderByCode">;
  posting: GiftPaymentPostingRepository;
  /** Re-reads the recipient (GET /recipients/{id}) and stores its state. */
  refreshReceiving?(siteId: string): Promise<void>;
  now(): Date;
}

export type { GiftCheckoutIdentity };

class Deferred extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * Claims one inbox event at a time. Webhook bodies are never trusted: order
 * and charge events re-read GET /orders/{id} (or GET /orders?code= when the
 * creation outcome is unknown) and recipient events re-read the recipient
 * before anything is posted.
 */
export function createGiftPaymentWorker(
  options: GiftPaymentWorkerOptions,
): GiftPaymentWorker {
  async function processOrder(claim: GiftPaymentInboxClaim) {
    const attemptId = claim.payload.externalReference;
    if (!attemptId) throw new Deferred("PAYMENT_CORRELATION_INVALID");
    const binding = await options.checkouts.loadBinding({
      siteId: claim.siteId,
      attemptId,
    });
    if (!binding || binding.accountId !== claim.accountId)
      throw new Deferred("CHECKOUT_BINDING_UNAVAILABLE");
    const orderId = claim.payload.checkoutId ?? binding.providerOrderId;
    let order: PagarmeOrderObservation | null;
    try {
      order = orderId
        ? await options.orders.getOrder(orderId)
        : await options.orders.findOrderByCode(binding.attemptId);
    } catch (error) {
      throw new Deferred(
        error instanceof PagarmeRejectedError
          ? "PROVIDER_READ_REJECTED"
          : "PROVIDER_READ_UNAVAILABLE",
      );
    }
    const now = options.now();
    if (order === null) {
      // Never created: close once the creating call is safely in the past.
      const created = Date.parse(binding.quoteExpiresAt);
      if (now.getTime() < created + GIFT_PAYMENT_RECONCILE_AFTER_MS)
        throw new Deferred("ORDER_NOT_FOUND_YET");
      await options.checkouts.closeMissingOrder(binding, now.toISOString());
      return null;
    }
    if (binding.providerOrderId === null) {
      if (order.code !== binding.attemptId)
        throw new Deferred("PAYMENT_CORRELATION_INVALID");
      await options.checkouts.bindRecoveredOrder(
        binding,
        order,
        now.toISOString(),
      );
    }
    const transition = decideGiftOrderTransition(binding, order, now);
    const result = await options.posting.applyOrderTransition({
      binding,
      providerOrderId: order.id,
      transition,
      eventId: claim.eventId,
      observedAt: now,
    });
    return result;
  }

  async function run(
    take: () => Promise<GiftPaymentInboxClaim | null>,
  ): Promise<GiftPaymentWorkerResult> {
    let claim: GiftPaymentInboxClaim | null;
    try {
      claim = await take();
    } catch {
      return { kind: "RETRY" };
    }
    if (claim === null) return { kind: "IDLE" };
    try {
      if (claim.eventType === "RECIPIENT_UPDATED") {
        if (!options.refreshReceiving)
          throw new Deferred("RECEIVING_REFRESH_UNAVAILABLE");
        try {
          await options.refreshReceiving(claim.siteId);
        } catch {
          throw new Deferred("PROVIDER_READ_UNAVAILABLE");
        }
        await options.inbox.complete(claim, null);
        return { kind: "OBSERVED" };
      }
      const result = await processOrder(claim);
      await options.inbox.complete(claim, result?.paymentId ?? null);
      if (result?.outcome === "POSTED") return { kind: "POSTED" };
      if (result?.outcome === "UNCHANGED") return { kind: "DUPLICATE" };
      return { kind: "OBSERVED" };
    } catch (error) {
      const code =
        error instanceof Deferred ? error.code : "PAYMENT_POSTING_UNAVAILABLE";
      try {
        return {
          kind:
            (await options.inbox.defer(claim, code)) === "DEAD_LETTER"
              ? "DEAD_LETTER"
              : "RETRY",
        };
      } catch {
        return { kind: "UNRESOLVED" };
      }
    }
  }

  return {
    processNextReceivedPayment: () => run(() => options.inbox.claimNext()),
    async processDelivery(deliveryId) {
      const claimDelivery = options.inbox.claimDelivery;
      if (!claimDelivery) return { kind: "IDLE" };
      return run(() => claimDelivery(deliveryId));
    },
  };
}
