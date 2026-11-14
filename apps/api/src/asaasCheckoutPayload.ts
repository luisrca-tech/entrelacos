import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { giftQuoteSchema, publicGiftItemSchema } from "@entrelacos/contracts";
import {
  quoteGiftAmounts,
  quoteGiftPurchaseAmounts,
  serializeBrlCents,
} from "./giftMoney";
import {
  type GiftQuoteSnapshot,
  isPlatformAccountSplit,
  readGiftV2Settlement,
} from "./giftQuotes";
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

export function readAsaasCheckoutTerms(
  command: {
    siteId: string;
    attemptId: string;
    quoteSnapshot: GiftQuoteSnapshot;
  },
  options: AsaasCheckoutPayloadOptions,
) {
  try {
    const snapshot = command.quoteSnapshot;
    const quote = giftQuoteSchema.parse(snapshot.quote);
    const gift = publicGiftItemSchema.parse(snapshot.gift);
    const binding = snapshot.receiving;
    const pricing = snapshot.pricing;
    const demo = options.sandboxDemoPricing;
    // PLATFORM_ACCOUNT_SPLIT_V2 is priced only from the local tariff table;
    // that provenance is never accepted for a V1 quote.
    const platformSplit = isPlatformAccountSplit({ quote });
    const tariffPricing =
      pricing.provenance === "platform-tariff-table" &&
      pricing.policy.feeBasis === "PLATFORM_TARIFF_TABLE";
    if (platformSplit !== tariffPricing) unavailable();
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
      (pricing.provenance !== "provider" && !localTestPricing && !tariffPricing)
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
    const input = {
      nominalCents: quote.nominalCents,
      method: quote.method,
      policy: pricing.policy,
    };
    const amounts = quote.settlementVersion
      ? quoteGiftPurchaseAmounts(input, quote.installmentCount)
      : quoteGiftAmounts(input);
    for (const [field, amount] of Object.entries(amounts)) {
      if (!isDeepStrictEqual(amount, quote[field as keyof typeof quote]))
        unavailable();
    }
    const settlement = readGiftV2Settlement(quote, snapshot.settlement);
    const callback = readAsaasCheckoutCallbacks(
      options.publicOrigin,
      options.callbacks,
    );
    return {
      quote,
      callback,
      recipientReference: binding.recipientReference,
      ...(settlement ? { settlement } : {}),
    };
  } catch {
    return unavailable();
  }
}

export function buildAsaasCheckoutPayload(
  command: Parameters<typeof readAsaasCheckoutTerms>[0],
  options: AsaasCheckoutPayloadOptions,
): AsaasCheckoutPayload {
  const { quote, callback, recipientReference, settlement } =
    readAsaasCheckoutTerms(command, options);
  if ((quote.installmentCount ?? 1) > 1) unavailable();
  if (
    settlement &&
    (settlement.recipientSplitCents.length !== 1 ||
      settlement.recipientSplitCents[0] !== quote.nominalCents)
  )
    unavailable();
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
    splits: settlement
      ? // V2: charged in the main account; the couple receives the nominal
        // and the commission stays with the platform (no platform split).
        [
          {
            walletId: recipientReference,
            fixedValue: Number(serializeBrlCents(quote.nominalCents)),
          },
        ]
      : quote.commissionCents === 0
        ? []
        : [
            {
              walletId: options.platformWalletId,
              fixedValue: Number(serializeBrlCents(quote.commissionCents)),
            },
          ],
  };
}
