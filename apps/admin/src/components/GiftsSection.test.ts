import type { ReceivingReadiness } from "@entrelacos/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GiftsReadinessView } from "./GiftsSection";

const locked: ReceivingReadiness = {
  siteId: "wedding-a",
  state: "BANK_VALIDATION_PENDING",
  reason: "BANK_VERIFICATION_REQUIRED",
  observedAt: null,
  destinationVersion: null,
  catalogEligible: false,
  mode: "disabled",
};

describe("gift readiness rendering", () => {
  it("keeps controls locked while loading, after failures and for another site", () => {
    for (const props of [
      { siteId: "wedding-a", readiness: null },
      { siteId: "wedding-b", readiness: locked },
      { siteId: "wedding-a", readiness: null, error: true },
    ]) {
      const html = renderToStaticMarkup(
        createElement(GiftsReadinessView, { ...props, onRetry: vi.fn() }),
      );
      expect(html).not.toContain("Adicionar presente");
      expect(html).not.toContain("<form");
      expect(html).not.toContain("Verificado");
    }
  });

  it("renders a safe actionable bank verification reason", () => {
    const html = renderToStaticMarkup(
      createElement(GiftsReadinessView, {
        siteId: "wedding-a",
        readiness: locked,
        onRetry: vi.fn(),
      }),
    );
    expect(html).toContain("conta de destino ainda precisa de verificação");
    expect(html).toContain("Configure os recebimentos primeiro");
    expect(html).not.toContain("wallet");
    expect(html).not.toContain("Adicionar presente");
  });

  it("labels sandbox readiness without exposing an unimplemented catalog", () => {
    const readiness: ReceivingReadiness = {
      ...locked,
      state: "READY",
      reason: null,
      observedAt: "2026-10-12T12:00:00.000Z",
      destinationVersion: 1,
      catalogEligible: true,
      mode: "sandbox",
    };
    const html = renderToStaticMarkup(
      createElement(GiftsReadinessView, {
        siteId: "wedding-a",
        readiness,
        onRetry: vi.fn(),
      }),
    );
    expect(html).toContain("Ambiente de testes");
    expect(html).not.toContain("Adicionar presente");
  });
});

beforeEach(() => vi.stubGlobal("__APP_ENV__", "development"));
afterEach(() => vi.unstubAllGlobals());

it("opens the editor only for the matching server demonstration grant while finance stays locked", () => {
  const catalog = createElement(
    "button",
    { type: "button" },
    "Adicionar presente",
  );
  const render = (catalogSite: string) =>
    renderToStaticMarkup(
      createElement(GiftsReadinessView, {
        siteId: locked.siteId,
        readiness: {
          ...locked,
          catalogAccess: { siteId: catalogSite, mode: "demonstration" },
        },
        catalog,
        onRetry: vi.fn(),
      }),
    );
  expect(render(locked.siteId)).toContain("Adicionar presente");
  expect(render(locked.siteId)).toContain(
    "contribuições e recebimentos continuam indisponíveis",
  );
  expect(render("foreign")).not.toContain("Adicionar presente");
  expect(render(locked.siteId)).not.toContain("Recebimentos verificados");
});

describe("locked gifts with money gifts switched off", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("announces the pause instead of sending admins to the receiving setup", () => {
    vi.stubEnv("PUBLIC_GIFT_PAYMENTS_ENABLED", undefined);
    const html = renderToStaticMarkup(
      createElement(GiftsReadinessView, {
        siteId: "wedding-a",
        readiness: locked,
        onRetry: vi.fn(),
        receivingAction: createElement(
          "a",
          { href: "/sites/wedding-a/receiving" },
          "Ver recebimentos",
        ),
      }),
    );
    expect(html).toContain(
      "Os presentes em dinheiro estarão disponíveis em breve.",
    );
    expect(html).not.toContain("Configure os recebimentos primeiro");
    expect(html).not.toContain("conta de destino");
    expect(html).not.toContain("Ver recebimentos");
    expect(html).not.toContain("/receiving");
  });
});
