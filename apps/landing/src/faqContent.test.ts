import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GIFT_PLATFORM_TARIFFS } from "../../../packages/contracts/src/giftTariffs";
import { faqTopics } from "./faqContent";

const brl = (cents: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" })
    .format(cents / 100)
    .replace(/\s/g, " ");
const questions = faqTopics.flatMap((topic) => topic.questions);
const text = faqTopics
  .flatMap((topic) => [
    topic.title,
    ...topic.questions.flatMap((item) => [
      item.question,
      item.answer,
      item.reference?.label ?? "",
    ]),
  ])
  .join("\n")
  .replace(/\s/g, " ");

describe("public FAQ payment content", () => {
  it("names Pagar.me as the payment provider", () => {
    expect(text).toContain("Pagar.me");
    for (const { reference } of questions)
      if (reference)
        expect(new URL(reference.href).hostname).toMatch(/(^|\.)pagar\.me$/);
  });

  it("states the card installment limit from the tariff table", () => {
    expect(GIFT_PLATFORM_TARIFFS.maxInstallments).toBe(6);
    expect(text).toContain(`até ${GIFT_PLATFORM_TARIFFS.maxInstallments}x`);
    expect(text).not.toMatch(/12 parcelas|12x/);
  });

  it("explains that the couple receives the whole gift", () => {
    expect(text).toContain("100%");
    expect(text).toMatch(/convidado paga/i);
  });

  it("explains card and Pix release times", () => {
    expect(text).toMatch(/cerca de 2 dias/);
    // The Pix settlement time is not in the proposal: no promise of "immediately".
    expect(text).toMatch(/Pix[^.]*quando a Pagar.me libera/);
    expect(text).not.toMatch(/imediat/);
  });

  it("explains the holder declaration and the Entrelaços check before receiving", () => {
    expect(text).toMatch(/declara que o CPF e a conta bancária são dele/);
    expect(text).toMatch(/18 anos ou mais/);
    expect(text).not.toMatch(
      /selfie|prova de vida|20 minutos|Verificar identidade/i,
    );
  });

  it("states the withdrawal fee from the tariff table", () => {
    expect(brl(GIFT_PLATFORM_TARIFFS.withdrawalFeeCents)).toBe("R$ 3,67");
    expect(text).toContain(brl(GIFT_PLATFORM_TARIFFS.withdrawalFeeCents));
  });

  it("does not promise free withdrawals to any bank", () => {
    expect(text).not.toMatch(/Banco Stone|gratuit|sem custo|grátis/i);
  });

  it("explains how card and identity data are protected", () => {
    expect(text).toMatch(/número do cartão[^.]*direto[^.]*Pagar\.me/);
    expect(text).toMatch(/nunca o número nem o CVV/);
  });

  it("never names the previous provider", () => {
    expect(text).not.toMatch(/asaas/i);
  });

  it("does not repeat a question", () => {
    const unique = new Set(questions.map((item) => item.question));
    expect(unique.size).toBe(questions.length);
  });

  it("describes the FAQ page with the current provider", () => {
    const page = readFileSync(
      new URL("./pages/duvidas.astro", import.meta.url),
      "utf8",
    );
    const description = page.match(/const description = "([^"]+)"/)?.[1];
    expect(description).toContain("Pagar.me");
  });
});
