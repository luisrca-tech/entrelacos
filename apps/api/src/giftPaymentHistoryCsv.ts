import { giftPurchaseHistoryPageResponseSchema } from "@entrelacos/contracts";
import { historyUnavailable } from "./giftPaymentHistory";

const columns = [
  "recordType",
  "exportScope",
  "siteId",
  "mode",
  "policy",
  "consistency",
  "readObservedAtMicros",
  "currentKnowledge",
  "sourceOrdering",
  "indexContinuation",
  "continuationCursor",
  "orderId",
  "quoteId",
  "giftId",
  "titleSnapshot",
  "method",
  "currency",
  "purchasedAtMicros",
  "destinationVersion",
  "policyVersion",
  "binding",
  "quotedNominalCents",
  "quotedCommissionCents",
  "quotedProcessingCents",
  "quotedTotalCents",
] as const;
const csvBytes = 256 * 1024;
function text(value: string): string {
  return value === "" ? "" : `'${value}`;
}

// One existing purchase-index page, never a complete financial-history export.
export function encodeGiftPurchaseHistoryCsv(
  value: unknown,
  siteId: string,
): string {
  try {
    const { history } = giftPurchaseHistoryPageResponseSchema.parse(value);
    if (
      history.scope.siteId !== siteId ||
      (history.nextCursor !== null &&
        !/^gh1\.[A-Za-z0-9_-]+$/.test(history.nextCursor))
    )
      return historyUnavailable();
    const envelope = (recordType: "META" | "PURCHASE") => [
      recordType,
      "PURCHASE_INDEX_ONLY",
      text(history.scope.siteId),
      history.scope.mode,
      history.scope.policy,
      history.consistency,
      text(history.readObservedAtMicros),
      history.currentKnowledge,
      history.sourceOrdering,
      history.nextCursor === null ? "END_OF_CURRENT_INDEX" : "MORE",
      history.nextCursor ?? "",
    ];
    const rows = [
      [...columns],
      [...envelope("META"), ...Array<string>(14).fill("")],
      ...history.items.map((purchase) => [
        ...envelope("PURCHASE"),
        text(purchase.orderId),
        text(purchase.quoteId),
        text(purchase.giftId),
        text(purchase.titleSnapshot),
        purchase.method,
        purchase.currency,
        text(purchase.purchasedAtMicros),
        String(purchase.destinationVersion),
        text(purchase.policyVersion),
        purchase.binding,
        String(purchase.quoted.nominalCents),
        String(purchase.quoted.commissionCents),
        String(purchase.quoted.processingCents),
        String(purchase.quoted.totalCents),
      ]),
    ];
    const csv =
      rows
        .map((row) =>
          row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(","),
        )
        .join("\r\n") + "\r\n";
    if (new TextEncoder().encode(csv).byteLength > csvBytes)
      return historyUnavailable();
    return csv;
  } catch {
    return historyUnavailable();
  }
}
