export type GiftPurchaseMethodFilter = "ALL" | "PIX" | "CREDIT_CARD";

function searchableTitle(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .trim();
}

export function filterLoadedGiftPurchases<
  T extends { titleSnapshot: string; method: "PIX" | "CREDIT_CARD" },
>(
  purchases: readonly T[],
  query: string,
  method: GiftPurchaseMethodFilter,
): T[] {
  const search = searchableTitle(query);
  return purchases.filter(
    (purchase) =>
      (method === "ALL" || purchase.method === method) &&
      searchableTitle(purchase.titleSnapshot).includes(search),
  );
}
