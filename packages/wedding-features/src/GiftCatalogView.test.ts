import type { PublicGiftItem } from "@entrelacos/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GiftCatalogView } from "./GiftCatalogView";

const gift: PublicGiftItem = {
  id: "gift-1",
  siteId: "site-1",
  title: "Jantar especial",
  description: "Uma contribuição para uma noite inesquecível.",
  nominalCents: 12_345,
  currency: "BRL",
  image: {
    url: "https://images.example.test/jantar.jpg",
    alt: "Mesa posta para um jantar",
  },
  sortOrder: 0,
};

describe("gift catalog view", () => {
  it("keeps accessible server search/navigation on an admitted empty page", () => {
    const html = renderToStaticMarkup(
      createElement(GiftCatalogView, {
        gifts: [],
        mode: "sandbox",
        busy: false,
        onSelect: vi.fn(),
        search: {
          value: "none",
          page: 2,
          total: 0,
          totalPages: 1,
          loading: false,
          error: false,
          onChange: vi.fn(),
          onPage: vi.fn(),
        },
      }),
    );
    expect(html).toContain('type="search"');
    expect(html).toContain("Buscar presentes");
    expect(html).toContain("Paginação dos presentes");
    expect(html).toContain("Nenhum presente");
    expect(html).not.toContain("Valor simbólico:");
  });
  it("renders nothing for disabled mode or an empty catalog", () => {
    const render = (
      mode: "disabled" | "sandbox" | "live",
      gifts: PublicGiftItem[],
    ) =>
      renderToStaticMarkup(
        createElement(GiftCatalogView, {
          gifts,
          mode,
          busy: false,
          onSelect: vi.fn(),
        }),
      );

    expect(render("disabled", [gift])).toBe("");
    expect(render("live", [])).toBe("");
  });

  it("shows public gift cards, accessible images and symbolic sandbox disclosure", () => {
    const html = renderToStaticMarkup(
      createElement(GiftCatalogView, {
        gifts: [gift],
        mode: "sandbox",
        busy: false,
        onSelect: vi.fn(),
      }),
    );

    expect(html).toContain("Jantar especial");
    expect(html).toContain("Uma contribuição para uma noite inesquecível.");
    expect(html).toContain('src="https://images.example.test/jantar.jpg"');
    expect(html).toContain('alt="Mesa posta para um jantar"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain("123,45");
    expect(html).toContain("Ambiente de testes — sem pagamentos reais.");
    expect(html).toContain("Presente simbólico");
    expect(html).toContain("não há produto físico ou entrega");
    expect(html).not.toMatch(/RSVP|login|entrar/i);
  });

  it("disables gift selection while busy and omits sandbox copy in live mode", () => {
    const html = renderToStaticMarkup(
      createElement(GiftCatalogView, {
        gifts: [gift],
        mode: "live",
        busy: true,
        onSelect: vi.fn(),
      }),
    );

    expect(html).toContain('disabled=""');
    expect(html).not.toContain("Ambiente de testes");
  });
});
