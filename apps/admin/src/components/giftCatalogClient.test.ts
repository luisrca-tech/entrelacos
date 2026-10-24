import { describe, expect, it, vi } from "vitest";
import { GiftCatalogClient } from "./giftCatalogClient";

const gift = {
  id: "gift-a",
  siteId: "wedding-a",
  title: "Jantar",
  description: "Presente simbólico",
  nominalCents: 10000,
  currency: "BRL",
  mediaAssetId: null,
  altText: "",
  sortOrder: 0,
  publicationState: "DRAFT",
  createdAt: "2026-10-12T12:00:00.000Z",
  updatedAt: "2026-10-12T12:00:00.000Z",
};
const input = {
  title: gift.title,
  description: gift.description,
  nominalCents: gift.nominalCents,
  currency: "BRL",
  mediaAssetId: null,
  altText: "",
} as const;
describe("administrative catalog client", () => {
  it("uses C1 route verbs and sends only parsed nominal catalog fields", async () => {
    const request = vi.fn().mockResolvedValue({ gift });
    const client = new GiftCatalogClient("wedding-a", request);
    await expect(client.create(input)).resolves.toEqual(gift);
    expect(request).toHaveBeenLastCalledWith("/v1/sites/wedding-a/gifts", {
      method: "POST",
      body: input,
    });
    await client.update("gift-a", { title: "Outro presente" });
    expect(request).toHaveBeenLastCalledWith(
      "/v1/sites/wedding-a/gifts/gift-a",
      { method: "PATCH", body: { title: "Outro presente" } },
    );
    await client.publication("gift-a", "ARCHIVED");
    expect(request).toHaveBeenLastCalledWith(
      "/v1/sites/wedding-a/gifts/gift-a/publication",
      { method: "PATCH", body: { publicationState: "ARCHIVED" } },
    );
    request.mockResolvedValue({ gifts: [gift] });
    await client.reorder(["gift-a"]);
    expect(request).toHaveBeenLastCalledWith(
      "/v1/sites/wedding-a/gifts/reorder",
      { method: "POST", body: { giftIds: ["gift-a"] } },
    );
  });
  it("rejects foreign, duplicated, private and malformed server records", async () => {
    for (const gifts of [
      [{ ...gift, siteId: "wedding-b" }],
      [gift, gift],
      [{ ...gift, stagingKey: "private" }],
      [{ ...gift, nominalCents: -1 }],
    ]) {
      const client = new GiftCatalogClient(
        "wedding-a",
        vi.fn().mockResolvedValue({ gifts }),
      );
      await expect(client.list()).rejects.toThrow();
    }
    await expect(
      new GiftCatalogClient(
        "wedding-a",
        vi.fn().mockResolvedValue({ gift: { ...gift, id: "gift-b" } }),
      ).update("gift-a", { title: "Outro" }),
    ).rejects.toThrow();
  });
  it("rejects bad identifiers or browser financial/readiness overrides before requests", async () => {
    const request = vi.fn();
    expect(() => new GiftCatalogClient("../private", request)).toThrow();
    const client = new GiftCatalogClient("wedding-a", request);
    await expect(
      client.create({ ...input, readiness: "READY" } as never),
    ).rejects.toThrow();
    await expect(client.update("gift-a", {})).rejects.toThrow();
    await expect(
      client.update("../private", { title: "Outro" }),
    ).rejects.toThrow();
    await expect(client.reorder(["gift-a", "gift-a"])).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("preserves unavailable/readiness failures for the container to recheck", async () => {
    const failure = new Error("not ready");
    await expect(
      new GiftCatalogClient(
        "wedding-a",
        vi.fn().mockRejectedValue(failure),
      ).list(),
    ).rejects.toBe(failure);
  });
});
