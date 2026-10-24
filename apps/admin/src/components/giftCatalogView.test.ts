import type { GiftItem } from "@entrelacos/contracts";
import { describe, expect, it } from "vitest";
import { getVisibleGifts } from "./GiftEditorView";

const gift = (
  id: string,
  title: string,
  publicationState: GiftItem["publicationState"],
  sortOrder: number,
): GiftItem => ({
  id,
  title,
  publicationState,
  sortOrder,
  siteId: "site-a",
  description: "Uma experiência a dois",
  nominalCents: 10000,
  currency: "BRL",
  mediaAssetId: null,
  altText: "",
  createdAt: "2026-10-12T12:00:00.000Z",
  updatedAt: "2026-10-12T12:00:00.000Z",
});
const gifts = [
  gift("a", "Café especial", "DRAFT", 2),
  gift("b", "Viagem", "PUBLISHED", 0),
  gift("c", "Jantar antigo", "ARCHIVED", 1),
];

describe("gift catalog filtering", () => {
  it("shows active gifts in their public order without changing the source", () => {
    expect(getVisibleGifts(gifts, "", "ACTIVE").map((item) => item.id)).toEqual(
      ["b", "a"],
    );
    expect(gifts.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });
  it("finds titles and descriptions ignoring accents, case and surrounding spaces", () => {
    expect(
      getVisibleGifts(gifts, "  CAFE ", "ACTIVE").map((item) => item.id),
    ).toEqual(["a"]);
    expect(
      getVisibleGifts(gifts, "EXPERIENCIA", "PUBLISHED").map((item) => item.id),
    ).toEqual(["b"]);
    expect(getVisibleGifts(gifts, "missing", "ACTIVE")).toEqual([]);
  });
  it("keeps published, drafts and archived history separate", () => {
    expect(
      getVisibleGifts(gifts, "", "PUBLISHED").map((item) => item.id),
    ).toEqual(["b"]);
    expect(getVisibleGifts(gifts, "", "DRAFT").map((item) => item.id)).toEqual([
      "a",
    ]);
    expect(
      getVisibleGifts(gifts, "jantar", "ARCHIVED").map((item) => item.id),
    ).toEqual(["c"]);
  });
});
