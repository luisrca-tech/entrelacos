import { z } from "zod";
import { giftPaymentMethodSchema } from "./internalGifts";

// Owner-only finance monitoring for the platform account split
// (PLATFORM_ACCOUNT_SPLIT_V2). Gifts settled under V1 are not listed.

export const ownerFinanceAlertKinds = [
  "SPLIT_DIVERGENCE_BLOCK",
  "SPLIT_CANCELLED",
  "ANTICIPATION_DENIED",
  "PAYMENT_RESTRICTION",
  "UNROUTABLE_PLATFORM_EVENT",
  "SPLIT_SETUP_FAILED",
] as const;

/**
 * - AWAITING_RELEASE: paid, no couple split credited yet.
 * - PARTIALLY_RECEIVED: some card installments credited to the couple.
 * - RECEIVED: every expected split credited to the couple.
 * - IN_REVIEW: open operator alert, split divergence or payment restriction.
 */
export const ownerFinanceGiftStatuses = [
  "AWAITING_RELEASE",
  "PARTIALLY_RECEIVED",
  "RECEIVED",
  "IN_REVIEW",
] as const;

const cents = z.number().int().safe();
const count = z.number().int().nonnegative();
const instant = z.iso.datetime({ offset: true });
const recordId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const environment = z.enum(["sandbox", "live"]);
const limit = z.coerce.number().int().min(1).max(100).default(50);
// `<epoch microseconds>_<record id>`: keyset position of the last row served.
const cursor = z
  .string()
  .regex(/^\d{1,20}_[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  .max(160);
const siteIds = z.array(recordId).min(1).max(100);

const orderedPeriod = (value: { from?: string; to?: string }) =>
  !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to);

const giftFilterShape = {
  siteId: siteIds.optional(),
  from: instant.optional(),
  to: instant.optional(),
  method: giftPaymentMethodSchema.optional(),
  status: z.enum(ownerFinanceGiftStatuses).optional(),
  environment: environment.optional(),
};

/** Filters shared by the gift table and its totals. */
export const ownerFinanceSummaryQuerySchema = z
  .object(giftFilterShape)
  .strict()
  .refine(orderedPeriod, "Period start must not be after its end");

export const ownerFinanceGiftListQuerySchema = z
  .object({ ...giftFilterShape, cursor: cursor.optional(), limit })
  .strict()
  .refine(orderedPeriod, "Period start must not be after its end");

export const ownerFinanceSummarySchema = z
  .object({
    giftCount: count,
    grossChargedCents: cents,
    coupleCreditedCents: cents,
    estimatedCommissionCents: cents,
    netCommissionCents: cents,
    // Over fully received gifts only: estimated minus real net commission.
    commissionDifferenceCents: cents,
  })
  .strict();

export const ownerFinanceGiftSchema = z
  .object({
    orderId: recordId,
    siteId: recordId,
    siteName: z.string(),
    environment,
    paidAt: instant,
    giftTitle: z.string(),
    method: giftPaymentMethodSchema,
    installmentCount: z.number().int().min(1).max(12),
    grossCents: cents,
    coupleCreditedCents: cents,
    coupleExpectedCents: cents,
    creditedInstallments: count,
    estimatedCommissionCents: cents,
    // Null until the provider reports a settled split.
    netCommissionCents: cents.nullable(),
    status: z.enum(ownerFinanceGiftStatuses),
  })
  .strict();

export const ownerFinanceGiftListResponseSchema = z
  .object({
    gifts: z.array(ownerFinanceGiftSchema),
    nextCursor: cursor.nullable(),
  })
  .strict();

export const ownerFinanceSiteListResponseSchema = z
  .object({
    sites: z.array(z.object({ id: recordId, name: z.string() }).strict()),
  })
  .strict();

export const ownerFinanceAlertSchema = z
  .object({
    id: z.string(),
    kind: z.enum(ownerFinanceAlertKinds),
    severity: z.enum(["warning", "critical"]),
    environment,
    siteId: z.string().nullable(),
    siteName: z.string().nullable(),
    paymentReference: z.string().nullable(),
    amountCents: cents.nullable(),
    createdAt: instant,
    // Resolution deadline: two business days for split divergences.
    dueAt: instant.nullable(),
    asaasPaymentUrl: z.string().nullable(),
    resolvedAt: instant.nullable(),
    resolvedNote: z.string().nullable(),
  })
  .strict();

export const ownerFinanceAlertListQuerySchema = z
  .object({
    status: z.enum(["open", "resolved", "all"]).default("open"),
    siteId: siteIds.optional(),
    cursor: cursor.optional(),
    limit,
  })
  .strict();

export const ownerFinanceAlertListResponseSchema = z
  .object({
    alerts: z.array(ownerFinanceAlertSchema),
    nextCursor: cursor.nullable(),
    // Open alerts across every site, for the owner menu badge.
    openCount: count,
    criticalOpenCount: count,
  })
  .strict();

export const ownerFinanceAlertResolveInputSchema = z
  .object({ note: z.string().trim().min(1).max(500) })
  .strict();

export type OwnerFinanceGiftStatus = (typeof ownerFinanceGiftStatuses)[number];
export type OwnerFinanceSummaryQuery = z.infer<
  typeof ownerFinanceSummaryQuerySchema
>;
export type OwnerFinanceGiftListQuery = z.infer<
  typeof ownerFinanceGiftListQuerySchema
>;
export type OwnerFinanceAlertListQuery = z.infer<
  typeof ownerFinanceAlertListQuerySchema
>;
export type OwnerFinanceSummary = z.infer<typeof ownerFinanceSummarySchema>;
export type OwnerFinanceGift = z.infer<typeof ownerFinanceGiftSchema>;
export type OwnerFinanceGiftListResponse = z.infer<
  typeof ownerFinanceGiftListResponseSchema
>;
export type OwnerFinanceSiteListResponse = z.infer<
  typeof ownerFinanceSiteListResponseSchema
>;
export type OwnerFinanceAlert = z.infer<typeof ownerFinanceAlertSchema>;
export type OwnerFinanceAlertListResponse = z.infer<
  typeof ownerFinanceAlertListResponseSchema
>;
