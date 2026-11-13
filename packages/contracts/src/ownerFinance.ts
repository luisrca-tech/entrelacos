import { z } from "zod";

// Owner-only finance monitoring for the platform account split (V2).

export const ownerFinanceAlertKinds = [
  "SPLIT_DIVERGENCE_BLOCK",
  "SPLIT_CANCELLED",
  "ANTICIPATION_DENIED",
  "PAYMENT_RESTRICTION",
  "UNROUTABLE_PLATFORM_EVENT",
  "SPLIT_SETUP_FAILED",
] as const;

const cents = z.number().int().safe();

export const ownerFinanceSummaryQuerySchema = z
  .object({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export const ownerFinanceSummarySchema = z
  .object({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    grossChargedCents: cents,
    recipientSplitCents: cents,
    platformNetCents: cents,
    anticipationCents: cents,
    estimatedCommissionCents: cents,
    // Estimated commission minus the platform net actually observed.
    commissionDifferenceCents: cents,
    paymentCountsByStatus: z.record(z.string(), z.number().int().nonnegative()),
    openAlertCount: z.number().int().nonnegative(),
    criticalAlertCount: z.number().int().nonnegative(),
  })
  .strict();

export const ownerFinanceAlertSchema = z
  .object({
    id: z.string(),
    kind: z.enum(ownerFinanceAlertKinds),
    severity: z.enum(["warning", "critical"]),
    environment: z.enum(["sandbox", "live"]),
    siteId: z.string().nullable(),
    siteName: z.string().nullable(),
    paymentReference: z.string().nullable(),
    amountCents: cents.nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    // Resolution deadline: two business days for split divergences.
    dueAt: z.iso.datetime({ offset: true }).nullable(),
    asaasPaymentUrl: z.string().nullable(),
    resolvedAt: z.iso.datetime({ offset: true }).nullable(),
    resolvedNote: z.string().nullable(),
  })
  .strict();

export const ownerFinanceAlertListQuerySchema = z
  .object({ status: z.enum(["open", "resolved", "all"]).default("open") })
  .strict();

export const ownerFinanceAlertListResponseSchema = z
  .object({ alerts: z.array(ownerFinanceAlertSchema) })
  .strict();

export const ownerFinanceAlertResolveInputSchema = z
  .object({ note: z.string().trim().min(1).max(500) })
  .strict();

export type OwnerFinanceSummary = z.infer<typeof ownerFinanceSummarySchema>;
export type OwnerFinanceAlert = z.infer<typeof ownerFinanceAlertSchema>;
