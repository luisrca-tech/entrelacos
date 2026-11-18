import {
  type GiftCheckoutStatus,
  giftCheckoutStatusSchema,
} from "@entrelacos/contracts";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GiftRecoveryView } from "./GiftRecoveryView";
import {
  createGiftCheckoutState,
  giftCheckoutReducer,
} from "./giftCheckoutState";

const identifiers = ["site-1", "quote-1", "request-1", "checkout-1"];
const pix = {
  qrCode: "00020126580014br.gov.bcb.pix0136checkout",
  qrCodeUrl: "https://pix.example.test/qr.png",
  expiresAt: "2099-10-12T12:30:00.000Z",
};

function makeStatus(
  state: GiftCheckoutStatus["state"],
  overrides: Partial<GiftCheckoutStatus> = {},
): GiftCheckoutStatus {
  const closed = state === "CLOSED_UNPAID";
  const awaiting = state === "AWAITING_PAYMENT";
  return giftCheckoutStatusSchema.parse({
    siteId: "site-1",
    quoteId: "quote-1",
    requestId: "request-1",
    checkoutId: "checkout-1",
    method: "PIX",
    mode: "sandbox",
    state,
    observedAt:
      state === "CREATING" || state === "OUTCOME_UNKNOWN"
        ? null
        : "2026-10-12T12:00:00.000Z",
    closedReason: closed ? "EXPIRED" : null,
    mayStartNewAttempt: closed,
    pix: awaiting ? pix : null,
    ...overrides,
  });
}

const baseProps = {
  siteId: "site-1",
  status: null,
  loading: false,
  error: false,
};

function renderRecovery(
  overrides: Partial<Parameters<typeof GiftRecoveryView>[0]> = {},
) {
  return renderToStaticMarkup(
    createElement(GiftRecoveryView, { ...baseProps, ...overrides }),
  );
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (!isValidElement<{ children?: ReactNode }>(node)) return "";
  return textOf(node.props.children);
}

function findButton(
  node: ReactNode,
  label: string,
): { disabled?: boolean; onClick?: () => void } | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const button = findButton(child, label);
      if (button) return button;
    }
    return null;
  }
  if (
    !isValidElement<{
      children?: ReactNode;
      disabled?: boolean;
      onClick?: () => void;
    }>(node)
  ) {
    return null;
  }
  if (node.type === "button" && textOf(node.props.children) === label) {
    return node.props;
  }
  return findButton(node.props.children, label);
}

describe("gift recovery view", () => {
  it.each(["RECEIVED", "REFUNDED"] as const)(
    "shows current verification after historical %s, including a remount",
    (paymentState) => {
      const terminal = makeStatus(paymentState);
      const pending = {
        quoteId: terminal.quoteId,
        requestId: terminal.requestId,
        recoveryToken: "A".repeat(43),
        method: terminal.method,
        mode: terminal.mode,
      };
      const restored = giftCheckoutReducer(createGiftCheckoutState(), {
        type: "RESTORE_UNKNOWN",
        siteId: "site-1",
        pending,
      });
      const confirmed = giftCheckoutReducer(restored, {
        type: "STATUS_RESOLVED",
        status: terminal,
      });
      const uncertain = giftCheckoutReducer(confirmed, {
        type: "STATUS_RESOLVED",
        status: makeStatus("OUTCOME_UNKNOWN", {
          observedAt: "2026-10-12T12:01:00.000Z",
        }),
      });
      if (!uncertain.pending) throw new Error("Expected retained operation");
      const remounted = giftCheckoutReducer(createGiftCheckoutState(), {
        type: "RESTORE_UNKNOWN",
        siteId: "site-1",
        pending: uncertain.pending,
      });
      for (const state of [uncertain, remounted]) {
        const html = renderRecovery({
          status: state.checkoutStatus,
          canRetry: true,
          onRetry: vi.fn(),
        });
        expect(html).toContain("Pagamento em verificação");
        expect(html).not.toMatch(
          /Recebimento confirmado|Reembolso confirmado|QR Code do Pix|Nova tentativa/,
        );
        expect(html).toContain("Consultar pagamento");
      }
    },
  );
  it.each([
    ["CREATING", "Pagamento em verificação"],
    ["OUTCOME_UNKNOWN", "Pagamento em verificação"],
    ["AWAITING_PAYMENT", "Aguardando o Pix"],
    [
      "AWAITING_PAYMENT",
      "Pagamento aguardando conclusão",
      { method: "CREDIT_CARD", pix: null },
    ],
    ["RECEIVED", "Recebimento confirmado"],
    ["CLOSED_UNPAID", "Pagamento encerrado sem recebimento"],
    ["REFUNDED", "Reembolso confirmado"],
  ] as [GiftCheckoutStatus["state"], string, Partial<GiftCheckoutStatus>?][])(
    "projects %s (%s) without exposing checkout identifiers",
    (state, label, overrides) => {
      const html = renderRecovery({ status: makeStatus(state, overrides) });

      expect(html).toContain(label);
      expect(html).toContain("Ambiente de testes — sem pagamentos reais.");
      for (const identifier of identifiers)
        expect(html).not.toContain(identifier);
      expect(html).not.toMatch(
        /\b(?:R\$|BRL|total|pago|pagamento confirmado)\b/i,
      );
      expect(html).not.toMatch(/token|hash|payer|provider key/i);

      if (state === "CLOSED_UNPAID") {
        expect(html).not.toContain("QR Code do Pix");
        expect(html).not.toContain("Nova tentativa");
      }
    },
  );

  it("keeps null, loading, errors, wrong-site and invalid statuses in verification", () => {
    const wrongSite = makeStatus("RECEIVED", { siteId: "site-other" });
    const contradictory = {
      ...makeStatus("RECEIVED"),
      closedReason: "EXPIRED",
    } as unknown as GiftCheckoutStatus;
    const extraField = {
      ...makeStatus("RECEIVED"),
      recoveryToken: "private-token-value",
    } as unknown as GiftCheckoutStatus;
    const cases = [
      [renderRecovery(), "Pagamento em verificação"],
      [renderRecovery({ loading: true }), "Consultando pagamento…"],
      [
        renderRecovery({ error: true }),
        "Não foi possível consultar o pagamento agora.",
      ],
      [renderRecovery({ status: wrongSite }), "Pagamento em verificação"],
      [renderRecovery({ status: contradictory }), "Pagamento em verificação"],
      [renderRecovery({ status: extraField }), "Pagamento em verificação"],
    ];

    for (const [html, label] of cases) {
      expect(html).toContain(label);
      expect(html).not.toContain("Recebimento confirmado");
      expect(html).not.toContain("Reembolso confirmado");
      expect(html).not.toContain("private-token-value");
      expect(html).not.toContain("site-other");
    }

    const sandboxLoading = renderRecovery({
      status: makeStatus("RECEIVED"),
      loading: true,
    });
    expect(sandboxLoading).toContain("Consultando pagamento…");
    expect(sandboxLoading).toContain(
      "Ambiente de testes — sem pagamentos reais.",
    );
    expect(sandboxLoading).not.toContain("Recebimento confirmado");
  });

  it("shows a Pix only from a valid status and never links away", () => {
    const status = makeStatus("AWAITING_PAYMENT");
    const onRetry = vi.fn();
    const html = renderRecovery({ status, canRetry: true, onRetry });

    expect(html).toContain('alt="QR Code do Pix"');
    expect(html).toContain(pix.qrCode);
    expect(html).not.toMatch(/<a\b/);

    const invalidPix = {
      ...status,
      pix: { ...pix, qrCodeUrl: "http://unsafe.example.test/qr.png" },
    } as unknown as GiftCheckoutStatus;
    const invalidUrl = renderRecovery({ status: invalidPix });
    expect(invalidUrl).toContain("Pagamento em verificação");
    expect(invalidUrl).not.toContain("unsafe.example.test");
    expect(invalidUrl).not.toContain("QR Code do Pix");

    const button = findButton(
      GiftRecoveryView({ ...baseProps, status, canRetry: true, onRetry }),
      "Já paguei",
    );
    button?.onClick?.();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("places the disclosure after the recovery action", () => {
    const html = renderRecovery({
      error: true,
      canRetry: true,
      onRetry: vi.fn(),
    });
    const disclosure = html.indexOf(
      "Pagamentos processados por Pagar.me, uma empresa Stone.",
    );
    expect(html).toContain("Consultar pagamento");
    expect(disclosure).toBeGreaterThan(html.indexOf("Consultar pagamento"));
  });

  it("shows retry only when permitted and disables it while loading", () => {
    const onRetry = vi.fn();
    const allowed = renderRecovery({ canRetry: true, onRetry });
    const unavailable = renderRecovery({ onRetry });
    const loading = renderRecovery({ canRetry: true, onRetry, loading: true });

    expect(allowed).toContain("Consultar pagamento");
    expect(unavailable).not.toContain("Consultar pagamento");
    expect(loading).toMatch(
      /<button[^>]*disabled=""[^>]*>Consultar pagamento<\/button>/,
    );
  });
});

beforeEach(() => vi.stubGlobal("__APP_ENV__", "development"));
afterEach(() => vi.unstubAllGlobals());
