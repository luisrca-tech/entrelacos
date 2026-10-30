import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGiftsHttpRouter } from "./giftsHttp";

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  publication: vi.fn(),
  reorder: vi.fn(),
  public: vi.fn(),
}));
vi.mock("./authHttp", async (original) => ({
  ...(await original<typeof import("./authHttp")>()),
  requireAdminSession: mocks.actor,
}));
vi.mock("./gifts", () => ({
  listSiteGifts: mocks.list,
  createSiteGift: mocks.create,
  updateSiteGift: mocks.update,
  updateSiteGiftPublication: mocks.publication,
  reorderSiteGifts: mocks.reorder,
  readPublicGifts: mocks.public,
  GiftServiceError: class extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      readonly title: string,
    ) {
      super(title);
    }
  },
}));

import { GiftServiceError } from "./gifts";

const adminOrigin = "https://panel.example.test",
  publicOrigin = "https://wedding.example.test";
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
const publicGift = {
  id: gift.id,
  siteId: gift.siteId,
  title: gift.title,
  description: gift.description,
  nominalCents: gift.nominalCents,
  currency: gift.currency,
  image: null,
  sortOrder: 0,
};
let originRows: unknown[];
const db = {
  select: () => ({
    from: () => ({ where: () => ({ limit: async () => originRows }) }),
  }),
} as never;
const router = () =>
  createGiftsHttpRouter({ auth: {} as never, db, adminOrigin });
const request = (
  path: string,
  method = "GET",
  body?: unknown,
  origin = adminOrigin,
) =>
  new Request(`https://api.example.test${path}`, {
    method,
    headers: { Origin: origin, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  originRows = [{ id: "origin-a" }];
  mocks.actor.mockResolvedValue({
    user: { id: "admin-a", role: "SITE_ADMIN" },
  });
  mocks.list.mockResolvedValue({ gifts: [gift] });
  mocks.create.mockResolvedValue({ gift });
  mocks.update.mockResolvedValue({ gift });
  mocks.publication.mockResolvedValue({ gift });
  mocks.reorder.mockResolvedValue({ gifts: [gift] });
  mocks.public.mockResolvedValue({
    siteId: "wedding-a",
    gifts: [publicGift],
    mode: "sandbox",
    page: 1,
    pageSize: 20,
    q: "",
    total: 1,
    totalPages: 1,
    hasNext: false,
  });
});
describe("gift catalog HTTP boundary", () => {
  it("marks buyer prices unavailable from stored site settings and fails closed on read errors", async () => {
    const readPricingSettings = vi.fn(async () => ({
      siteId: "wedding-a",
      feeAllocation: "BUYER_GROSS_UP" as const,
      revision: 1,
      buyerGrossUpAvailable: false as const,
      blockedReason: "External evidence missing",
    }));
    const configured = createGiftsHttpRouter({
      auth: {} as never,
      db,
      adminOrigin,
      readPricingSettings,
    });
    const response = await configured.request(
      request(
        "/v1/public/sites/wedding-a/gifts",
        "GET",
        undefined,
        publicOrigin,
      ),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).gifts[0].pricing).toEqual({
      feeAllocation: "BUYER_GROSS_UP",
      available: false,
    });
    expect(readPricingSettings).toHaveBeenCalledWith("wedding-a");
    readPricingSettings.mockRejectedValueOnce(new Error("Storage unavailable"));
    expect(
      (
        await configured.request(
          request(
            "/v1/public/sites/wedding-a/gifts",
            "GET",
            undefined,
            publicOrigin,
          ),
        )
      ).status,
    ).toBe(503);
  });
  it("binds catalog writes to server actor and strict stored-value inputs", async () => {
    const input = {
      title: gift.title,
      description: gift.description,
      nominalCents: 10000,
      currency: "BRL",
      mediaAssetId: null,
      altText: "",
    };
    expect(
      (
        await router().request(
          request("/v1/sites/wedding-a/gifts", "POST", input),
        )
      ).status,
    ).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(
      db,
      { userId: "admin-a", role: "SITE_ADMIN" },
      "wedding-a",
      input,
      expect.any(Object),
    );
    for (const extra of [
      { readiness: "READY" },
      { walletId: "private" },
      { siteId: "wedding-b" },
      { publicationState: "PUBLISHED" },
    ])
      expect(
        (
          await router().request(
            request("/v1/sites/wedding-a/gifts", "POST", {
              ...input,
              ...extra,
            }),
          )
        ).status,
      ).toBe(400);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it("keeps direct API readiness refusal and sanitizes provider/private diagnostics", async () => {
    mocks.list.mockRejectedValue(
      new GiftServiceError(
        409,
        "RECEIVING_NOT_READY",
        "private bank destination",
      ),
    );
    const response = await router().request(
      request("/v1/sites/wedding-a/gifts"),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "RECEIVING_NOT_READY",
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("requires exact admin origin and does not invoke catalog service for another origin", async () => {
    expect(
      (
        await router().request(
          request("/v1/sites/wedding-a/gifts", "GET", undefined, publicOrigin),
        )
      ).status,
    ).toBe(403);
    expect(mocks.actor).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("exposes public published projection only to registered same-site origins without RSVP auth", async () => {
    const response = await router().request(
      request(
        "/v1/public/sites/wedding-a/gifts",
        "GET",
        undefined,
        publicOrigin,
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      publicOrigin,
    );
    expect(await response.json()).toEqual({
      gifts: [publicGift],
      mode: "sandbox",
      siteId: "wedding-a",
      page: 1,
      pageSize: 20,
      q: "",
      total: 1,
      totalPages: 1,
      hasNext: false,
    });
    expect(mocks.actor).not.toHaveBeenCalled();
    originRows = [];
    expect(
      (
        await router().request(
          request(
            "/v1/public/sites/wedding-a/gifts",
            "GET",
            undefined,
            publicOrigin,
          ),
        )
      ).status,
    ).toBe(403);
    expect(mocks.public).toHaveBeenCalledTimes(1);
  });
  it("retains allowed-origin CORS headers on public locked-state errors and preflight", async () => {
    mocks.public.mockRejectedValue(
      new GiftServiceError(
        409,
        "RECEIVING_NOT_READY",
        "private bank destination",
      ),
    );
    const response = await router().request(
      request(
        "/v1/public/sites/wedding-a/gifts",
        "GET",
        undefined,
        publicOrigin,
      ),
    );
    expect(response.status).toBe(409);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      publicOrigin,
    );
    expect(await response.text()).not.toContain("private bank");
    expect(
      (
        await router().request(
          request(
            "/v1/public/sites/wedding-a/gifts",
            "OPTIONS",
            undefined,
            publicOrigin,
          ),
        )
      ).status,
    ).toBe(204);
  });
  it("registers scoped edit/publication/reorder operations and denies invalid reorder IDs", async () => {
    expect(
      (
        await router().request(
          request("/v1/sites/wedding-a/gifts/gift-a", "PATCH", {
            title: "Novo jantar",
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await router().request(
          request("/v1/sites/wedding-a/gifts/gift-a/publication", "PATCH", {
            publicationState: "ARCHIVED",
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await router().request(
          request("/v1/sites/wedding-a/gifts/reorder", "POST", {
            giftIds: ["gift-a"],
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await router().request(
          request("/v1/sites/wedding-a/gifts/reorder", "POST", {
            giftIds: ["gift-a", "gift-a"],
          }),
        )
      ).status,
    ).toBe(400);
  });
});

describe("catalog page HTTP protocol", () => {
  it.each([
    "?page=0",
    "?page=01",
    "?page=1.0",
    "?page=1e2",
    "?page=9007199254740991",
    "?page=1&page=2",
    "?q=a&q=b",
    "?q[]=x",
    "?scope=private",
    "?q=%FF",
    "?q=%",
    "?q=%00",
    `?q=${encodeURIComponent(" ".repeat(101))}`,
    `?q=${"%20".repeat(683)}`,
  ])(
    "rejects raw query %s before the public catalog service",
    async (query) => {
      const response = await router().request(
        request(
          `/v1/public/sites/wedding-a/gifts${query}`,
          "GET",
          undefined,
          publicOrigin,
        ),
      );
      expect(response.status).toBe(400);
      expect(mocks.public).not.toHaveBeenCalled();
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        publicOrigin,
      );
    },
  );
  it("passes canonical scope/page/q without Unicode normalization and transmits one exact final string", async () => {
    const q = "e\u0301 %_'\\";
    const page = {
      siteId: "wedding-a",
      mode: "sandbox",
      gifts: [],
      page: 12,
      pageSize: 20,
      q,
      total: 205,
      totalPages: 11,
      hasNext: false,
    };
    mocks.public.mockResolvedValue(page);
    const stringify = JSON.stringify;
    const serialized: string[] = [];
    const spy = vi
      .spyOn(JSON, "stringify")
      .mockImplementation((value, ...rest) => {
        const result = Reflect.apply(stringify, JSON, [value, ...rest]);
        if (value && typeof value === "object" && "pageSize" in value)
          serialized.push(result);
        return result;
      });
    try {
      const response = await router().request(
        request(
          "/v1/public/sites/wedding-a/gifts?page=12&q=" +
            encodeURIComponent(` ${q} `),
          "GET",
          undefined,
          publicOrigin,
        ),
      );
      expect(response.status).toBe(200);
      expect(mocks.public).toHaveBeenCalledWith(
        db,
        "wedding-a",
        expect.any(Object),
        { page: 12, q },
      );
      expect(await response.text()).toBe(serialized.at(-1));
      expect(JSON.parse(serialized.at(-1) ?? "null")).toEqual(page);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    } finally {
      spy.mockRestore();
    }
  });
  it("rejects invalid whole-page output without emitting a partial catalog", async () => {
    mocks.public.mockResolvedValue({
      siteId: "wedding-a",
      mode: "sandbox",
      gifts: [{ ...publicGift, title: "x".repeat(121) }],
      page: 1,
      pageSize: 20,
      q: "",
      total: 1,
      totalPages: 1,
      hasNext: false,
    });
    const response = await router().request(
      request(
        "/v1/public/sites/wedding-a/gifts",
        "GET",
        undefined,
        publicOrigin,
      ),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(publicGift.id);
  });
});

describe("Sandbox buyer catalog projection", () => {
  it.each([
    ["sandbox", true],
    ["live", false],
    ["disabled", false],
  ] as const)(
    "advertises homologation only in a scoped Sandbox catalog: %s",
    async (mode, allowed) => {
      mocks.public.mockResolvedValueOnce({
        siteId: "wedding-a",
        gifts: [publicGift],
        mode,
        page: 1,
        pageSize: 20,
        q: "",
        total: 1,
        totalPages: 1,
        hasNext: false,
      });
      const app = createGiftsHttpRouter({
        auth: {} as never,
        db,
        adminOrigin,
        sandboxBuyerGrossUpAvailable: async () => true,
        readPricingSettings: async () => ({
          siteId: "wedding-a",
          feeAllocation: "BUYER_GROSS_UP",
          revision: 4,
          buyerGrossUpAvailable: false,
          blockedReason: "Live unavailable",
        }),
      });
      const response = await app.request(
        request(
          "/v1/public/sites/wedding-a/gifts",
          "GET",
          undefined,
          publicOrigin,
        ),
      );
      expect(response.status).toBe(200);
      expect((await response.json()).gifts[0].pricing).toEqual({
        feeAllocation: "BUYER_GROSS_UP",
        available: allowed,
        ...(allowed ? { sandboxHomologation: true } : {}),
      });
    },
  );
});
