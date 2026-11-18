import {
  type GiftCheckoutStatus,
  giftCheckoutStatusSchema,
} from "@entrelacos/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GiftRecoveryView } from "./GiftRecoveryView";

const pix = {
  qrCode: "00020101021226820014br.gov.bcb.pix2560pix.example/qr/v2/abc",
  qrCodeUrl: "https://api.pagar.me/core/v5/transactions/tran_1/qrcode?x=1",
  expiresAt: "2026-10-12T15:30:00.000Z",
};

function status(
  state: GiftCheckoutStatus["state"],
  overrides: Partial<GiftCheckoutStatus> = {},
): GiftCheckoutStatus {
  return giftCheckoutStatusSchema.parse({
    siteId: "site-1",
    quoteId: "quote-1",
    requestId: "request-1",
    checkoutId: "checkout-1",
    method: "PIX",
    mode: "sandbox",
    state,
    observedAt: "2026-10-12T12:00:00.000Z",
    closedReason: state === "CLOSED_UNPAID" ? "EXPIRED" : null,
    mayStartNewAttempt: state === "CLOSED_UNPAID",
    pix: state === "AWAITING_PAYMENT" ? pix : null,
    ...overrides,
  });
}

function render(props: Partial<Parameters<typeof GiftRecoveryView>[0]>) {
  return renderToStaticMarkup(
    createElement(GiftRecoveryView, {
      siteId: "site-1",
      status: null,
      headingId: "gift-payment-heading",
      ...props,
    }),
  );
}

describe("Pix payment in the payment dialog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T15:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the QR code, the copy-and-paste code and the expiry while awaiting payment", () => {
    const html = render({ status: status("AWAITING_PAYMENT") });
    expect(html).toContain("Pagar com Pix");
    expect(html).toContain(`src="${pix.qrCodeUrl.replace("&", "&amp;")}"`);
    expect(html).toContain('alt="QR Code do Pix"');
    expect(html).toContain("Pix copia e cola");
    expect(html).toContain(pix.qrCode);
    expect(html).toContain("Copiar código");
    // 15:30 UTC is 12:30 in Brasília.
    expect(html).toMatch(/Pague até <time[^>]*>12\/10, 12:30<\/time>/);
    expect(html).toContain(
      "Pagamentos processados por Pagar.me, uma empresa Stone.",
    );
  });

  it("shows the Pix from the checkout creation before the first status check", () => {
    const html = render({ status: null, pix });
    expect(html).toContain("Pix copia e cola");
    expect(html).toContain(pix.qrCode);
  });

  it("drops the Pix once the payment is received", () => {
    const html = render({ status: status("RECEIVED"), pix });
    expect(html).not.toContain("Pix copia e cola");
    expect(html).toContain("Recebimento confirmado");
  });

  it("stops asking for payment once the Pix deadline has passed", () => {
    vi.setSystemTime(new Date("2026-10-12T15:31:00.000Z"));
    const html = render({ status: status("AWAITING_PAYMENT") });
    expect(html).not.toContain("Pague até");
    expect(html).not.toContain("Copiar código");
    expect(html).not.toContain(pix.qrCode);
    expect(html).toMatch(/prazo deste Pix terminou/);
  });
});
