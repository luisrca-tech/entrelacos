import type {
  FinancialOverview,
  GiftPurchaseHistoryPurchase,
} from "@entrelacos/contracts";

export type FinancialFlowSegmentId =
  | "awaiting"
  | "fees"
  | "withdrawn"
  | "pending"
  | "refunded"
  | "available";

export type FinancialFlowSegment = {
  id: FinancialFlowSegmentId;
  label: string;
  cents: number;
};

// Splits the money the overview tracks into the parts shown in the flow bar.
// An unknown provider balance is left out instead of being shown as zero.
export function financialFlow(overview: FinancialOverview) {
  const availableCents =
    overview.availability === "CURRENT" ? overview.availableCents : null;
  const candidates: (FinancialFlowSegment & { always: boolean })[] = [
    {
      id: "awaiting",
      label: "Aguardando liberação",
      cents: overview.awaitingReleaseCents,
      always: true,
    },
    {
      id: "fees",
      label: "Taxas",
      cents: overview.commissionCents + overview.processingCents,
      always: true,
    },
    {
      id: "withdrawn",
      label: "Já sacado",
      cents: overview.withdrawnCents,
      always: true,
    },
    {
      id: "pending",
      label: "Saques em andamento",
      cents: overview.pendingCommitmentsCents,
      always: false,
    },
    {
      id: "refunded",
      label: "Reembolsado",
      cents: overview.refundedCents,
      always: false,
    },
  ];
  const segments: FinancialFlowSegment[] = candidates
    .filter(({ cents, always }) => always || cents > 0)
    .map(({ always: _always, ...segment }) => segment);
  if (availableCents !== null)
    segments.push({
      id: "available",
      label: "Disponível para saque",
      cents: availableCents,
    });
  return {
    segments,
    availableCents,
    totalCents: segments.reduce((sum, { cents }) => sum + cents, 0),
    // What guests paid for gifts the provider has already released.
    releasedGrossCents:
      overview.netReceivedCents -
      (overview.platformAdjustmentFundedCents ?? 0) +
      overview.commissionCents +
      overview.processingCents,
    // Released and still awaiting, both after fees.
    netForCoupleCents:
      overview.netReceivedCents +
      overview.awaitingReleaseCents +
      (overview.platformAdjustmentOwedCents ?? 0),
  };
}

export function purchaseNetCents(
  quoted: GiftPurchaseHistoryPurchase["quoted"],
): number {
  return quoted.totalCents - quoted.commissionCents - quoted.processingCents;
}

const currency = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});
export function formatCents(cents: number): string {
  return currency.format(cents / 100);
}
