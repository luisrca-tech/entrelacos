import type { GiftQuote } from "@entrelacos/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GiftQuoteView } from "./GiftQuoteView";

const quote: GiftQuote = {
  id: "quote-1",
  giftId: "gift-1",
  siteId: "site-1",
  title: "Jantar especial",
  method: "PIX",
  currency: "BRL",
  nominalCents: 10_000,
  commissionBasisPoints: 200,
  commissionCents: 200,
  processingCents: 321,
  totalCents: 10_521,
  policyVersion: "policy-1",
  expiresAt: "2026-10-12T15:30:00.000Z",
  mode: "sandbox",
};

const observedNow = new Date("2026-10-12T12:00:00.000Z");

type QuoteViewProps = {
  quote: GiftQuote | null;
  method: "PIX" | "CREDIT_CARD" | null;
  installmentCount?: number;
  loading: boolean;
  pending: boolean;
  error?: string;
  onSelectMethod: (method: "PIX" | "CREDIT_CARD") => void;
  onConfirm: () => void;
  onCancel: () => void;
  now: Date;
};

const baseProps: QuoteViewProps = {
  quote,
  method: "PIX" as const,
  loading: false,
  pending: false,
  onSelectMethod: vi.fn(),
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
  now: observedNow,
};

function renderQuote(overrides: Partial<QuoteViewProps> = {}) {
  return renderToStaticMarkup(
    createElement(GiftQuoteView, { ...baseProps, ...overrides }),
  );
}

describe("gift quote view", () => {
  it("renders accessible method choices, errors and quote-provided amounts", () => {
    const html = renderQuote({
      error: "Não foi possível atualizar a cotação.",
    });

    expect(html).toContain("Forma de pagamento");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("Pix");
    expect(html).toContain("Cartão de crédito");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Não foi possível atualizar a cotação.");
    expect(html).toContain("Jantar especial");
    expect(html).not.toMatch(/comissão/i);
    expect(html).toContain("Taxas incluídas no valor");
    expect(html).not.toContain("Taxa de processamento");
    expect(html).toContain("Total a pagar");
    expect(html).not.toContain("Valores válidos até");
    expect(html).not.toContain("<time");
    expect(html).not.toContain("Cotação válida até");
    expect(html).not.toMatch(/R\$\s*100,00/);
    expect(html).toContain("105,21");
    expect(html).toContain("Ambiente de testes — sem pagamentos reais.");
    expect(html).toContain("Presente simbólico");
    expect(html).toContain("não há produto físico ou entrega");
    expect(html).toContain("página segura de pagamento");
    expect(html).not.toContain("Pagamento confirmado");
    expect(html).not.toContain('name="card"');
    expect(html).not.toMatch(/token|hash|payer|provider key/i);
    expect(html).toContain('alt="Serviços financeiros Asaas"');
    expect(html).toContain('href="https://asaas.com"');
    expect(html).not.toContain(quote.id);
    expect(html).not.toContain(quote.siteId);
  });

  it("charges the configured gift price without exposing recipient deductions", () => {
    const html = renderQuote({
      quote: {
        ...quote,
        nominalCents: 1000,
        commissionCents: 20,
        processingCents: 90,
        totalCents: 1000,
        feeAllocation: "RECIPIENT_DEDUCTED",
      },
    });
    expect(html).toContain("Total a pagar");
    expect(html).toMatch(/R\$\s*10,00/);
    expect(html).not.toMatch(
      /taxas incluídas|comissão|taxa de processamento|10,20|11,10/i,
    );
  });

  it.each([
    ["development", "sandbox", true],
    ["production", "sandbox", false],
    ["development", "live", false],
    ["production", "live", false],
  ] as const)(
    "gates payment notices by application and provider mode (%s, %s)",
    (environment, mode, visible) => {
      vi.stubGlobal("__APP_ENV__", environment);
      expect(
        renderQuote({ quote: { ...quote, mode } }).includes(
          "Ambiente de testes",
        ),
      ).toBe(visible);
    },
  );
  it("keeps confirmation disabled without a matching, current quote", () => {
    const noQuote = renderQuote({ quote: null });
    const wrongMethod = renderQuote({ method: "CREDIT_CARD" });
    const loading = renderQuote({ loading: true });
    const expired = renderQuote({
      now: new Date("2026-10-12T15:30:00.000Z"),
    });
    expect(expired).toContain(
      "Selecione novamente a forma de pagamento para atualizar os valores e continuar.",
    );

    for (const html of [noQuote, wrongMethod, loading, expired]) {
      expect(html).toMatch(
        /<button[^>]*disabled=""[^>]*>Continuar para pagamento<\/button>/,
      );
    }
  });

  it("enables confirmation immediately before expiry and disables it at the boundary", () => {
    const justBefore = renderQuote({
      now: new Date("2026-10-12T15:29:59.999Z"),
    });
    const atExpiry = renderQuote({
      now: new Date("2026-10-12T15:30:00.000Z"),
    });

    expect(justBefore).toMatch(
      /<button[^>]*>Continuar para pagamento<\/button>/,
    );
    expect(justBefore).not.toMatch(
      /<button[^>]*disabled=""[^>]*>Continuar para pagamento/,
    );
    expect(atExpiry).toMatch(
      /<button[^>]*disabled=""[^>]*>Continuar para pagamento<\/button>/,
    );
  });

  it("disables method and action buttons while a request is pending", () => {
    const html = renderQuote({ pending: true });

    expect(html).toMatch(
      /<button(?=[^>]*aria-pressed="true")(?=[^>]*disabled="")[^>]*>/,
    );
    expect(html).toContain('disabled="">Aguarde…</button>');
    expect(html).toContain("Aguarde");
  });
});

beforeEach(() => vi.stubGlobal("__APP_ENV__", "development"));
afterEach(() => vi.unstubAllGlobals());

it("shows gift, fees and total without exposing recipient deductions in Sandbox", () => {
  const html = renderQuote({
    quote: { ...quote, feeAllocation: "BUYER_GROSS_UP" },
  });
  expect(html).not.toContain("Líquido pretendido do casal");
  expect(html).not.toContain("sem garantia de líquido");
  expect(html).not.toContain("recipientSplit");
  expect(html).toContain("Presente");
  expect(html).toContain("Taxas e serviço");
  expect(html).toContain(
    'title="Inclui a taxa do meio de pagamento e o serviço Entrelaços"',
  );
  expect(html).not.toMatch(/antecipa/i);
  expect(html).toContain("105,21");
});

it("shows the exact installment schedule, surcharge and total of the selected quote", () => {
  const installments = [3533, 3533, 3535];
  const html = renderQuote({
    method: "CREDIT_CARD",
    installmentCount: 3,
    quote: {
      ...quote,
      method: "CREDIT_CARD",
      feeAllocation: "BUYER_GROSS_UP",
      installmentCount: 3,
      installmentCents: installments,
      installmentSurchargeCents: 80,
      totalCents: 10601,
      installmentOptions: [
        {
          installmentCount: 1,
          installmentCents: [10521],
          installmentSurchargeCents: 0,
          totalCents: 10521,
        },
        {
          installmentCount: 3,
          installmentCents: installments,
          installmentSurchargeCents: 80,
          totalCents: 10601,
        },
      ],
    },
  });
  expect(html).toContain("Parcelas");
  expect(html).toMatch(/À vista · R\$\s*105,21/);
  expect(html).toMatch(/3x de R\$\s*35,33 \(última R\$\s*35,35\)/);
  expect(html).not.toContain("A última parcela tem ajuste de centavos");
  expect(html).not.toContain("Acréscimo do parcelamento");
  expect(html).toContain("Taxas e serviço");
  expect(html).toMatch(/R\$\s*106,01/);
  expect(html).toContain("Dados do pagador");
  expect(html).toContain("continuar a mesma cobrança");
  expect(html).toContain("60 minutos");
  expect(html).toContain("aguarde a confirmação do encerramento");
  expect(html).not.toContain("Taxa de processamento");
  const disclosure = html.indexOf(
    'aria-label="Prestador dos serviços financeiros"',
  );
  expect(disclosure).toBeGreaterThan(html.indexOf("</form>"));
  expect(disclosure).toBeLessThan(html.indexOf("<footer"));
});

it("does not offer installments when the server returns only an upfront quote", () => {
  const html = renderQuote({
    method: "CREDIT_CARD",
    quote: { ...quote, method: "CREDIT_CARD" },
  });
  expect(html).not.toContain("Parcelas");
  expect(html).not.toContain("Dados do pagador");
  expect(html).not.toContain("60 minutos");
});

it("shows equal installments without a rounding marker", () => {
  const option = {
    installmentCount: 3,
    installmentCents: [3534, 3534, 3534],
    totalCents: 10602,
    installmentSurchargeCents: 81,
  };
  const html = renderQuote({
    method: "CREDIT_CARD",
    installmentCount: 3,
    quote: {
      ...quote,
      ...option,
      method: "CREDIT_CARD",
      installmentOptions: [
        {
          installmentCount: 1,
          installmentCents: [10521],
          totalCents: 10521,
          installmentSurchargeCents: 0,
        },
        option,
      ],
    },
  });
  expect(html).toMatch(
    /<option[^>]*value="3"[^>]*>3x de R\$\s*35,34<\/option>/,
  );
  expect(html).not.toContain("A última parcela tem ajuste de centavos");
  expect(html).toMatch(/R\$\s*106,02/);
});
