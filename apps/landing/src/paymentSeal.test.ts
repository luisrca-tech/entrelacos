import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

describe("landing payment seal", () => {
  it("is a text seal naming Pagar.me, without an image", () => {
    const seal = read("./components/PaymentSeal.astro");
    expect(seal).toContain(
      "Pagamentos processados por Pagar.me, uma empresa Stone.",
    );
    expect(seal).not.toMatch(/<img|asaas/i);
  });

  it("appears next to the gift copy and the payments FAQ", () => {
    expect(read("./pages/index.astro")).toContain("<PaymentSeal />");
    expect(read("./pages/duvidas.astro")).toContain("<PaymentSeal />");
  });

  it("leaves no mention of the previous provider in landing sources", () => {
    for (const file of [
      "./pages/index.astro",
      "./pages/duvidas.astro",
      "./faqContent.ts",
      "./components/PricingExample.astro",
      "../README.md",
    ])
      expect(read(file)).not.toMatch(/asaas/i);
  });
});

describe("landing gift payment copy", () => {
  const page = read("./pages/index.astro");

  it("promises only what the product offers: Pix and card up to the configured installments", () => {
    expect(page).toContain("GIFT_PLATFORM_TARIFFS.maxInstallments");
    expect(page).not.toMatch(/em até \d+x/);
    expect(page).toContain("conforme o valor do presente");
  });

  it("describes installments without calling them à vista", () => {
    expect(page).not.toContain("parcelas à vista");
    expect(page).toContain("o valor de cada parcela antes de confirmar");
  });
});
