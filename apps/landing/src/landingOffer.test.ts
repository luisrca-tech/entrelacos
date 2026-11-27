import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { faqTopics } from "./faqContent";
import {
  BUSINESS_IDENTITY,
  exclusiveDeliveryLabel,
  formatCnpj,
  formatPlanPrice,
  isValidCnpj,
  SITE_PLANS,
  siteDeliveryLabel,
  siteOnlineLabel,
} from "./landingOffer";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const home = read("./pages/index.astro");
const footer = read("./components/PublicFooter.astro");
const consent = read("./components/LandingTracking.astro");
const faqText = faqTopics
  .flatMap((topic) => topic.questions.map((item) => item.answer))
  .join("\n");

describe("CNPJ validation", () => {
  it("accepts the published CNPJ and formats it", () => {
    expect(isValidCnpj(BUSINESS_IDENTITY.cnpj)).toBe(true);
    expect(formatCnpj(BUSINESS_IDENTITY.cnpj)).toBe("59.176.064/0001-90");
  });

  it("rejects wrong check digits, wrong length and repeated digits", () => {
    expect(isValidCnpj("59176064000191")).toBe(false);
    expect(isValidCnpj("5917606400019")).toBe(false);
    expect(isValidCnpj("11111111111111")).toBe(false);
  });
});

describe("site plans", () => {
  it("formats whole-real prices without cents", () => {
    expect(formatPlanPrice(30000).replace(/\s/g, " ")).toBe("R$ 300");
    expect(formatPlanPrice(30050).replace(/\s/g, " ")).toBe("R$ 300,50");
  });

  it("keeps the agreed prices, installments and delivery window", () => {
    expect(SITE_PLANS.model.priceCents).toBe(30000);
    expect(SITE_PLANS.model.maxInstallments).toBe(3);
    expect(SITE_PLANS.exclusive.fromCents).toBe(50000);
    expect(siteDeliveryLabel).toBe("até 15 dias");
    expect(SITE_PLANS.model.onlineMonthsAfterWedding).toBe(3);
    expect(siteOnlineLabel).toBe("até 3 meses depois do casamento");
    expect(exclusiveDeliveryLabel).toBe(
      "15 dias, ajustável conforme a personalização",
    );
  });

  it("presents both plans and the delivery window on the home page", () => {
    expect(home).toContain("SITE_PLANS");
    expect(home).toContain("siteDeliveryLabel");
    expect(home).toContain("exclusiveDeliveryLabel");
    expect(faqText).toContain("15 dias, ajustável conforme a personalização");
    expect(home).toMatch(/Site Modelo/);
    expect(home).toMatch(/Site Exclusivo/);
    expect(home).not.toMatch(/Como preparamos/);
    // Review happens inside the delivery window, not as a separate step.
    expect(home).toMatch(/\["Montagem e aprovação"/);
    expect(home).not.toMatch(/\["Revisão"/);
    expect(home).toMatch(
      /O prazo começa a contar quando recebemos todo o material/,
    );
  });

  it("states how long the site stays online instead of an open contract", () => {
    expect(home).toContain("siteOnlineLabel");
    expect(home).not.toMatch(/até o fim do contrato/);
    expect(faqText).not.toMatch(/até o fim do contrato/);
    expect(faqText).toMatch(/até 3 meses depois do casamento/);
    expect(faqText).toMatch(/CSV|PDF/);
  });

  it("states that the couple receives the whole gift on the home page", () => {
    expect(home).toMatch(/100%/);
    expect(home).not.toMatch(/sujeito à verificação de identidade/);
  });
});

describe("business identity and privacy", () => {
  it("shows the legal holder and CNPJ in the footer", () => {
    expect(footer).toContain("BUSINESS_IDENTITY");
    expect(footer).toContain('href="/privacidade"');
  });

  it("links the privacy policy from the cookie notice", () => {
    expect(consent).toContain('href="/privacidade"');
  });

  it("publishes a privacy page that covers every data holder", () => {
    const page = new URL("./pages/privacidade.astro", import.meta.url);
    expect(existsSync(page)).toBe(true);
    const text = readFileSync(page, "utf8");
    for (const subject of [
      "Casal",
      "Convidados",
      "Visitantes",
      "Pagar.me",
      "CNPJ",
    ])
      expect(text).toContain(subject);
    expect(text).toContain("siteOnlineLabel");
    expect(text).toMatch(/apagamos/);
  });

  it("answers how couple data is used in the FAQ", () => {
    expect(faqText).toMatch(/\/privacidade|política de privacidade/i);
  });
});

describe("FAQ release times", () => {
  it("states Pix on confirmation and card within two business days", () => {
    expect(faqText).toMatch(/Pix[^.]*assim que o pagamento é confirmado/);
    expect(faqText).toMatch(/até 2 dias úteis/);
  });

  it("states how the site itself is paid", () => {
    expect(faqText).toMatch(/Pix, boleto ou cartão em até 3x/);
  });
});
