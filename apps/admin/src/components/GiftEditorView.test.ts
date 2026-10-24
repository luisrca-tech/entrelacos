import type {
  GiftCreateInput,
  GiftItem,
  GiftUpdateInput,
} from "@entrelacos/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  GiftEditorView,
  getReorderedGiftIds,
  parseGiftPriceToCents,
  runGiftMutationWhenReady,
} from "./GiftEditorView";

const gifts: GiftItem[] = [
  {
    id: "gift-draft-private-id",
    siteId: "site-1",
    title: "Jantar especial",
    description: "Uma noite para celebrar.",
    nominalCents: 12_345,
    currency: "BRL",
    mediaAssetId: "asset-private-id",
    altText: "Mesa de jantar",
    sortOrder: 0,
    publicationState: "DRAFT",
    createdAt: "2026-10-12T12:00:00.000Z",
    updatedAt: "2026-10-12T12:00:00.000Z",
  },
  {
    id: "gift-published-private-id",
    siteId: "site-1",
    title: "Passeio a dois",
    description: "Um passeio durante a viagem.",
    nominalCents: 8_000,
    currency: "BRL",
    mediaAssetId: null,
    altText: "",
    sortOrder: 1,
    publicationState: "PUBLISHED",
    createdAt: "2026-10-12T12:00:00.000Z",
    updatedAt: "2026-10-12T12:00:00.000Z",
  },
  {
    id: "gift-archived-private-id",
    siteId: "site-1",
    title: "Presente antigo",
    description: "Um item preservado no histórico.",
    nominalCents: 5_000,
    currency: "BRL",
    mediaAssetId: null,
    altText: "",
    sortOrder: 2,
    publicationState: "ARCHIVED",
    createdAt: "2026-10-12T12:00:00.000Z",
    updatedAt: "2026-10-12T12:00:00.000Z",
  },
];

const callbacks = () => ({
  onRetry: vi.fn(),
  onCreate: vi.fn(async (_input: GiftCreateInput) => {}),
  onUpdate: vi.fn(async (_giftId: string, _input: GiftUpdateInput) => {}),
  onPublication: vi.fn(
    async (_giftId: string, _state: GiftItem["publicationState"]) => {},
  ),
  onReorder: vi.fn(async (_giftIds: string[]) => {}),
});

describe("gift editor view", () => {
  it.each([
    { loading: true, error: null },
    { loading: false, error: "Falha ao carregar o catálogo." },
  ])(
    "disables catalog mutations and blocks callbacks in unavailable state",
    (state) => {
      const handlers = callbacks();
      const html = renderToStaticMarkup(
        createElement(GiftEditorView, { gifts, ...state, ...handlers }),
      );
      const buttons = [
        ...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g),
      ];
      const mutationButtons = buttons.filter(
        ([, , label]) => !label?.includes("Tentar novamente"),
      );

      expect(mutationButtons.length).toBeGreaterThan(0);
      for (const [, attributes] of mutationButtons) {
        expect(attributes).toContain('disabled=""');
      }
      for (const [, field] of html.matchAll(/<(?:input|textarea)\b([^>]*)>/g)) {
        expect(field).toContain('disabled=""');
      }

      const mutation = vi.fn();
      expect(runGiftMutationWhenReady(state, mutation)).toBeUndefined();
      expect(mutation).not.toHaveBeenCalled();
      if (state.error) {
        expect(html).toMatch(
          /<button\b(?![^>]*disabled="")[^>]*>Tentar novamente<\/button>/,
        );
      }
    },
  );

  it("parses BRL decimals into exact safe integer cents", () => {
    expect(parseGiftPriceToCents("12,34")).toBe(1_234);
    expect(parseGiftPriceToCents("12.34")).toBe(1_234);
    expect(parseGiftPriceToCents("0,01")).toBe(1);
    expect(parseGiftPriceToCents("1")).toBe(100);
    expect(parseGiftPriceToCents("21474836,47")).toBe(2_147_483_647);
  });

  it.each([
    "",
    "0",
    "-1,00",
    "1,001",
    "1.234,56",
    "21474836,48",
    "90071992547409,92",
  ])("rejects invalid or unsafe BRL value %s", (value) => {
    expect(parseGiftPriceToCents(value)).toBeNull();
  });

  it("reorders every non-archived ID and rejects boundary or archived moves", () => {
    expect(getReorderedGiftIds(gifts, "gift-draft-private-id", "down")).toEqual(
      ["gift-published-private-id", "gift-draft-private-id"],
    );
    expect(
      getReorderedGiftIds(gifts, "gift-draft-private-id", "up"),
    ).toBeNull();
    expect(
      getReorderedGiftIds(gifts, "gift-published-private-id", "down"),
    ).toBeNull();
    expect(
      getReorderedGiftIds(gifts, "gift-archived-private-id", "up"),
    ).toBeNull();
  });

  it("projects active gifts with publication controls and keeps editors out of the catalog", () => {
    const html = renderToStaticMarkup(
      createElement(GiftEditorView, { gifts, ...callbacks() }),
    );

    for (const text of [
      "Jantar especial",
      "Passeio a dois",
      "Rascunho",
      "Publicado",
      "Arquivados",
      "Publicar",
      "Despublicar",
      "contribuição simbólica para o casal",
    ]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Presente antigo");
    expect(html).toContain("Editar presente");
    expect(html).toContain("Adicionar presente");
    expect(html).not.toContain("gift-draft-private-id");
    expect(html).not.toContain("gift-published-private-id");
    expect(html).not.toContain("gift-archived-private-id");
    expect(html).not.toContain("asset-private-id");
    expect(html).not.toContain("Excluir");
    expect(html).not.toContain("Upload");
    expect(html).toContain('aria-label="Mover Jantar especial para baixo"');
    expect(html).not.toContain('aria-label="Mover Presente antigo');
  });

  it("keeps empty, loading and error states distinct and offers retry on failure", () => {
    const render = (props: {
      gifts: GiftItem[];
      loading?: boolean;
      error?: string;
    }) =>
      renderToStaticMarkup(
        createElement(GiftEditorView, { ...callbacks(), ...props }),
      );

    expect(render({ gifts: [] })).toContain(
      "Ainda não há presentes cadastrados.",
    );
    const loading = render({ gifts: [], loading: true });
    expect(loading).toContain('role="status"');
    expect(loading).toContain("Carregando catálogo");
    expect(loading).not.toContain("Ainda não há presentes cadastrados.");
    const error = render({ gifts: [], error: "Falha ao carregar o catálogo." });
    expect(error).toContain('role="alert"');
    expect(error).toContain("Falha ao carregar o catálogo.");
    expect(error).toContain("Tentar novamente");
  });

  it("disables editing and publication controls while busy", () => {
    const html = renderToStaticMarkup(
      createElement(GiftEditorView, { gifts, busy: true, ...callbacks() }),
    );

    expect(html).toContain('disabled=""');
    expect(html).toContain("Publicar");
    expect(html).toContain("Despublicar");
  });
});
