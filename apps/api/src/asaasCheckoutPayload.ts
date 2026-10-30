import { isIP } from "node:net";
import { giftQuoteSchema, publicGiftItemSchema } from "@entrelacos/contracts";
import { quoteGiftAmounts, serializeBrlCents } from "./giftMoney";
import type { GiftQuoteSnapshot } from "./giftQuotes";
import { allowsSandboxBuyerGrossUp } from "./sandboxBuyerGrossUp";

export interface AsaasCheckoutPayload {
  billingTypes: Array<"PIX" | "CREDIT_CARD">;
  chargeTypes: ["DETACHED"];
  minutesToExpire: number;
  externalReference: string;
  callback: { successUrl: string; cancelUrl: string; expiredUrl: string };
  items: [{ name: string; quantity: 1; value: number }];
  splits: Array<{ walletId: string; fixedValue: number }>;
}

export interface AsaasCheckoutPayloadOptions {
  sandboxBuyerGrossUpSiteId?: string;
  // Selected only after reading the persisted demo site and account in development.
  sandboxDemoPricing?: {
    siteId: string;
    accountReference: string;
    isDemo: boolean;
    applicationEnvironment: "development" | "test" | "production";
  };

  environment: "sandbox" | "live";
  platformWalletId: string;
  // Selected from the stored site's registered public origin, never a guest body.
  publicOrigin: string;
  callbacks: AsaasCheckoutPayload["callback"];
  minutesToExpire: number;
}

function unavailable(): never {
  throw new Error("Checkout payload unavailable");
}
function reference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  );
}

// Browser-side loopback origins remain useful locally, but must not be sent to the PSP.
// A syntactically valid callback still requires an operator-verified, registered destination.
export function readAsaasCheckoutCallbacks(
  publicOrigin: string,
  callbacks: AsaasCheckoutPayload["callback"],
): AsaasCheckoutPayload["callback"] {
  try {
    const origin = new URL(publicOrigin);
    const hostname = origin.hostname.replace(/\.$/, "").toLowerCase();
    if (
      origin.protocol !== "https:" ||
      !hostname.includes(".") ||
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      isIP(hostname.replace(/^\[|\]$/g, "")) !== 0 ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      unavailable();
    const result = {} as AsaasCheckoutPayload["callback"];
    for (const field of ["successUrl", "cancelUrl", "expiredUrl"] as const) {
      const url = new URL(callbacks[field]);
      if (
        url.protocol !== "https:" ||
        url.origin !== origin.origin ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        unavailable();
      result[field] = url.href;
    }
    return result;
  } catch {
    return unavailable();
  }
}

export function buildAsaasCheckoutPayload(
  command: {
    siteId: string;
    attemptId: string;
    quoteSnapshot: GiftQuoteSnapshot;
  },
  options: AsaasCheckoutPayloadOptions,
): AsaasCheckoutPayload {
  try {
    const snapshot = command.quoteSnapshot;
    const quote = giftQuoteSchema.parse(snapshot.quote);
    const gift = publicGiftItemSchema.parse(snapshot.gift);
    const binding = snapshot.receiving;
    const pricing = snapshot.pricing;
    const demo = options.sandboxDemoPricing;
    const localTestPricing =
      pricing.provenance === "local-test" &&
      options.environment === "sandbox" &&
      demo?.applicationEnvironment === "development" &&
      demo.isDemo === true &&
      demo.siteId === command.siteId &&
      demo.accountReference === binding.accountReference;
    if (
      pricing.policy.feeBasis === "SANDBOX_BUYER_ESTIMATE" &&
      (!demo ||
        pricing.provenance !== "provider" ||
        demo.accountReference !== binding.accountReference ||
        demo.siteId !== command.siteId ||
        !allowsSandboxBuyerGrossUp({
          ...demo,
          siteId: command.siteId,
          environment: options.environment,
          sandboxBuyerGrossUpSiteId: options.sandboxBuyerGrossUpSiteId,
        }))
    )
      unavailable();
    if (
      quote.siteId !== command.siteId ||
      gift.siteId !== command.siteId ||
      gift.id !== quote.giftId ||
      gift.nominalCents !== quote.nominalCents ||
      gift.title !== quote.title ||
      binding.siteId !== command.siteId ||
      binding.provider.toUpperCase() !== "ASAAS" ||
      quote.mode !== options.environment ||
      binding.environment !== options.environment ||
      (options.environment !== "sandbox" && options.environment !== "live") ||
      !reference(command.attemptId) ||
      !reference(options.platformWalletId) ||
      options.platformWalletId === binding.recipientReference ||
      !Number.isInteger(options.minutesToExpire) ||
      options.minutesToExpire < 10 ||
      options.minutesToExpire > 1440 ||
      pricing.verification !== "verified" ||
      (pricing.provenance !== "provider" && !localTestPricing)
    )
      unavailable();
    for (const field of [
      "siteId",
      "provider",
      "operatorReference",
      "environment",
      "accountReference",
      "recipientReference",
      "destinationVersion",
      "bankReference",
    ] as const) {
      if (binding[field] !== pricing[field]) unavailable();
    }
    const amounts = quoteGiftAmounts({
      nominalCents: quote.nominalCents,
      method: quote.method,
      policy: pricing.policy,
    });
    for (const field of [
      "nominalCents",
      "commissionCents",
      "processingCents",
      "totalCents",
      "policyVersion",
      "feeAllocation",
    ] as const) {
      if (amounts[field] !== quote[field]) unavailable();
    }
    const callback = readAsaasCheckoutCallbacks(
      options.publicOrigin,
      options.callbacks,
    );
    return {
      billingTypes: [quote.method],
      chargeTypes: ["DETACHED"],
      minutesToExpire: options.minutesToExpire,
      externalReference: command.attemptId,
      callback,
      items: [
        {
          name: quote.title,
          quantity: 1,
          value: Number(serializeBrlCents(quote.totalCents)),
        },
      ],
      splits:
        quote.commissionCents === 0
          ? []
          : [
              {
                walletId: options.platformWalletId,
                fixedValue: Number(serializeBrlCents(quote.commissionCents)),
              },
            ],
    };
  } catch {
    return unavailable();
  }
}
