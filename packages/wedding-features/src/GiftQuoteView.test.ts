import type { GiftQuote } from "@entrelacos/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
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
    expect(html).toContain("Cartão à vista");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Não foi possível atualizar a cotação.");
    expect(html).toContain("Jantar especial");
    expect(html).toContain("Valor do presente");
    expect(html).toContain("Taxa de comissão");
    expect(html).toContain("Taxa de processamento");
    expect(html).toContain("Total a pagar");
    expect(html).toContain("100,00");
    expect(html).toContain("2,00");
    expect(html).toContain("3,21");
    expect(html).toContain("105,21");
    expect(html).toContain("Ambiente de testes — sem pagamentos reais.");
    expect(html).toContain("Presente simbólico");
    expect(html).toContain("não há produto físico ou entrega");
    expect(html).toContain("página segura de pagamento");
    expect(html).not.toContain("Pagamento confirmado");
    expect(html).not.toContain('name="card"');
    expect(html).not.toMatch(/token|hash|Asaas|banco|payer|provider key/i);
  });

  it("keeps confirmation disabled without a matching, current quote", () => {
    const noQuote = renderQuote({ quote: null });
    const wrongMethod = renderQuote({ method: "CREDIT_CARD" });
    const loading = renderQuote({ loading: true });
    const expired = renderQuote({
      now: new Date("2026-10-12T15:30:00.000Z"),
    });

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
