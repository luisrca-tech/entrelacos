// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import {
  GiftPricingPreview,
  GiftPricingSettings,
  parsePricingPreview,
  useGiftPricingPreview,
} from "./GiftPricingSettings";

function response(nominalCents: number, processingCents: number | null) {
  return {
    siteId: "site-a",
    feeAllocation: "BUYER_GROSS_UP",
    guaranteed: false,
    methods: ["PIX", "CREDIT_CARD"].map((method) => ({
      method,
      available: processingCents !== null,
      nominalCents,
      commissionCents: 200,
      processingCents,
      totalCents:
        processingCents === null ? null : nominalCents + 200 + processingCents,
      recipientNetCents: processingCents === null ? null : nominalCents,
    })),
  };
}

function Preview({ nominalCents }: { nominalCents: number }) {
  const estimate = useGiftPricingPreview(nominalCents);
  return createElement(GiftPricingPreview, { nominalCents, estimate });
}

function mount(
  request: React.ComponentProps<typeof GiftPricingSettings>["request"],
  enabled = true,
) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  const root = createRoot(container);
  const isCurrent = () => true;
  return {
    container,
    render: (nominalCents: number) =>
      act(async () =>
        root.render(
          createElement(GiftPricingSettings, {
            enabled,
            siteId: "site-a",
            request,
            isCurrent,
            // biome-ignore lint/correctness/noChildrenProp: Required children contract.
            children: createElement(Preview, { nominalCents }),
          }),
        ),
      ),
    close: () => act(async () => root.unmount()),
  };
}

describe("gift pricing preview", () => {
  it.each([
    [199, "R$ 3,99"],
    [0, "R$ 2,00"],
    [null, "Indisponível"],
  ])(
    "combines fees without treating missing processing as zero: %s",
    async (processing, label) => {
      const request = vi.fn(async () => response(10000, processing));
      const view = mount(request);
      try {
        await view.render(10000);
        expect(request).toHaveBeenCalledExactlyOnceWith(
          "/v1/sites/site-a/gift-pricing-preview",
          expect.objectContaining({
            method: "POST",
            body: { nominalCents: 10000, feeAllocation: "BUYER_GROSS_UP" },
          }),
        );
        const rows = [...view.container.querySelectorAll("dt")].filter(
          (node) => node.textContent === "Taxas",
        );
        expect(rows.map((row) => row.nextElementSibling?.textContent)).toEqual([
          label,
          label,
        ]);
        expect(view.container.textContent).not.toMatch(
          /Comissão|Processamento Asaas/,
        );
        expect(view.container.querySelector("button, input")).toBeNull();
      } finally {
        await view.close();
      }
    },
  );

  it("ignores an old estimate that resolves after the amount changes", async () => {
    let resolveOld!: (value: unknown) => void;
    const old = new Promise((resolve) => {
      resolveOld = resolve;
    });
    const request = vi
      .fn()
      .mockReturnValueOnce(old)
      .mockResolvedValue(response(20000, 0));
    const view = mount(request);
    try {
      await view.render(10000);
      await view.render(20000);
      await act(async () => resolveOld(response(10000, 199)));
      expect(view.container.textContent).toContain("R$ 202,00");
      expect(view.container.textContent).not.toContain("R$ 103,99");
    } finally {
      await view.close();
    }
  });

  it("rejects mismatched previews and invented unavailable totals", () => {
    const preview = response(10000, null);
    expect(parsePricingPreview(preview, "site-a", 10000)).toEqual(preview);
    expect(() => parsePricingPreview(preview, "site-b", 10000)).toThrow();
    expect(() => parsePricingPreview(preview, "site-a", 20000)).toThrow();
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
      ),
    ).toThrow();
  });

  it("hides the preview and sends no request without pricing permission", async () => {
    const request = vi.fn(async () => response(10000, 0));
    const view = mount(request, false);
    try {
      await view.render(10000);
      expect(request).not.toHaveBeenCalled();
      expect(view.container.textContent).toBe("");
    } finally {
      await view.close();
    }
  });
});
