import { describe, expect, it } from "vitest";
import { filterLoadedGiftPurchases } from "./giftPurchaseFilters";

const purchases = [
  { titleSnapshot: "Café da manhã", method: "PIX" },
  { titleSnapshot: "Viagem", method: "CREDIT_CARD" },
] as const;
describe("loaded gift purchase filters", () => {
  it("searches only loaded titles, ignoring accents and letter case", () => {
    expect(filterLoadedGiftPurchases(purchases, " CAFE ", "ALL")).toEqual([
      purchases[0],
    ]);
    expect(filterLoadedGiftPurchases(purchases, "not loaded", "ALL")).toEqual(
      [],
    );
  });
  it("combines method and text without mutating retained purchases", () => {
    expect(filterLoadedGiftPurchases(purchases, "", "CREDIT_CARD")).toEqual([
      purchases[1],
    ]);
    expect(filterLoadedGiftPurchases(purchases, "Viagem", "PIX")).toEqual([]);
    expect(purchases).toHaveLength(2);
  });
});
