// Test-only builders shared by the checkout, worker and database suites.
import type { GiftQuote } from "@entrelacos/contracts";
import { platformTariffPolicy, quoteGiftPurchaseAmounts } from "./giftMoney";
import {
  buildGiftV2Settlement,
  type GiftQuoteReceivingContext,
  type GiftQuoteSnapshot,
} from "./giftQuotes";

export interface PagarmeQuoteFixtureInput {
  siteId: string;
  quoteId: string;
  giftId: string;
  method: "PIX" | "CREDIT_CARD";
  installments?: number;
  nominalCents?: number;
  createdAt: Date;
  expiresAt: Date;
  recipientId: string;
  operatorReference: string;
  bankReference: string;
  title?: string;
  provider?: string;
}

/** A frozen V2 (Pagar.me tariff table) quote snapshot, as the quote service stores it. */
export function pagarmeQuoteSnapshot(
  input: PagarmeQuoteFixtureInput,
): GiftQuoteSnapshot {
  const nominalCents = input.nominalCents ?? 10_000;
  const title = input.title ?? "Jantar no Porto";
  const policy = platformTariffPolicy(input.method);
  const amounts = quoteGiftPurchaseAmounts(
    { nominalCents, method: input.method, policy },
    input.method === "CREDIT_CARD" ? (input.installments ?? 1) : undefined,
  );
  const quote: GiftQuote = {
    ...amounts,
    id: input.quoteId,
    giftId: input.giftId,
    siteId: input.siteId,
    title,
    method: input.method,
    currency: "BRL",
    commissionBasisPoints: 200,
    settlementVersion: "PLATFORM_ACCOUNT_SPLIT_V2",
    expiresAt: input.expiresAt.toISOString(),
    mode: "sandbox",
  } as GiftQuote;
  const receiving = {
    siteId: input.siteId,
    provider: input.provider ?? "PAGARME",
    operatorReference: input.operatorReference,
    accountReference: input.recipientId,
    recipientReference: input.recipientId,
    bankReference: input.bankReference,
    destinationVersion: 1,
    environment: "sandbox" as const,
  };
  return {
    pricingSettings: { feeAllocation: "BUYER_GROSS_UP", revision: 0 },
    quote,
    gift: {
      id: input.giftId,
      siteId: input.siteId,
      title,
      description: "",
      nominalCents,
      currency: "BRL",
      image: null,
      sortOrder: 0,
    },
    receiving,
    pricing: {
      ...receiving,
      verification: "verified",
      provenance: "platform-tariff-table",
      observedAt: new Date(input.createdAt.getTime() - 1_000).toISOString(),
      expiresAt: new Date(input.expiresAt.getTime() + 60_000).toISOString(),
      policy,
    },
    settlement: buildGiftV2Settlement(quote),
    createdAt: input.createdAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
  } as GiftQuoteSnapshot;
}

/** An approved, fresh receiving context bound to the snapshot's recipient. */
export function approvedReceivingContext(
  snapshot: GiftQuoteSnapshot,
  observedAt: Date,
): GiftQuoteReceivingContext {
  return {
    isDemo: false,
    environment: "test",
    mode: "sandbox",
    freshnessMs: 300_000,
    providerBinding: { ...snapshot.receiving },
    evidence: {
      ...snapshot.receiving,
      verification: "verified",
      provenance: "provider",
      accountState: "approved",
      bankState: "verified",
      observedAt,
      bankObservedAt: observedAt,
      capabilities: { receiving: true, withdrawal: true },
      commercialEnabled: true,
    },
  };
}
