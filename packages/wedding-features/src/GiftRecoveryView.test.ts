import {
  type CheckoutStatus,
  checkoutStatusSchema,
} from "@entrelacos/contracts";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GiftRecoveryView } from "./GiftRecoveryView";
import {
  createGiftCheckoutState,
  giftCheckoutReducer,
} from "./giftCheckoutState";

const identifiers = [
  "site-1",
  "quote-1",
  "request-1",
  "order-1",
  "attempt-1",
  "https://checkout.example.test/pay/private",
];

function makeStatus(
  state: CheckoutStatus["state"],
  overrides: Partial<CheckoutStatus> = {},
): CheckoutStatus {
  const closed = state === "CLOSED_UNPAID";
  const awaiting = state === "AWAITING_PAYMENT";
  return checkoutStatusSchema.parse({
    siteId: "site-1",
    quoteId: "quote-1",
    requestId: "request-1",
    orderId: "order-1",
    attemptId: "attempt-1",
    method: "PIX",
    mode: "sandbox",
    state,
    observedAt:
      state === "CREATING" || state === "OUTCOME_UNKNOWN"
        ? null
        : "2026-10-12T12:00:00.000Z",
    closedReason: closed ? "EXPIRED" : null,
    mayStartNewAttempt: closed,
    checkout: awaiting
      ? {
          orderId: "order-1",
          attemptId: "attempt-1",
          quoteId: "quote-1",
          method: "PIX",
          hostedUrl: "https://checkout.example.test/pay/private",
          mode: "sandbox",
        }
      : null,
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
          onContinue: vi.fn(),
        });
        expect(html).toContain("Pagamento em verificação");
        expect(html).not.toMatch(
          /Recebimento confirmado|Reembolso confirmado|Continuar para pagamento|Nova tentativa/,
        );
        expect(html).toContain("Consultar pagamento");
      }
    },
  );
  it.each([
    ["CREATING", "Pagamento em verificação"],
    ["OUTCOME_UNKNOWN", "Pagamento em verificação"],
    ["AWAITING_PAYMENT", "Pagamento aguardando conclusão"],
    ["RECEIVED", "Recebimento confirmado"],
    ["CLOSED_UNPAID", "Pagamento encerrado sem recebimento"],
    ["REFUNDED", "Reembolso confirmado"],
  ] as const)(
    "projects %s without exposing checkout identifiers",
    (state, label) => {
      const html = renderRecovery({ status: makeStatus(state) });

      expect(html).toContain(label);
      expect(html).toContain("Ambiente de testes — sem pagamentos reais.");
      for (const identifier of identifiers)
        expect(html).not.toContain(identifier);
      expect(html).not.toMatch(
        /\b(?:R\$|BRL|valor|total|pago|pagamento confirmado)\b/i,
      );
      expect(html).not.toMatch(/token|hash|Asaas|banco|payer|provider key/i);

      if (state === "CLOSED_UNPAID") {
        expect(html).not.toContain("Continuar para pagamento");
        expect(html).not.toContain("Nova tentativa");
      }
    },
  );

  it("keeps null, loading, errors, wrong-site and invalid statuses in verification", () => {
    const wrongSite = makeStatus("RECEIVED", { siteId: "site-other" });
    const contradictory = {
      ...makeStatus("RECEIVED"),
      closedReason: "EXPIRED",
    } as unknown as CheckoutStatus;
    const extraField = {
      ...makeStatus("RECEIVED"),
      recoveryToken: "private-token-value",
    } as unknown as CheckoutStatus;
    const cases = [
      renderRecovery(),
      renderRecovery({ loading: true }),
      renderRecovery({ error: true }),
      renderRecovery({ status: wrongSite }),
      renderRecovery({ status: contradictory }),
      renderRecovery({ status: extraField }),
    ];

    for (const html of cases) {
      expect(html).toContain("Pagamento em verificação");
      expect(html).not.toContain("Recebimento confirmado");
      expect(html).not.toContain("Reembolso confirmado");
      expect(html).not.toContain("private-token-value");
      expect(html).not.toContain("site-other");
    }

    const sandboxLoading = renderRecovery({
      status: makeStatus("RECEIVED"),
      loading: true,
    });
    expect(sandboxLoading).toContain("Pagamento em verificação");
    expect(sandboxLoading).toContain(
      "Ambiente de testes — sem pagamentos reais.",
    );
    expect(sandboxLoading).not.toContain("Recebimento confirmado");
  });

  it("offers hosted continuation only when a valid checkout and handler exist", () => {
    const status = makeStatus("AWAITING_PAYMENT");
    const onContinue = vi.fn();
    const html = renderRecovery({ status, onContinue });
    const noHandler = renderRecovery({ status });

    expect(html).toContain("Continuar para pagamento");
    expect(html).not.toContain("https://checkout.example.test/pay/private");
    expect(html).not.toContain("href=");
    expect(noHandler).not.toContain("Continuar para pagamento");

    const invalidCheckout = {
      ...status,
      checkout: { ...status.checkout, hostedUrl: "http://unsafe.example.test" },
    } as unknown as CheckoutStatus;
    const invalidUrl = renderRecovery({ status: invalidCheckout, onContinue });
    expect(invalidUrl).toContain("Pagamento em verificação");
    expect(invalidUrl).not.toContain("Continuar para pagamento");

    const button = findButton(
      GiftRecoveryView({ ...baseProps, status, onContinue }),
      "Continuar para pagamento",
    );
    button?.onClick?.();
    expect(onContinue).toHaveBeenCalledWith(status.checkout);
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
