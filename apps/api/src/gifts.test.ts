import { randomUUID } from "node:crypto";
import { WeddingGiftsApi } from "../../../packages/wedding-features/src/gifts";
import { createGiftsHttpRouter } from "./giftsHttp";

describe("default public page HTTP-client", () => {
  it("delivers the complete20-card maximum multibyte raw projection through HTTP and the default client", async () => {
    const title = "界".repeat(120),
      description = "界".repeat(2000),
      alt = "界".repeat(240);
    const url =
      "https://media.example.test/" +
      "界".repeat(2048 - "https://media.example.test/".length);
    const items = Array.from({ length: 20 }, (_, i) => ({
      ...gift,
      id: `gift-${String(i).padStart(3, "0")}`,
      sortOrder: i,
      title,
      description,
      altText: alt,
      mediaAssetId: `media-${i}`,
    }));
    const f = fixture({
      gifts: items,
      media: items.map((g) => ({
        ...media,
        id: g.mediaAssetId,
        publicUrl: url,
      })),
    });
    const router = createGiftsHttpRouter({
      db: f.db,
      auth: {} as never,
      adminOrigin: "https://panel.example.test",
      ...f.options,
    });
    let transmitted = "";
    const fetcher = vi.fn(async (input, init) => {
      const response = await router.request(
        new Request(input, {
          ...init,
          headers: { Origin: "https://wedding.example.test" },
        }),
      );
      transmitted = await response.clone().text();
      return response;
    });
    const client = new WeddingGiftsApi({
      siteId,
      apiOrigin: "https://api.example.test",
      fetcher: fetcher as typeof fetch,
    });
    const page = await client.getCatalog();
    expect(page.gifts).toHaveLength(20);
    expect(page.gifts[0]).toMatchObject({
      title,
      description,
      image: { url, alt },
    });
    expect(JSON.parse(transmitted)).toEqual(page);
    expect(new TextEncoder().encode(transmitted).byteLength).toBeGreaterThan(
      131072,
    );
    expect(
      new TextEncoder().encode(transmitted).byteLength,
    ).toBeLessThanOrEqual(524288);
    expect(
      f.queries.filter((q) => /WITH matching AS/.test(q.sql)),
    ).toHaveLength(1);
  });

  it("carries the server query/page and native Response through the actual default client", async () => {
    const f = fixture({
      gifts: Array.from({ length: 25 }, (_, i) => ({
        ...gift,
        id: `gift-${i}`,
        sortOrder: i,
        title: "Café %_ special",
      })),
    });
    const router = createGiftsHttpRouter({
      db: f.db,
      auth: {} as never,
      adminOrigin: "https://panel.example.test",
      ...f.options,
    });
    const fetcher = vi.fn((url, init) =>
      router.request(
        new Request(url, {
          ...init,
          headers: { Origin: "https://wedding.example.test" },
        }),
      ),
    );
    const api = new WeddingGiftsApi({
      apiOrigin: "https://api.example.test",
      siteId,
      fetcher: fetcher as typeof fetch,
    });
    const page = await api.getCatalog({ page: 2, q: " Café %_ " });
    expect(page).toMatchObject({
      siteId,
      page: 2,
      q: "Café %_",
      total: 25,
      totalPages: 2,
      hasNext: false,
    });
    expect(page.gifts).toHaveLength(5);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toContain("page=2");
    expect(
      f.queries.filter((q) => /WITH matching AS/.test(q.sql)),
    ).toHaveLength(1);
  });
});

describe("unsafe server catalog count admission", () => {
  it.each(["", 0, false])(
    "never substitutes a null image for unsafe stored media binding %s",
    async (mediaAssetId) => {
      const f = fixture({ gifts: [{ ...gift, mediaAssetId }] });
      await expect(
        readPublicGifts(f.db, siteId, f.options),
      ).rejects.toMatchObject({ status: 503, code: "SERVICE_UNAVAILABLE" });
      expect(f.writes).toEqual([]);
    },
  );
  it.each([null, "", true, "00", " 1", "1e2"])(
    "refuses noncanonical database occupancy %s without writes",
    async (count) => {
      const f = fixture();
      const original = f.execute.getMockImplementation();
      if (!original) throw new Error("Missing mock database implementation");
      f.execute.mockImplementation(async (query) => {
        const compiled = new PgDialect().sqlToQuery(query);
        if (/AS "activeCount"/.test(compiled.sql))
          return { rows: [{ activeCount: count }] };
        return original(query);
      });
      await expect(
        createSiteGift(f.db, actor, siteId, input, f.options),
      ).rejects.toMatchObject({ status: 503, code: "SERVICE_UNAVAILABLE" });
      expect(f.writes).toEqual([]);
    },
  );
});

import type { ReceivingReadiness } from "@entrelacos/contracts";

describe("bounded server catalog adoption", () => {
  const rows = (count: number, publicationState = "PUBLISHED") =>
    Array.from({ length: count }, (_, i) => ({
      ...gift,
      id: `gift-${String(i).padStart(4, "0")}`,
      sortOrder: i,
      publicationState,
    }));
  it("selects count and the requested20 rows in one scoped parameterized snapshot", async () => {
    const f = fixture({ gifts: rows(45) });
    const page = await readPublicGifts(f.db, siteId, f.options, {
      page: 2,
      q: "",
    });
    expect(page).toMatchObject({
      siteId,
      page: 2,
      pageSize: 20,
      q: "",
      total: 45,
      totalPages: 3,
      hasNext: true,
    });
    expect(page.gifts.map((g) => g.id)).toEqual(
      rows(45)
        .slice(20, 40)
        .map((g) => g.id),
    );
    const queries = f.queries.filter((q) => /FROM gift_item/i.test(q.sql));
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toMatch(/WITH matching AS/i);
    expect(queries[0].sql).toMatch(/COUNT\(\*\)/i);
    expect(queries[0].sql).toMatch(/LEFT JOIN/i);
    expect(queries[0].sql).toMatch(/COLLATE "C"/);
    expect(queries[0].sql).toMatch(/LIMIT \$\d+ OFFSET \$\d+/);
    expect(queries[0].params).toEqual([siteId, "", "", 20, 20]);
  });
  it("retains legacy counts above200 and accurate empty out-of-range pages", async () => {
    const f = fixture({ gifts: rows(205) });
    const page = await readPublicGifts(f.db, siteId, f.options, {
      page: 12,
      q: "",
    });
    expect(page).toEqual({
      siteId,
      mode: "sandbox",
      gifts: [],
      page: 12,
      pageSize: 20,
      q: "",
      total: 205,
      totalPages: 11,
      hasNext: false,
    });
    expect(f.writes).toEqual([]);
    expect(f.queries.filter((q) => /FROM gift_item/i.test(q.sql))).toHaveLength(
      1,
    );
  });
  it.each(["%_", "'\\", "CAFÉ", "e\u0301"])(
    "binds literal search %s before paging and does not concatenate fields",
    async (q) => {
      const f = fixture({
        gifts: [
          ...rows(25).map((g) => ({ ...g, title: `prefix ${q} suffix` })),
          {
            ...gift,
            id: "excluded",
            title: q.slice(0, 1),
            description: q.slice(1),
            sortOrder: 26,
          },
        ],
      });
      const page = await readPublicGifts(f.db, siteId, f.options, {
        page: 2,
        q: ` ${q} `,
      });
      expect(page).toMatchObject({ q, total: 25, page: 2 });
      expect(page.gifts).toHaveLength(5);
      const query = f.queries.find((q) => /WITH matching AS/i.test(q.sql));
      expect(query?.sql).toMatch(/strpos\(lower\(title\), lower\(\$\d+\)\)/i);
      expect(query?.sql).toMatch(
        /OR strpos\(lower\(description\), lower\(\$\d+\)\)/i,
      );
      expect(query?.sql).not.toMatch(/ILIKE|concat|normalize|COLLATE[^C]+ICU/i);
      expect(query?.params).toEqual([siteId, q, q, 20, 20]);
    },
  );
  it("hydrates only selected page assets and preserves raw fields and an empty image alt", async () => {
    const items = rows(25).map((g, i) => ({
      ...g,
      title: "  Dinner  ",
      description: "  description  ",
      mediaAssetId: `asset-${i}`,
      altText: "",
    }));
    const f = fixture({
      gifts: items,
      media: items.map((g) => ({ ...media, id: g.mediaAssetId })),
    });
    const page = await readPublicGifts(f.db, siteId, f.options, {
      page: 2,
      q: "",
    });
    expect(page.gifts).toHaveLength(5);
    expect(page.gifts[0]).toMatchObject({
      title: "  Dinner  ",
      description: "  description  ",
      image: { url: media.publicUrl, alt: "" },
    });
    expect(
      f.queries.find((q) => /FROM gift_media_asset/i.test(q.sql))?.params,
    ).toEqual([siteId, items.slice(20).map((g) => g.mediaAssetId)]);
  });
  it.each([
    { title: `${" ".repeat(121)}Dinner` },
    { description: " ".repeat(2001) },
    { title: "bad\u0000title" },
    { title: "bad\ud800" },
  ])(
    "rejects an unsafe raw selected card as a whole503 page",
    async (changes) => {
      const f = fixture({ gifts: [{ ...gift, ...changes }] });
      await expect(
        readPublicGifts(f.db, siteId, f.options),
      ).rejects.toMatchObject({ status: 503, code: "SERVICE_UNAVAILABLE" });
      expect(f.writes).toEqual([]);
    },
  );
  it.each(["DRAFT", "PUBLISHED"] as const)(
    "admits199 active %s gifts then denies further growth at200",
    async (state) => {
      const f = fixture({
        gifts: [
          ...rows(199, state),
          ...rows(10, "ARCHIVED").map((g) => ({
            ...g,
            id: `archived-${g.id}`,
          })),
        ],
      });
      await createSiteGift(f.db, actor, siteId, input, f.options);
      expect(
        f.gifts().filter((g) => g.publicationState !== "ARCHIVED"),
      ).toHaveLength(200);
      await expect(
        createSiteGift(f.db, actor, siteId, input, f.options),
      ).rejects.toMatchObject({ status: 409, code: "REQUEST_CONFLICT" });
      expect(f.writes).toHaveLength(1);
      const capacity = f.queries.filter((q) => /AS "activeCount"/.test(q.sql));
      expect(capacity).toHaveLength(2);
      expect(capacity[0].sql).toMatch(
        /publication_state IN \('DRAFT', 'PUBLISHED'\)/,
      );
      expect(capacity[0].params).toEqual([siteId]);
    },
  );
  it.each(["DRAFT", "PUBLISHED"] as const)(
    "requires an available active slot when restoring ARCHIVED to %s",
    async (state) => {
      const current = { ...gift, id: "archived", publicationState: "ARCHIVED" };
      for (const count of [199, 200, 201]) {
        const f = fixture({ gifts: [...rows(count), current] });
        const work = updateSiteGiftPublication(
          f.db,
          actor,
          siteId,
          current.id,
          { publicationState: state },
          f.options,
        );
        if (count === 199)
          await expect(work).resolves.toMatchObject({
            gift: { id: current.id, publicationState: state },
          });
        else {
          await expect(work).rejects.toMatchObject({
            status: 409,
            code: "REQUEST_CONFLICT",
          });
          expect(f.writes).toEqual([]);
        }
      }
    },
  );
  it("keeps non-growing edits/publication/archival available at legacy occupancy", async () => {
    const f = fixture({ gifts: rows(201) });
    await updateSiteGift(
      f.db,
      actor,
      siteId,
      "gift-0000",
      { title: "Changed" },
      f.options,
    );
    await updateSiteGiftPublication(
      f.db,
      actor,
      siteId,
      "gift-0000",
      { publicationState: "DRAFT" },
      f.options,
    );
    await updateSiteGiftPublication(
      f.db,
      actor,
      siteId,
      "gift-0000",
      { publicationState: "ARCHIVED" },
      f.options,
    );
    expect(f.writes).toHaveLength(3);
    expect(f.queries.some((q) => /AS "activeCount"/.test(q.sql))).toBe(false);
  });
  it("counts the state refreshed after the existing site mutation lock", async () => {
    const f = fixture({ gifts: rows(199), giftsAfterLock: rows(200) });
    await expect(
      createSiteGift(f.db, actor, siteId, input, f.options),
    ).rejects.toMatchObject({ status: 409, code: "REQUEST_CONFLICT" });
    const lock = f.queries.findIndex((q) => /FOR UPDATE/.test(q.sql));
    const quota = f.queries.findIndex((q) => /AS "activeCount"/.test(q.sql));
    expect(quota).toBeGreaterThan(lock);
    expect(f.writes).toEqual([]);
  });
});

import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSiteGift,
  listSiteGifts,
  lookupPublishedGift,
  readPublicGifts,
  reorderSiteGifts,
  updateSiteGift,
  updateSiteGiftPublication,
} from "./gifts";
import { requireSiteCapability, SiteAccessDeniedError } from "./siteAccess";

vi.mock("node:crypto", async (original) => ({
  ...(await original<typeof import("node:crypto")>()),
  randomUUID: vi.fn(() => "new-gift"),
}));
vi.mock("./siteAccess", async (original) => ({
  ...(await original<typeof import("./siteAccess")>()),
  requireSiteCapability: vi.fn(),
}));

const now = new Date("2026-10-12T12:00:00.000Z");
const siteId = "site-1";
const actor = { userId: "assistant-1", role: "SITE_ASSISTANT" as const };
const ready: ReceivingReadiness = {
  siteId,
  state: "READY",
  reason: null,
  observedAt: now.toISOString(),
  destinationVersion: 1,
  catalogEligible: true,
  mode: "sandbox",
};
const blocked: ReceivingReadiness = {
  ...ready,
  state: "BLOCKED",
  reason: "EVIDENCE_STALE",
  catalogEligible: false,
};
const site = {
  id: siteId,
  lifecycle: "ACTIVE",
  publicationState: "PUBLISHED",
  isDemo: false,
  startsOn: "2026-01-01",
  endsOn: "2027-01-01",
};
const gift = {
  id: "gift-1",
  siteId,
  title: "Dinner",
  description: "A shared dinner",
  nominalCents: 12500,
  currency: "BRL",
  mediaAssetId: null,
  altText: "",
  sortOrder: 0,
  publicationState: "PUBLISHED",
  createdAt: now,
  updatedAt: now,
};
const media = {
  id: "media-1",
  siteId,
  stagingKey: "private/staging/media-1",
  derivativeKey: "public/site-1/media-1.webp",
  stableObjectVersion: "version-1",
  state: "FINALIZED",
  publicUrl: "https://media.example.test/public/site-1/media-1.webp",
  contentType: "image/webp",
  byteLength: 1234,
  width: 800,
  height: 600,
  expiresAt: new Date(now.getTime() + 60_000),
  createdAt: now,
  updatedAt: now,
};
const input = {
  title: " New gift ",
  description: " Gift description ",
  nominalCents: 5000,
  currency: "BRL" as const,
  mediaAssetId: null,
  altText: "",
};

function fixture(
  settings: {
    site?: Record<string, unknown> | null;
    gifts?: Array<Record<string, unknown>>;
    media?: Array<Record<string, unknown>>;
    readiness?: unknown;
    siteAfterLock?: Record<string, unknown> | null;
    rawTimestamps?: boolean;
    giftsAfterLock?: Array<Record<string, unknown>>;
  } = {},
) {
  let siteRow = settings.site === undefined ? { ...site } : settings.site;
  let giftRows: Array<Record<string, unknown>> = structuredClone(
    settings.gifts ?? [gift],
  );
  const mediaRows = settings.media ?? [{ ...media }];
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const writes: Array<{ values: Record<string, unknown>; params?: unknown[] }> =
    [];
  const execute = vi.fn(async (query) => {
    const compiled = new PgDialect().sqlToQuery(query);
    queries.push(compiled);
    if (/FROM site WHERE[\s\S]*FOR UPDATE/i.test(compiled.sql)) {
      if (siteRow?.id !== compiled.params[0]) return { rows: [] };
      if (settings.siteAfterLock !== undefined)
        siteRow = settings.siteAfterLock;
      if (settings.giftsAfterLock !== undefined)
        giftRows = structuredClone(settings.giftsAfterLock);
      return { rows: siteRow ? [{ id: siteRow.id }] : [] };
    }
    if (/FROM site s/i.test(compiled.sql)) {
      const snapshot = siteRow ? { ...siteRow } : null;
      if (
        /FOR UPDATE/i.test(compiled.sql) &&
        settings.siteAfterLock !== undefined
      ) {
        siteRow = settings.siteAfterLock;
      }
      return { rows: snapshot?.id === compiled.params[0] ? [snapshot] : [] };
    }
    if (/FROM gift_media_asset/i.test(compiled.sql)) {
      const ids = compiled.params[1];
      return {
        rows: mediaRows.filter(
          (row) =>
            row.siteId === compiled.params[0] &&
            (Array.isArray(ids) ? ids.includes(row.id) : row.id === ids),
        ),
      };
    }
    if (/FROM gift_item/i.test(compiled.sql)) {
      let rows = giftRows.filter((row) => row.siteId === compiled.params[0]);
      if (/AS "activeCount"/i.test(compiled.sql))
        return {
          rows: [
            {
              activeCount: String(
                rows.filter((row) =>
                  ["DRAFT", "PUBLISHED"].includes(String(row.publicationState)),
                ).length,
              ),
            },
          ],
        };
      if (/WITH matching AS/i.test(compiled.sql)) {
        const q = String(compiled.params[1]).toLowerCase();
        rows = rows.filter(
          (row) =>
            row.publicationState === "PUBLISHED" &&
            (String(row.title).toLowerCase().includes(q) ||
              String(row.description).toLowerCase().includes(q)),
        );
        rows.sort(
          (a, b) =>
            Number(a.sortOrder) - Number(b.sortOrder) ||
            (String(a.id) < String(b.id)
              ? -1
              : String(a.id) > String(b.id)
                ? 1
                : 0),
        );
        const total = String(rows.length);
        const offset = Number(compiled.params.at(-1));
        const selected = rows.slice(offset, offset + 20);
        return {
          rows: selected.length
            ? selected.map((row) => ({ ...row, total }))
            : [{ id: null, total }],
        };
      }
      if (/publication_state = 'PUBLISHED'/i.test(compiled.sql))
        rows = rows.filter((row) => row.publicationState === "PUBLISHED");
      if (/publication_state <> 'ARCHIVED'/i.test(compiled.sql))
        rows = rows.filter((row) => row.publicationState !== "ARCHIVED");
      if (/\bid = \$/i.test(compiled.sql))
        rows = rows.filter((row) => row.id === compiled.params[1]);
      if (/MAX\(sort_order\)/i.test(compiled.sql))
        return {
          rows: [
            {
              maxSortOrder: rows.length
                ? Math.max(...rows.map((row) => Number(row.sortOrder)))
                : -1,
            },
          ],
        };
      return {
        rows: rows
          .sort(
            (left, right) => Number(left.sortOrder) - Number(right.sortOrder),
          )
          .map((row) =>
            settings.rawTimestamps === false
              ? row
              : Object.fromEntries(
                  Object.entries(row).map(([key, value]) => [
                    key,
                    value instanceof Date && Number.isFinite(value.getTime())
                      ? value
                          .toISOString()
                          .replace("T", " ")
                          .replace("Z", "+00")
                      : value,
                  ]),
                ),
          ),
      };
    }
    return { rows: [] };
  });
  const db = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({ limit: async () => [{ id: "registered-origin" }] }),
      }),
    })),
    execute,
    transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) => {
      const snapshot = structuredClone(giftRows);
      try {
        return await operation(db);
      } catch (error) {
        giftRows = snapshot;
        throw error;
      }
    }),
    insert: vi.fn(() => ({
      values: vi.fn(async (values: Record<string, unknown>) => {
        writes.push({ values });
        giftRows.push(values);
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn((condition) => ({
          returning: vi.fn(async () => {
            const compiled = new PgDialect().sqlToQuery(condition);
            const matches = giftRows.filter(
              (row) =>
                row.siteId === compiled.params[0] &&
                row.id === compiled.params[1],
            );
            writes.push({ values, params: compiled.params });
            for (const row of matches) Object.assign(row, values);
            return matches;
          }),
        })),
      })),
    })),
  };
  const readReadiness = vi.fn().mockResolvedValue(settings.readiness ?? ready);
  return {
    db: db as never,
    options: { readReadiness, now: () => now },
    readReadiness,
    queries,
    writes,
    execute,
    transaction: db.transaction,
    gifts: () => giftRows,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireSiteCapability)
    .mockReset()
    .mockResolvedValue({} as never);
});

describe("catalog receiving and authorization gates", () => {
  it("defaults closed when no authoritative receiving loader is provided", async () => {
    const { db, writes } = fixture();
    await expect(
      createSiteGift(db, actor, siteId, input),
    ).rejects.toMatchObject({ status: 409, code: "RECEIVING_NOT_READY" });
    expect(writes).toEqual([]);
    expect(randomUUID).not.toHaveBeenCalled();
  });

  it.each([
    [
      "admin list",
      (f: ReturnType<typeof fixture>) =>
        listSiteGifts(f.db, actor, siteId, f.options),
    ],
    [
      "create",
      (f: ReturnType<typeof fixture>) =>
        createSiteGift(f.db, actor, siteId, input, f.options),
    ],
    [
      "edit",
      (f: ReturnType<typeof fixture>) =>
        updateSiteGift(
          f.db,
          actor,
          siteId,
          gift.id,
          { title: "Changed" },
          f.options,
        ),
    ],
    [
      "archive",
      (f: ReturnType<typeof fixture>) =>
        updateSiteGiftPublication(
          f.db,
          actor,
          siteId,
          gift.id,
          { publicationState: "ARCHIVED" },
          f.options,
        ),
    ],
    [
      "reorder",
      (f: ReturnType<typeof fixture>) =>
        reorderSiteGifts(
          f.db,
          actor,
          siteId,
          { giftIds: [gift.id] },
          f.options,
        ),
    ],
    [
      "public list",
      (f: ReturnType<typeof fixture>) =>
        readPublicGifts(f.db, siteId, f.options),
    ],
    [
      "quote lookup",
      (f: ReturnType<typeof fixture>) =>
        lookupPublishedGift(f.db, siteId, gift.id, f.options),
    ],
  ] as const)(
    "blocks %s while receiving is ineligible",
    async (_label, operation) => {
      const f = fixture({ readiness: blocked });
      await expect(operation(f)).rejects.toMatchObject({
        code: "RECEIVING_NOT_READY",
      });
      expect(f.writes).toEqual([]);
    },
  );

  it.each([
    { ...ready, siteId: "other-site" },
    { ...ready, mode: "disabled" },
    { ...ready, catalogEligible: false },
    { ...ready, observedAt: null },
    { ...ready, walletId: "private-account" },
  ])(
    "rejects contradictory, foreign or private readiness projections",
    async (readiness) => {
      const { db, options, writes } = fixture({ readiness });
      await expect(
        createSiteGift(db, actor, siteId, input, options),
      ).rejects.toMatchObject({ code: "RECEIVING_NOT_READY" });
      expect(writes).toEqual([]);
    },
  );

  it("fails closed when the readiness loader is unavailable", async () => {
    const { db, options, readReadiness, writes } = fixture();
    readReadiness.mockRejectedValue(new Error("private provider detail"));
    await expect(
      createSiteGift(db, actor, siteId, input, options),
    ).rejects.toMatchObject({ code: "RECEIVING_NOT_READY" });
    expect(writes).toEqual([]);
  });

  it("reuses the catalog transaction for receiving revalidation after locking the site", async () => {
    const f = fixture({ gifts: [{ ...gift, publicationState: "DRAFT" }] });
    f.readReadiness.mockImplementation(async (_siteId, transaction) => {
      const locked = f.queries.some((query) =>
        /FROM site WHERE[\s\S]*FOR UPDATE/i.test(query.sql),
      );
      if (locked && transaction !== f.db)
        throw new Error(
          "A separate receiving refresh would wait on the held site lock",
        );
      return ready;
    });
    await expect(
      updateSiteGiftPublication(
        f.db,
        actor,
        siteId,
        gift.id,
        { publicationState: "PUBLISHED" },
        f.options,
      ),
    ).resolves.toMatchObject({
      gift: { publicationState: "PUBLISHED" },
    });
    expect(f.readReadiness).toHaveBeenNthCalledWith(1, siteId);
    expect(f.readReadiness).toHaveBeenNthCalledWith(2, siteId, f.db);
    expect(f.writes).toHaveLength(1);
  });

  it("rechecks capability and receiving eligibility under the site lock", async () => {
    const { db, options, queries, writes, readReadiness } = fixture();
    readReadiness.mockResolvedValueOnce(ready).mockResolvedValueOnce(blocked);
    await expect(
      createSiteGift(db, actor, siteId, input, options),
    ).rejects.toMatchObject({ code: "RECEIVING_NOT_READY" });
    expect(requireSiteCapability).toHaveBeenCalledTimes(2);
    expect(queries[0].sql).toMatch(/FROM site WHERE[\s\S]*FOR UPDATE/i);
    expect(writes).toEqual([]);
  });

  it("samples the wedding date after the final readiness await", async () => {
    const f = fixture({ site: { ...site, endsOn: "2026-10-12" } });
    let time = new Date("2026-10-12T23:59:59.000-03:00");
    f.readReadiness
      .mockResolvedValueOnce(ready)
      .mockImplementationOnce(async () => {
        time = new Date("2026-10-13T00:00:00.000-03:00");
        return ready;
      });
    await expect(
      createSiteGift(f.db, actor, siteId, input, {
        ...f.options,
        now: () => time,
      }),
    ).rejects.toMatchObject({ code: "SITE_EXPIRED" });
    expect(f.writes).toEqual([]);
  });
  it("does not return a public catalog when the stored term expires during readiness", async () => {
    const f = fixture({ site: { ...site, endsOn: "2026-10-12" } });
    let time = new Date("2026-10-12T23:59:59.000-03:00");
    f.readReadiness.mockImplementationOnce(async () => {
      time = new Date("2026-10-13T00:00:00.000-03:00");
      return ready;
    });
    await expect(
      readPublicGifts(f.db, siteId, { ...f.options, now: () => time }),
    ).rejects.toMatchObject({ code: "SITE_INELIGIBLE" });
  });

  it("reads the changed joined term after acquiring the site lock before publication", async () => {
    const { db, options, queries, writes, transaction } = fixture({
      gifts: [{ ...gift, publicationState: "DRAFT" }],
      siteAfterLock: { ...site, endsOn: "2026-10-11" },
    });
    await expect(
      updateSiteGiftPublication(
        db,
        actor,
        siteId,
        gift.id,
        { publicationState: "PUBLISHED" },
        options,
      ),
    ).rejects.toMatchObject({ code: "SITE_EXPIRED" });
    const lockIndex = queries.findIndex((query) =>
      /FROM site WHERE[\s\S]*FOR UPDATE/i.test(query.sql),
    );
    const contextIndex = queries.findIndex((query) =>
      /FROM site s[\s\S]*LEFT JOIN site_term/i.test(query.sql),
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(contextIndex).toBeGreaterThan(lockIndex);
    expect(queries[contextIndex].sql).not.toMatch(/FOR UPDATE/i);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "read committed",
    });
    expect(writes).toEqual([]);
  });

  it("denies capability revocation while waiting for the site lock", async () => {
    vi.mocked(requireSiteCapability)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new SiteAccessDeniedError());
    const { db, options, writes } = fixture();
    await expect(
      createSiteGift(db, actor, siteId, input, options),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_DENIED" });
    expect(writes).toEqual([]);
  });

  it("rechecks the term clock after waiting for the site lock", async () => {
    const { db, options, writes } = fixture({
      site: { ...site, endsOn: "2026-10-12" },
    });
    options.now = vi
      .fn()
      .mockReturnValueOnce(new Date("2026-10-13T02:59:59.999Z"))
      .mockReturnValue(new Date("2026-10-13T03:00:00.000Z"));
    await expect(
      createSiteGift(db, actor, siteId, input, options),
    ).rejects.toMatchObject({ code: "SITE_EXPIRED" });
    expect(writes).toEqual([]);
  });

  it("denies revoked or cross-site assistant authority before catalog writes", async () => {
    vi.mocked(requireSiteCapability).mockRejectedValue(
      new SiteAccessDeniedError(),
    );
    const { db, options, writes, execute } = fixture();
    await expect(
      createSiteGift(db, actor, siteId, input, options),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_DENIED" });
    expect(writes).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { ...site, lifecycle: "INACTIVE" },
    { ...site, endsOn: "2026-10-11" },
  ])("blocks inactive or expired site mutations", async (siteRow) => {
    const { db, options, writes } = fixture({ site: siteRow });
    await expect(
      createSiteGift(db, actor, siteId, input, options),
    ).rejects.toMatchObject({ status: 409 });
    expect(writes).toEqual([]);
  });

  it("permits an authorized assistant catalog operation on a ready site", async () => {
    const { db, options } = fixture();
    const result = await createSiteGift(db, actor, siteId, input, options);
    expect(result.gift).toMatchObject({
      id: "new-gift",
      siteId,
      title: "New gift",
      nominalCents: 5000,
      currency: "BRL",
      sortOrder: 1,
      publicationState: "DRAFT",
    });
    expect(requireSiteCapability).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      siteId,
      "manageCatalog",
    );
  });

  it.each([undefined, "foreign-site", siteId])(
    "admits a live showcase catalog only under exact production opt-in (%s)",
    async (liveDemoSiteId) => {
      const v = fixture({
        site: { ...site, isDemo: true },
        readiness: { ...ready, mode: "live" },
      });
      const options = {
        ...v.options,
        applicationEnvironment: "production" as const,
        liveDemoSiteId,
      };
      if (liveDemoSiteId === siteId) {
        expect(
          (await createSiteGift(v.db, actor, siteId, input, options)).gift
            .nominalCents,
        ).toBe(input.nominalCents);
        expect((await readPublicGifts(v.db, siteId, options)).mode).toBe(
          "live",
        );
      } else {
        await expect(
          createSiteGift(v.db, actor, siteId, input, options),
        ).rejects.toMatchObject({ code: "RECEIVING_NOT_READY" });
        expect(v.writes).toEqual([]);
      }
    },
  );
  it("never accepts live readiness on a demo site", async () => {
    const { db, options, writes } = fixture({
      site: { ...site, isDemo: true },
      readiness: { ...ready, mode: "live" },
    });
    await expect(
      createSiteGift(db, actor, siteId, input, options),
    ).rejects.toMatchObject({ code: "RECEIVING_NOT_READY" });
    await expect(readPublicGifts(db, siteId, options)).rejects.toMatchObject({
      code: "RECEIVING_NOT_READY",
    });
    expect(writes).toEqual([]);
  });
});

describe("catalog validation and finalized media", () => {
  it.each([
    { nominalCents: 0 },
    { nominalCents: 1.5 },
    { nominalCents: -1 },
    { currency: "USD" },
    { publicationState: "PUBLISHED" },
    { walletId: "recipient" },
    { readiness: ready },
    { imageUrl: "https://example.test/private.jpg" },
  ])(
    "rejects invalid cents, currency or authoritative client extras",
    async (changes) => {
      const { db, options, writes } = fixture();
      await expect(
        createSiteGift(
          db,
          actor,
          siteId,
          { ...input, ...changes } as never,
          options,
        ),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(writes).toEqual([]);
    },
  );

  it("associates only a finalized same-site derivative with nonempty alt text", async () => {
    const { db, options } = fixture();
    const result = await createSiteGift(
      db,
      actor,
      siteId,
      { ...input, mediaAssetId: media.id, altText: " Dinner setting " },
      options,
    );
    expect(result.gift).toMatchObject({
      mediaAssetId: media.id,
      altText: "Dinner setting",
    });
  });

  it.each([
    { siteId: "other-site" },
    { state: "PENDING" },
    { derivativeKey: media.stagingKey },
    { derivativeKey: null },
    { stableObjectVersion: null },
    { publicUrl: "http://media.example.test/a.webp" },
    { publicUrl: "https://media.example.test/a.webp?token=private" },
    { publicUrl: `https://media.example.test/${media.stagingKey}` },
    { width: null },
    { byteLength: 0 },
    { contentType: "image/svg+xml" },
  ])(
    "rejects unfinished, cross-site or unsafe media before writing",
    async (changes) => {
      const { db, options, writes } = fixture({
        media: [{ ...media, ...changes }],
      });
      await expect(
        createSiteGift(
          db,
          actor,
          siteId,
          { ...input, mediaAssetId: media.id, altText: "Dinner" },
          options,
        ),
      ).rejects.toMatchObject({ code: "GIFT_MEDIA_INVALID" });
      expect(writes).toEqual([]);
    },
  );

  it("requires alt text when a media association is retained during an edit", async () => {
    const { db, options, writes } = fixture({
      gifts: [{ ...gift, mediaAssetId: media.id, altText: "Dinner" }],
    });
    await expect(
      updateSiteGift(db, actor, siteId, gift.id, { altText: " " }, options),
    ).rejects.toMatchObject({ code: "GIFT_MEDIA_INVALID" });
    expect(writes).toEqual([]);
  });

  it("rechecks finalized media before publishing an existing draft", async () => {
    const { db, options, writes } = fixture({
      gifts: [
        {
          ...gift,
          publicationState: "DRAFT",
          mediaAssetId: media.id,
          altText: "Dinner",
        },
      ],
      media: [{ ...media, state: "PENDING" }],
    });
    await expect(
      updateSiteGiftPublication(
        db,
        actor,
        siteId,
        gift.id,
        { publicationState: "PUBLISHED" },
        options,
      ),
    ).rejects.toMatchObject({ code: "GIFT_MEDIA_INVALID" });
    expect(writes).toEqual([]);
  });

  it("keeps gift IDs and references when archiving", async () => {
    const { db, options, gifts, queries } = fixture();
    const result = await updateSiteGiftPublication(
      db,
      actor,
      siteId,
      gift.id,
      { publicationState: "ARCHIVED" },
      options,
    );
    expect(result.gift).toMatchObject({
      id: gift.id,
      nominalCents: gift.nominalCents,
      publicationState: "ARCHIVED",
    });
    expect(gifts()).toHaveLength(1);
    expect(queries.some((query) => /DELETE/i.test(query.sql))).toBe(false);
  });

  it("updates only the requested stored gift and returns canonical cents", async () => {
    const { db, options, writes } = fixture();
    const result = await updateSiteGift(
      db,
      actor,
      siteId,
      gift.id,
      { nominalCents: 7000 },
      options,
    );
    expect(result.gift.nominalCents).toBe(7000);
    expect(writes[0].params).toEqual([siteId, gift.id]);
    expect(writes[0].values).not.toHaveProperty("id");
  });
});

describe("public catalog and authoritative quote lookup", () => {
  it("supports native driver Date objects when listing stored catalog rows", async () => {
    const f = fixture({ rawTimestamps: false });
    await expect(
      listSiteGifts(f.db, actor, siteId, f.options),
    ).resolves.toMatchObject({
      gifts: [{ createdAt: now.toISOString(), updatedAt: now.toISOString() }],
    });
  });

  it.each([1, 2])(
    "binds %i media IDs as one PostgreSQL text array",
    async (count) => {
      const assets = Array.from({ length: count }, (_, index) => ({
        ...media,
        id: `media-${index + 1}`,
      }));
      const f = fixture({
        gifts: assets.map((asset, index) => ({
          ...gift,
          id: `gift-${index + 1}`,
          mediaAssetId: asset.id,
          altText: "Dinner",
          sortOrder: index,
        })),
        media: assets,
      });
      const result = await readPublicGifts(f.db, siteId, f.options);
      expect(result.gifts.map((item) => item.image?.url)).toEqual(
        assets.map((asset) => asset.publicUrl),
      );
      const query = f.queries.find((item) =>
        /FROM gift_media_asset/i.test(item.sql),
      );
      expect(query?.sql).toMatch(/id = ANY\(\$2::text\[\]\)/);
      expect(query?.params).toEqual([siteId, assets.map((asset) => asset.id)]);
    },
  );

  it("does not query media for an empty ID set", async () => {
    const f = fixture();
    await readPublicGifts(f.db, siteId, f.options);
    expect(
      f.queries.some((item) => /FROM gift_media_asset/i.test(item.sql)),
    ).toBe(false);
  });

  it("keeps the native array scoped when its only matching media belongs to another site", async () => {
    const f = fixture({
      gifts: [{ ...gift, mediaAssetId: media.id, altText: "Dinner" }],
      media: [{ ...media, siteId: "other-site" }],
    });
    await expect(
      readPublicGifts(f.db, siteId, f.options),
    ).rejects.toMatchObject({ status: 503, code: "SERVICE_UNAVAILABLE" });
    const query = f.queries.find((item) =>
      /FROM gift_media_asset/i.test(item.sql),
    );
    expect(query?.params).toEqual([siteId, [media.id]]);
    expect(f.writes).toEqual([]);
  });

  it.each([
    "2026-10-12 12:00:00.123456+00",
    "2026-10-12T09:00:00.123456-03:00",
  ])(
    "projects raw-driver catalog timestamps %s through the existing public precision",
    async (timestamp) => {
      const f = fixture({
        gifts: [{ ...gift, createdAt: timestamp, updatedAt: timestamp }],
      });
      await expect(
        listSiteGifts(f.db, actor, siteId, f.options),
      ).resolves.toMatchObject({
        gifts: [
          {
            createdAt: "2026-10-12T12:00:00.123Z",
            updatedAt: "2026-10-12T12:00:00.123Z",
          },
        ],
      });
    },
  );

  it.each(["createdAt", "updatedAt"])(
    "denies invalid stored %s without projecting a catalog",
    async (field) => {
      const f = fixture({
        gifts: [{ ...gift, [field]: "2026-02-30 12:00:00+00" }],
      });
      await expect(
        listSiteGifts(f.db, actor, siteId, f.options),
      ).rejects.toMatchObject({
        status: 503,
        code: "SERVICE_UNAVAILABLE",
      });
      expect(f.writes).toEqual([]);
    },
  );

  it("projects PostgreSQL DATE terms as canonical strings at the raw query boundary", async () => {
    const { db, options, queries } = fixture();
    await readPublicGifts(db, siteId, options);
    const context = queries.find((query) => /FROM site s/i.test(query.sql));
    expect(context?.sql).toMatch(/to_char\(t\.starts_on, 'YYYY-MM-DD'\)/i);
    expect(context?.sql).toMatch(/to_char\(t\.ends_on, 'YYYY-MM-DD'\)/i);
  });

  it("returns only stored published gifts and labels sandbox mode", async () => {
    const { db, options } = fixture({
      site: { ...site, isDemo: true },
      gifts: [
        gift,
        { ...gift, id: "draft", publicationState: "DRAFT" },
        { ...gift, id: "archived", publicationState: "ARCHIVED" },
      ],
    });
    const result = await readPublicGifts(db, siteId, options);
    expect(result.mode).toBe("sandbox");
    expect(result.gifts.map((row) => row.id)).toEqual([gift.id]);
    expect(result.gifts[0]).not.toHaveProperty("mediaAssetId");
    expect(result.gifts[0]).not.toHaveProperty("createdAt");
    expect(result.gifts[0]).not.toHaveProperty("publicationState");
  });

  it("projects only immutable public image metadata for quote lookup", async () => {
    const { db, options } = fixture({
      gifts: [{ ...gift, mediaAssetId: media.id, altText: "Dinner" }],
    });
    const result = await lookupPublishedGift(db, siteId, gift.id, options);
    expect(result).toEqual({
      id: gift.id,
      siteId,
      title: gift.title,
      description: gift.description,
      nominalCents: gift.nominalCents,
      currency: "BRL",
      image: { url: media.publicUrl, alt: "Dinner" },
      sortOrder: 0,
    });
    expect(JSON.stringify(result)).not.toContain(media.stagingKey);
    expect(JSON.stringify(result)).not.toContain("stableObjectVersion");
    result.nominalCents = 1;
    expect(gift.nominalCents).toBe(12500);
  });

  it.each([
    { lifecycle: "INACTIVE" },
    { lifecycle: "DRAFT" },
    { publicationState: "UNPUBLISHED" },
    { startsOn: null },
    { endsOn: "2026-10-11" },
    { startsOn: "2026-10-13" },
  ])(
    "rejects nonpublic, missing-term or out-of-term sites",
    async (changes) => {
      const { db, options } = fixture({ site: { ...site, ...changes } });
      await expect(readPublicGifts(db, siteId, options)).rejects.toMatchObject({
        status: 409,
      });
    },
  );

  it("honors the inclusive term end date in the wedding timezone", async () => {
    const { db, options } = fixture({
      site: { ...site, startsOn: "2026-10-12", endsOn: "2026-10-12" },
    });
    options.now = () => new Date("2026-10-13T02:59:59.999Z");
    await expect(readPublicGifts(db, siteId, options)).resolves.toMatchObject({
      gifts: [expect.objectContaining({ id: gift.id })],
    });
    options.now = () => new Date("2026-10-13T03:00:00.000Z");
    await expect(readPublicGifts(db, siteId, options)).rejects.toMatchObject({
      status: 409,
    });
  });

  it.each(["DRAFT", "ARCHIVED"])(
    "rejects %s items for quote lookup",
    async (publicationState) => {
      const { db, options } = fixture({
        gifts: [{ ...gift, publicationState }],
      });
      await expect(
        lookupPublishedGift(db, siteId, gift.id, options),
      ).rejects.toMatchObject({ status: 404, code: "GIFT_NOT_FOUND" });
    },
  );

  it("cannot resolve another site's item or media", async () => {
    const { db, options } = fixture({
      gifts: [{ ...gift, siteId: "other-site" }],
    });
    await expect(
      lookupPublishedGift(db, siteId, gift.id, options),
    ).rejects.toMatchObject({ code: "GIFT_NOT_FOUND" });
  });
});

describe("complete current catalog reorder", () => {
  it("requires every non-archived current ID and preserves archived references", async () => {
    const { db, options, gifts } = fixture({
      gifts: [
        gift,
        { ...gift, id: "gift-2", sortOrder: 1, publicationState: "DRAFT" },
        { ...gift, id: "archived", sortOrder: 2, publicationState: "ARCHIVED" },
      ],
    });
    const result = await reorderSiteGifts(
      db,
      actor,
      siteId,
      { giftIds: ["gift-2", gift.id] },
      options,
    );
    expect(
      result.gifts
        .filter((row) => row.publicationState !== "ARCHIVED")
        .map((row) => row.id),
    ).toEqual(["gift-2", gift.id]);
    expect(gifts().find((row) => row.id === "archived")).toMatchObject({
      sortOrder: 2,
      publicationState: "ARCHIVED",
    });
  });

  it.each([
    { giftIds: [gift.id] },
    { giftIds: [gift.id, "foreign"] },
    { giftIds: [gift.id, "gift-2", "stale"] },
  ])(
    "rejects missing, foreign or stale IDs before changes",
    async ({ giftIds }) => {
      const { db, options, writes } = fixture({
        gifts: [gift, { ...gift, id: "gift-2", sortOrder: 1 }],
      });
      await expect(
        reorderSiteGifts(db, actor, siteId, { giftIds }, options),
      ).rejects.toMatchObject({ code: "GIFT_REORDER_CONFLICT" });
      expect(writes).toEqual([]);
    },
  );

  it("rejects duplicate IDs before accessing storage", async () => {
    const { db, options, writes, execute } = fixture();
    await expect(
      reorderSiteGifts(
        db,
        actor,
        siteId,
        { giftIds: [gift.id, gift.id] },
        options,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(writes).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
});
