// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import {
  GiftPricingPreview,
  GiftPricingSettings,
  parsePricingPreview,
  parsePricingSettings,
  useGiftFeeAllocation,
} from "./GiftPricingSettings";

const settings = {
  siteId: "site-a",
  feeAllocation: "RECIPIENT_DEDUCTED",
  revision: 0,
  buyerGrossUpAvailable: false,
  blockedReason: "Aguardando validação",
};
describe("gift pricing settings", () => {
  it("ignores a cancelled pending simulation that resolves after a new selection", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div"),
      root = createRoot(container);
    let resolveOld!: (value: unknown) => void;
    let previews = 0;
    const response = (processingCents: number) => ({
      siteId: "site-a",
      feeAllocation: "BUYER_GROSS_UP",
      guaranteed: false,
      methods: ["PIX", "CREDIT_CARD"].map((method) => ({
        method,
        available: true,
        nominalCents: 10000,
        commissionCents: 200,
        processingCents,
        totalCents: 10200 + processingCents,
        recipientNetCents: 10000,
      })),
    });
    const request = vi.fn(
      async (_path: string, options?: { method?: string }) => {
        if (options?.method !== "POST") return { settings };
        if (previews++ === 0)
          return new Promise<unknown>((resolve) => {
            resolveOld = resolve;
          });
        return response(299);
      },
    );
    try {
      await act(async () =>
        root.render(
          createElement(GiftPricingSettings, {
            siteId: "site-a",
            request,
            isCurrent: () => true,
            gifts: [{ nominalCents: 10000 }],
            // biome-ignore lint/correctness/noChildrenProp: Required children contract.
            children: null,
          }),
        ),
      );
      const select = () =>
        (
          container.querySelectorAll(
            'input[type="radio"]',
          )[1] as HTMLInputElement
        ).click();
      await act(async () => select());
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Cancelar")
          ?.click(),
      );
      await act(async () => select());
      expect(
        container.querySelector('[aria-label="Confirmar impacto das taxas"]')
          ?.textContent,
      ).toContain("104,99");
      await act(async () => resolveOld(response(199)));
      const impact = container.querySelector(
        '[aria-label="Confirmar impacto das taxas"]',
      );
      expect(impact?.textContent).toContain("104,99");
      expect(impact?.textContent).not.toContain("103,99");
      expect(
        request.mock.calls.some(([, options]) => options?.method === "PATCH"),
      ).toBe(false);
    } finally {
      await act(async () => root.unmount());
    }
  });
  it("shows pending method totals before PATCH and preserves saved allocation on cancellation", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div");
    const root = createRoot(container);
    const request = vi.fn(
      async (
        _path: string,
        options?: {
          method?: string;
          body?: unknown;
        },
      ) => {
        if (options?.method !== "POST") return { settings };
        const body = options.body as { feeAllocation: string };
        return {
          siteId: "site-a",
          feeAllocation: body.feeAllocation,
          guaranteed: false,
          methods: ["PIX", "CREDIT_CARD"].map((method, index) => ({
            method,
            available: true,
            nominalCents: 10000,
            commissionCents: 200,
            processingCents: index ? 500 : 199,
            totalCents:
              body.feeAllocation === "BUYER_GROSS_UP"
                ? index
                  ? 10700
                  : 10399
                : 10000,
            recipientNetCents:
              body.feeAllocation === "BUYER_GROSS_UP"
                ? 10000
                : index
                  ? 9300
                  : 9601,
          })),
        };
      },
    );
    function Meaning() {
      return createElement("output", null, useGiftFeeAllocation());
    }
    try {
      await act(async () =>
        root.render(
          createElement(GiftPricingSettings, {
            siteId: "site-a",
            request,
            isCurrent: () => true,
            gifts: [{ nominalCents: 10000 }],
            // biome-ignore lint/correctness/noChildrenProp: Required children contract.
            children: createElement(Meaning),
          }),
        ),
      );
      await act(async () =>
        (
          container.querySelectorAll(
            'input[type="radio"]',
          )[1] as HTMLInputElement
        ).click(),
      );
      const impact = container.querySelector(
        '[aria-label="Confirmar impacto das taxas"]',
      );
      expect(impact?.textContent).toContain("103,99");
      expect(impact?.textContent).toContain("107,00");
      expect(impact?.textContent).toContain("sem garantia");
      expect(
        request.mock.calls.some(([, options]) => options?.method === "PATCH"),
      ).toBe(false);
      expect(container.querySelector("output")?.textContent).toBe(
        "RECIPIENT_DEDUCTED",
      );
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Cancelar")
          ?.click(),
      );
      expect(
        container.querySelector('[aria-label="Confirmar impacto das taxas"]'),
      ).toBeNull();
      expect(container.querySelector("output")?.textContent).toBe(
        "RECIPIENT_DEDUCTED",
      );
    } finally {
      await act(async () => root.unmount());
    }
  });
  it("does not guess who pays when authoritative settings cannot be loaded", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div");
    const root = createRoot(container);
    function Meaning() {
      return createElement(
        "output",
        null,
        useGiftFeeAllocation() ?? "UNAVAILABLE",
      );
    }
    try {
      await act(async () =>
        root.render(
          createElement(GiftPricingSettings, {
            siteId: "site-a",
            request: async () => {
              throw new Error("Unavailable");
            },
            isCurrent: () => true,
            gifts: [],
            // biome-ignore lint/correctness/noChildrenProp: Required children contract.
            children: createElement(Meaning),
          }),
        ),
      );
      expect(container.querySelector("output")?.textContent).toBe(
        "UNAVAILABLE",
      );
    } finally {
      await act(async () => root.unmount());
    }
  });
  it("rejects a different site and unlocked purchases", () => {
    expect(parsePricingSettings({ settings }, "site-a")).toEqual(settings);
    expect(() => parsePricingSettings({ settings }, "site-b")).toThrow();
    expect(() =>
      parsePricingSettings(
        { settings: { ...settings, buyerGrossUpAvailable: true } },
        "site-a",
      ),
    ).toThrow();
  });
  it("rejects mismatched previews and invented unavailable totals", () => {
    const preview = {
      siteId: "site-a",
      feeAllocation: "RECIPIENT_DEDUCTED",
      guaranteed: false,
      methods: ["PIX", "CREDIT_CARD"].map((method) => ({
        method,
        available: false,
        nominalCents: 10000,
        commissionCents: 200,
        processingCents: null,
        totalCents: null,
        recipientNetCents: null,
      })),
    };
    expect(
      parsePricingPreview(preview, "site-a", 10000, "RECIPIENT_DEDUCTED"),
    ).toEqual(preview);
    expect(() =>
      parsePricingPreview(preview, "site-a", 20000, "RECIPIENT_DEDUCTED"),
    ).toThrow();
    expect(() =>
      parsePricingPreview(
        {
          ...preview,
          methods: [
            { ...preview.methods[0], totalCents: 10000 },
            preview.methods[1],
          ],
        },
        "site-a",
        10000,
        "RECIPIENT_DEDUCTED",
      ),
    ).toThrow();
  });
  it("hides financial settings and sends no request without pricing permission", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div");
    const root = createRoot(container);
    const request = vi.fn(async () => ({ settings }));
    try {
      await act(async () =>
        root.render(
          createElement(GiftPricingSettings, {
            enabled: false,
            siteId: "site-a",
            request,
            isCurrent: () => true,
            gifts: [],
            // biome-ignore lint/correctness/noChildrenProp: Required children contract.
            children: createElement("p", null, "Catalog"),
          }),
        ),
      );
      expect(request).not.toHaveBeenCalled();
      expect(container.textContent).toBe("Catalog");
    } finally {
      await act(async () => root.unmount());
    }
  });
  it("requires impact confirmation before saving buyer preference and fails closed on errors", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const request = vi.fn(
      async (_path: string, options?: { method?: string }) => {
        if (options?.method === "PATCH")
          return {
            settings: {
              ...settings,
              feeAllocation: "BUYER_GROSS_UP",
              revision: 1,
            },
          };
        if (options?.method === "POST") throw new Error("Missing tariff");
        return { settings };
      },
    );
    try {
      await act(async () =>
        root.render(
          createElement(GiftPricingSettings, {
            siteId: "site-a",
            request,
            isCurrent: () => true,
            gifts: [{ nominalCents: 10000 }],
            // biome-ignore lint/correctness/noChildrenProp: createElement props keep the required children contract.
            children: createElement(GiftPricingPreview, {
              nominalCents: 10000,
            }),
          }),
        ),
      );
      expect(container.textContent).toContain("Indisponível");
      await act(async () =>
        (
          container.querySelectorAll(
            'input[type="radio"]',
          )[1] as HTMLInputElement
        ).click(),
      );
      expect(container.textContent).toContain("R$ 100,00");
      expect(
        request.mock.calls.filter(([, options]) => options?.method === "PATCH"),
      ).toHaveLength(0);
      const confirm = [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Confirmar e pausar"),
      );
      await act(async () => confirm?.click());
      expect(
        request.mock.calls.find(
          ([, options]) => options?.method === "PATCH",
        )?.[1],
      ).toMatchObject({
        body: { feeAllocation: "BUYER_GROSS_UP", revision: 0 },
      });
      expect(container.textContent).toContain("Novos pagamentos pausados");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
