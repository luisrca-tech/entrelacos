import type { ReceivingReadiness } from "@entrelacos/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paymentsAvailabilityStore } from "../lib/paymentsAvailability";
import { GiftsReadinessView } from "./GiftsSection";
import { loadGiftsReadiness } from "./giftsReadiness";

const locked: ReceivingReadiness = {
  siteId: "wedding-a",
  state: "BANK_VALIDATION_PENDING",
  reason: "BANK_VERIFICATION_REQUIRED",
  observedAt: null,
  destinationVersion: null,
  catalogEligible: false,
  mode: "sandbox",
};
const apiDisabled: ReceivingReadiness = {
  ...locked,
  state: "BLOCKED",
  reason: "PROVIDER_DISABLED",
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
    vi.stubEnv("PUBLIC_GIFT_PAYMENTS_ENABLED", "false");
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

describe("gifts while the API has payments disabled", () => {
  const receivingAction = createElement(
    "a",
    { href: "/sites/wedding-a/receiving" },
    "Ver recebimentos",
  );
  const render = (readiness: ReceivingReadiness, extra = {}) =>
    renderToStaticMarkup(
      createElement(GiftsReadinessView, {
        siteId: "wedding-a",
        readiness,
        onRetry: vi.fn(),
        receivingAction,
        ...extra,
      }),
    );

  it("shows a calm coming-soon state instead of the receiving steps", () => {
    const html = render(apiDisabled);
    expect(html).toContain("Presentes em dinheiro em breve");
    expect(html).toContain(
      "Os presentes em dinheiro estarão disponíveis em breve.",
    );
    expect(html).not.toContain("Configure os recebimentos primeiro");
    expect(html).not.toContain("não estão disponíveis para ativação");
    expect(html).not.toContain("Ver recebimentos");
    expect(html).not.toContain("/receiving");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("Adicionar presente");
  });

  it("keeps a demonstration catalog manageable", () => {
    const demo = renderToStaticMarkup(
      createElement(GiftsReadinessView, {
        siteId: "wedding-a",
        readiness: {
          ...apiDisabled,
          catalogAccess: { siteId: "wedding-a", mode: "demonstration" },
        },
        onRetry: vi.fn(),
        catalog: createElement("p", null, "Adicionar presente"),
      }),
    );
    expect(demo).toContain("Adicionar presente");
    expect(demo).not.toContain("Presentes em dinheiro em breve");
  });

  it("still asks for the receiving setup once the API accepts payments", () => {
    const html = render(locked);
    expect(html).toContain("Configure os recebimentos primeiro");
    expect(html).toContain("Ver recebimentos");
    expect(html).not.toContain("Presentes em dinheiro em breve");
  });
});

describe("gift readiness read", () => {
  beforeEach(() => paymentsAvailabilityStore.reset());
  afterEach(() => paymentsAvailabilityStore.reset());
  const answer = (readiness: ReceivingReadiness) => async () => ({ readiness });
  it("tells the availability store what mode the API reports", async () => {
    await loadGiftsReadiness("wedding-a", answer(apiDisabled));
    expect(paymentsAvailabilityStore.get()).toBe("unavailable");
    await loadGiftsReadiness("wedding-a", answer(locked));
    expect(paymentsAvailabilityStore.get()).toBe("available");
  });
  it("leaves the store alone for a response about another site", async () => {
    await expect(
      loadGiftsReadiness("wedding-b", answer(locked)),
    ).rejects.toThrow();
    expect(paymentsAvailabilityStore.get()).toBe("unknown");
  });
});
