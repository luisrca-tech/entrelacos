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

function installmentResponse() {
  const preview = response(10000, 365);
  const card = {
    ...preview.methods[1],
    installmentOptions: [
      {
        installmentCount: 1,
        totalCents: 10565,
        installmentSurchargeCents: 0,
        installmentCents: [10565],
      },
      {
        installmentCount: 2,
        totalCents: 10620,
        installmentSurchargeCents: 55,
        installmentCents: [5310, 5310],
      },
      {
        installmentCount: 12,
        totalCents: 10675,
        installmentSurchargeCents: 110,
        installmentCents: [...Array<number>(11).fill(889), 896],
      },
    ],
  };
  return { ...preview, methods: [preview.methods[0], card] as const };
}

function rowValue(section: Element | null, label: string) {
  if (!section) throw new Error("Missing pricing section");
  return [...section.querySelectorAll("dt")]
    .find((row) => row.textContent?.startsWith(label))
    ?.nextElementSibling?.textContent?.replace(/\s+/g, " ");
}

// V2 quote for a R$100,00 gift: the guest pays every fee, the couple gets 100%.
function v2Response() {
  const preview = response(10000, 365);
  const option = (installmentCount: number, totalCents: number) => ({
    installmentCount,
    totalCents,
    installmentSurchargeCents: totalCents - 10565,
    installmentCents: [
      ...Array<number>(installmentCount - 1).fill(
        Math.floor(totalCents / installmentCount),
      ),
      totalCents -
        Math.floor(totalCents / installmentCount) * (installmentCount - 1),
    ],
  });
  const card = {
    ...preview.methods[1],
    totalCents: 10565,
    installmentOptions: [option(1, 10565), option(6, 10620), option(12, 10675)],
  };
  return {
    ...preview,
    methods: [{ ...preview.methods[0], totalCents: 10399 }, card] as const,
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
  document.body.append(container);
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
    openSimulation: async () => {
      await act(async () => container.querySelector("button")?.click());
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) throw new Error("Missing pricing dialog");
      return dialog;
    },
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("gift pricing preview", () => {
  it("keeps the simulation in a dialog with a non-submitting trigger and no installment selector", async () => {
    const view = mount(async () => installmentResponse());
    try {
      await view.render(10000);
      expect(view.container.querySelector("select")).toBeNull();
      const trigger = view.container.querySelector("button");
      expect(trigger?.textContent).toBe("Simular taxas e parcelamento");
      expect(trigger?.type).toBe("button");
      const dialog = await view.openSimulation();
      expect(dialog.textContent).toContain(
        "O convidado escolhe a forma de pagamento e o parcelamento na hora de pagar.",
      );
      expect(dialog.querySelector("select")).toBeNull();
      await act(async () =>
        dialog
          .querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')
          ?.click(),
      );
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      await view.close();
    }
  });

  it("retains the server installment options in the parsed preview", () => {
    const preview = installmentResponse();
    expect(parsePricingPreview(preview, "site-a", 10000).methods[1]).toEqual(
      preview.methods[1],
    );
  });

  it.each([
    "allocation",
    "surcharge",
    "duplicate",
    "base",
    "unavailable",
    "pix",
  ])("rejects inconsistent installment evidence: %s", (problem) => {
    const preview = installmentResponse();
    const card = preview.methods[1];
    if (problem === "allocation")
      card.installmentOptions[2].installmentCents[11] = 895;
    if (problem === "surcharge")
      card.installmentOptions[2].installmentSurchargeCents = 109;
    if (problem === "duplicate")
      card.installmentOptions.push(card.installmentOptions[1]);
    if (problem === "base")
      card.installmentOptions[0] = {
        installmentCount: 1,
        totalCents: 10566,
        installmentSurchargeCents: 0,
        installmentCents: [10566],
      };
    if (problem === "unavailable")
      Object.assign(card, {
        available: false,
        totalCents: null,
        processingCents: null,
        recipientNetCents: null,
      });
    if (problem === "pix")
      Object.assign(preview.methods[0], {
        installmentOptions: card.installmentOptions,
      });
    expect(() => parsePricingPreview(preview, "site-a", 10000)).toThrow();
  });

  it("shows what the couple receives, the guest totals and a single fee line", async () => {
    const view = mount(async () => v2Response());
    try {
      await view.render(10000);
      const dialog = await view.openSimulation();
      expect(rowValue(dialog, "Você recebe")).toBe("R$ 100,00 (100%)");
      expect(rowValue(dialog, "Pix")).toBe("R$ 103,99");
      expect(rowValue(dialog, "Cartão à vista")).toBe("R$ 105,65");
      expect(rowValue(dialog, "Cartão em 6x")).toBe("R$ 106,20");
      expect(rowValue(dialog, "Cartão em 12x")).toBe("R$ 106,75");
      expect(rowValue(dialog, "Taxas pagas pelo convidado")).toBe(
        "de R$ 3,99 a R$ 6,75",
      );
      expect(
        dialog.querySelector("dt button")?.getAttribute("aria-label"),
      ).toBe("Inclui a taxa do meio de pagamento e o serviço Entrelaços");
      expect(
        [...dialog.querySelectorAll("dt")].filter((row) =>
          row.textContent?.startsWith("Taxas"),
        ),
      ).toHaveLength(1);
      expect(dialog.textContent).not.toMatch(
        /Líquido do casal|Comissão|antecipa|de uma vez/i,
      );
      expect(dialog.textContent).toContain(
        "normalmente em até 32 dias por parcela",
      );
    } finally {
      await view.close();
    }
  });

  it("lists only the installment plans the server quoted", async () => {
    const view = mount(async () => installmentResponse());
    try {
      await view.render(10000);
      const dialog = await view.openSimulation();
      expect(rowValue(dialog, "Cartão em 6x")).toBeUndefined();
      expect(rowValue(dialog, "Cartão em 12x")).toBe("R$ 106,75");
      expect(rowValue(dialog, "Cartão à vista")).toBe("R$ 105,65");
    } finally {
      await view.close();
    }
  });

  it("drops installment rows when a smaller gift only permits an upfront payment", async () => {
    const smaller = response(500, 65);
    const request = vi
      .fn()
      .mockResolvedValueOnce(installmentResponse())
      .mockResolvedValue({
        ...smaller,
        methods: [
          smaller.methods[0],
          {
            ...smaller.methods[1],
            installmentOptions: [
              {
                installmentCount: 1,
                totalCents: 765,
                installmentSurchargeCents: 0,
                installmentCents: [765],
              },
            ],
          },
        ],
      });
    const view = mount(request);
    try {
      await view.render(10000);
      const dialog = await view.openSimulation();
      expect(rowValue(dialog, "Cartão em 12x")).toBe("R$ 106,75");
      await view.render(500);
      expect(rowValue(dialog, "Cartão em 12x")).toBeUndefined();
      expect(dialog.textContent).toContain(
        "Somente cartão à vista disponível nesta simulação.",
      );
    } finally {
      await view.close();
    }
  });

  it.each([
    [199, "R$ 3,99"],
    [0, "R$ 2,00"],
    [null, "Indisponível"],
  ])(
    "combines fees without treating missing processing as zero: %s",
    async (processing, label) => {
      const request = vi.fn(async () => response(10000, processing));
      const view = mount(request);
      try {
        await view.render(10000);
        const dialog = await view.openSimulation();
        expect(request).toHaveBeenCalledExactlyOnceWith(
          "/v1/sites/site-a/gift-pricing-preview",
          expect.objectContaining({
            method: "POST",
            body: { nominalCents: 10000, feeAllocation: "BUYER_GROSS_UP" },
          }),
        );
        expect(rowValue(dialog, "Taxas pagas pelo convidado")).toBe(label);
        expect(dialog.textContent).not.toMatch(/Comissão|Processamento Asaas/);
        expect(dialog.querySelector("input, form")).toBeNull();
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
      const dialog = await view.openSimulation();
      await view.render(20000);
      await act(async () => resolveOld(response(10000, 199)));
      expect(dialog.textContent).toContain("R$ 202,00");
      expect(dialog.textContent).not.toContain("R$ 103,99");
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
