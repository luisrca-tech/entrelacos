import {
  type GiftPurchaseHistoryPageResponse,
  giftPurchaseHistoryPageResponseSchema,
} from "@entrelacos/contracts";
import { describe, expect, it } from "vitest";
import { encodeGiftPurchaseHistoryCsv } from "./giftPaymentHistoryCsv";

const columns = [
  "recordType",
  "exportScope",
  "siteId",
  "mode",
  "policy",
  "consistency",
  "readObservedAtMicros",
  "currentKnowledge",
  "sourceOrdering",
  "indexContinuation",
  "continuationCursor",
  "orderId",
  "quoteId",
  "giftId",
  "titleSnapshot",
  "method",
  "currency",
  "purchasedAtMicros",
  "destinationVersion",
  "policyVersion",
  "binding",
  "quotedNominalCents",
  "quotedCommissionCents",
  "quotedProcessingCents",
  "quotedTotalCents",
];
function page(): GiftPurchaseHistoryPageResponse {
  return {
    history: {
      scope: { siteId: "site-one", mode: "sandbox", policy: "SITE_HISTORY" },
      consistency: "PER_READ",
      readObservedAtMicros: "253402300799999999",
      currentKnowledge: "UNKNOWN",
      sourceOrdering: "UNAVAILABLE",
      nextCursor: null,
      items: [
        {
          siteId: "site-one",
          mode: "sandbox",
          orderId: "order-one",
          quoteId: "quote-one",
          giftId: "gift-one",
          titleSnapshot: 'Original "gift", Unicode 界',
          method: "PIX",
          currency: "BRL",
          purchasedAtMicros: "253402300799999998",
          destinationVersion: 1,
          policyVersion: "original-policy",
          binding: "UNBOUND",
          quoted: {
            nominalCents: 10000,
            commissionCents: 200,
            processingCents: 39,
            totalCents: 10239,
          },
        },
      ],
    },
  };
}
function decode(csv: string): string[][] {
  const lines = csv.split("\r\n");
  expect(lines.pop()).toBe("");
  return lines.map((line) => {
    const encoded = line.match(/"(?:[^"]|"")*"(?:,|$)/g) ?? [];
    expect(encoded.join("")).toBe(line);
    const cells = encoded.map((cell) => {
      const value = cell.endsWith(",") ? cell.slice(0, -1) : cell;
      return value.slice(1, -1).replaceAll('""', '"');
    });
    expect(cells).toHaveLength(25);
    return cells;
  });
}
function unavailable(value: unknown, siteId = "site-one") {
  expect(() => encodeGiftPurchaseHistoryCsv(value, siteId)).toThrowError(
    expect.objectContaining({
      status: 503,
      code: "GIFT_PAYMENT_HISTORY_UNAVAILABLE",
      message: "Purchase history unavailable",
    }),
  );
}
describe("purchase-index-only CSV encoding", () => {
  it("quotes every cell with exact META, original quoted cents and lossless microseconds", () => {
    const value = page();
    const original = structuredClone(value);
    const csv = encodeGiftPurchaseHistoryCsv(value, "site-one");
    expect(csv).toBe(
      [
        columns.map((column) => `"${column}"`).join(","),
        `"META","PURCHASE_INDEX_ONLY","'site-one","sandbox","SITE_HISTORY","PER_READ","'253402300799999999","UNKNOWN","UNAVAILABLE","END_OF_CURRENT_INDEX","","","","","","","","","","","","","","",""`,
        `"PURCHASE","PURCHASE_INDEX_ONLY","'site-one","sandbox","SITE_HISTORY","PER_READ","'253402300799999999","UNKNOWN","UNAVAILABLE","END_OF_CURRENT_INDEX","","'order-one","'quote-one","'gift-one","'Original ""gift"", Unicode 界","PIX","BRL","'253402300799999998","1","'original-policy","UNBOUND","10000","200","39","10239"`,
      ].join("\r\n") + "\r\n",
    );
    expect(decode(csv)[0]).toEqual(columns);
    expect(value).toEqual(original);
  });
  it("exports an empty index with mandatory META and visible incomplete knowledge", () => {
    const value = page();
    value.history.items = [];
    value.history.currentKnowledge = "UNAVAILABLE";
    const rows = decode(encodeGiftPurchaseHistoryCsv(value, "site-one"));
    expect(rows).toHaveLength(2);
    expect(rows[1].slice(0, 11)).toEqual([
      "META",
      "PURCHASE_INDEX_ONLY",
      "'site-one",
      "sandbox",
      "SITE_HISTORY",
      "PER_READ",
      "'253402300799999999",
      "UNAVAILABLE",
      "UNAVAILABLE",
      "END_OF_CURRENT_INDEX",
      "",
    ]);
    expect(rows[1].slice(11)).toEqual(Array(14).fill(""));
  });
  it("preserves all 25 purchases in original tied-microsecond source order", () => {
    const value = page();
    const original = value.history.items[0];
    value.history.items = Array.from({ length: 25 }, (_, index) => ({
      ...original,
      orderId: `order-${String(24 - index).padStart(2, "0")}`,
      quoteId: `quote-${String(24 - index).padStart(2, "0")}`,
    }));
    const cursor = `gh1.${"A".repeat(250)}_-`;
    value.history.nextCursor = cursor;
    const rows = decode(encodeGiftPurchaseHistoryCsv(value, "site-one"));
    expect(rows).toHaveLength(27);
    expect(rows.slice(2).map((row) => row[11])).toEqual(
      value.history.items.map((item) => `'${item.orderId}`),
    );
    expect(
      rows.slice(1).every((row) => row[9] === "MORE" && row[10] === cursor),
    ).toBe(true);
    expect(
      rows.slice(2).every((row) => row[17] === "'253402300799999998"),
    ).toBe(true);
    expect(rows.slice(1).every((row) => row[1] === "PURCHASE_INDEX_ONLY")).toBe(
      true,
    );
  });
  it.each([
    "=1+1",
    "+1+1",
    "-1+1",
    "@SUM(1)",
    "＝1+1",
    "＋1+1",
    "－1+1",
    "＠SUM(1)",
    "\u200B=1+1",
    "\u2060＠SUM(1)",
    "ordinary Unicode 界😀",
    "'already quoted",
    '="a,b"',
  ])(
    "adds exactly one presentation apostrophe without trimming title %s",
    (title) => {
      const value = page();
      value.history.items[0].titleSnapshot = title;
      giftPurchaseHistoryPageResponseSchema.parse(value);
      const csv = encodeGiftPurchaseHistoryCsv(value, "site-one");
      expect(decode(csv)[2][14]).toBe(`'${title}`);
      expect(csv).toContain(`"'${title.replaceAll('"', '""')}"`);
      expect(value.history.items[0].titleSnapshot).toBe(title);
    },
  );
  it("prefixes all eight nonempty text columns while keeping labels, integers and empty cells exact", () => {
    const rows = decode(encodeGiftPurchaseHistoryCsv(page(), "site-one"));
    for (const index of [2, 6, 11, 12, 13, 14, 17, 19])
      expect(rows[2][index].startsWith("'")).toBe(true);
    for (const index of [
      0, 1, 3, 4, 5, 7, 8, 9, 15, 16, 18, 20, 21, 22, 23, 24,
    ])
      expect(rows[2][index].startsWith("'")).toBe(false);
    expect(rows[2][10]).toBe("");
    expect(rows[1].slice(11)).toEqual(Array(14).fill(""));
  });
  it.each([
    "opaque-position",
    "gh1.bad.syntax",
    "gh1.a:b",
    "gh1.",
    "=private-secret",
    "gh1.a\nsecret",
  ])(
    "rejects unsafe or non-issued continuation syntax %s rather than altering it",
    (cursor) => {
      const value = page();
      value.history.nextCursor = cursor;
      unavailable(value);
      expect(value.history.nextCursor).toBe(cursor);
    },
  );
  it.each([
    "\n",
    "\r",
    "\t",
    "\u0000",
    "\u007f",
    "\u009f",
    " leading",
    "trailing ",
    "\uFEFF=1",
  ])("retains strict title/control rejection for %s", (title) => {
    const value = page();
    value.history.items[0].titleSnapshot = title;
    expect(giftPurchaseHistoryPageResponseSchema.safeParse(value).success).toBe(
      false,
    );
    unavailable(value);
  });
  it.each([
    "request-scope",
    "item-site",
    "item-mode",
    "private-field",
    "private-item",
    "certainty",
    "duplicate",
    "index26",
  ])("rejects %s before projecting any sensitive data", (kind) => {
    const value = page();
    if (kind === "item-site") value.history.items[0].siteId = "foreign-site";
    if (kind === "item-mode") value.history.items[0].mode = "live";
    if (kind === "private-field")
      Object.assign(value.history, {
        providerCredential: "private-secret-bank-pix",
      });
    if (kind === "private-item")
      Object.assign(value.history.items[0], {
        operatorUserId: "private-secret-actor",
      });
    if (kind === "certainty")
      Object.assign(value.history, { currentKnowledge: "KNOWN" });
    if (kind === "duplicate") value.history.items.push(value.history.items[0]);
    if (kind === "index26")
      value.history.items = Array.from({ length: 26 }, (_, index) => ({
        ...value.history.items[0],
        orderId: `order-${String(25 - index).padStart(2, "0")}`,
        quoteId: `quote-${index}`,
      }));
    unavailable(value, kind === "request-scope" ? "foreign-site" : "site-one");
  });
  it("demonstrates a schema-valid maximum-size page within the independent escaped UTF-8 bound", () => {
    const value = page();
    const siteId = "s".repeat(128);
    value.history.scope.siteId = siteId;
    const original = value.history.items[0];
    value.history.items = Array.from({ length: 25 }, (_, index) => ({
      ...original,
      siteId,
      orderId: `o${String(24 - index).padStart(3, "0")}${"x".repeat(124)}`,
      quoteId: `q${String(index).padStart(3, "0")}${"x".repeat(124)}`,
      giftId: "g".repeat(128),
      policyVersion: "p".repeat(128),
      titleSnapshot: "界".repeat(120),
      destinationVersion: 2147483647,
      quoted: {
        nominalCents: 2147483645,
        commissionCents: 1,
        processingCents: 1,
        totalCents: 2147483647,
      },
    }));
    value.history.nextCursor = `gh1.${"x".repeat(252)}`;
    giftPurchaseHistoryPageResponseSchema.parse(value);
    const csv = encodeGiftPurchaseHistoryCsv(value, siteId);
    expect(decode(csv)).toHaveLength(27);
    expect(new TextEncoder().encode(csv).byteLength).toBeLessThan(64 * 1024);
    // A valid shape is structurally below 256 KiB; overflow is not reachable here.
    const conservativeEscapedBytes =
      26 * (5 * 128 + 120 * 4 + 2 * 18 + 8 + 256 + 200 + 76) + 1024;
    expect(conservativeEscapedBytes).toBeLessThan(256 * 1024);
    expect(new TextEncoder().encode(csv).byteLength).toBeLessThanOrEqual(
      conservativeEscapedBytes,
    );
  });
});
