import { describe, expect, it, vi } from "vitest";

const lookup = vi.hoisted(() => vi.fn());
vi.mock("./gifts", () => ({ lookupPublishedGift: lookup }));

import { findPublishedGiftForQuote } from "./giftQuoteLookup";

describe("authoritative quote gift adapter", () => {
  it("maps only the result of the bound authoritative published lookup", async () => {
    const gift = {
      id: "gift-a",
      siteId: "wedding-a",
      title: "Jantar",
      description: "",
      nominalCents: 10000,
      currency: "BRL",
      image: null,
      sortOrder: 0,
    };
    lookup.mockResolvedValueOnce(gift);
    const db = {} as never;
    const options = { now: () => new Date("2026-10-12T12:00:00.000Z") };
    await expect(
      findPublishedGiftForQuote(db, "wedding-a", "gift-a", options),
    ).resolves.toEqual({
      gift,
      publicationState: "PUBLISHED",
      siteActive: true,
    });
    expect(lookup).toHaveBeenLastCalledWith(db, "wedding-a", "gift-a", options);
  });
  it("propagates ineligible or unavailable lookup instead of supplying active flags", async () => {
    const failure = new Error("receiving not ready");
    lookup.mockRejectedValueOnce(failure);
    await expect(
      findPublishedGiftForQuote({} as never, "wedding-a", "gift-a"),
    ).rejects.toBe(failure);
  });
});
