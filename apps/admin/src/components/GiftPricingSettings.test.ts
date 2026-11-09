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
  return [...section.querySelectorAll("dt")].find(
    (row) => row.textContent === label,
  )?.nextElementSibling?.textContent;
}

async function selectInstallments(container: Element, count: number) {
  const select = container.querySelector("select");
  if (!select) throw new Error("Missing installment selector");
  await act(async () => {
    select.value = String(count);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
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

  it("shows only quoted plans and updates the surcharge, total, exact installments and unchanged recipient net", async () => {
    const request = vi.fn(async () => installmentResponse());
    const view = mount(request);
    try {
      await view.render(10000);
      expect(
        [...view.container.querySelectorAll("option")].map(
          (option) => option.value,
        ),
      ).toEqual(["1", "2", "12"]);
      await selectInstallments(view.container, 12);
      const card = view.container.querySelector('section[aria-label="Cartão"]');
      expect(rowValue(card, "Taxas à vista")).toBe("R$ 5,65");
      expect(rowValue(card, "Acréscimo do parcelamento")).toBe("R$ 1,10");
      expect(rowValue(card, "Total do convidado")).toBe("R$ 106,75");
      expect(rowValue(card, "Primeiras 11 parcelas")).toBe("R$ 8,89 cada");
      expect(rowValue(card, "Última parcela")).toBe("R$ 8,96");
      expect(rowValue(card, "Líquido do casal")).toBe("R$ 100,00");
      expect(
        rowValue(
          view.container.querySelector('section[aria-label="Pix"]'),
          "Total do convidado",
        ),
      ).toBe("R$ 105,65");
      await selectInstallments(view.container, 2);
      expect(rowValue(card, "Parcelas")).toBe("2x de R$ 53,10");
      expect(rowValue(card, "Última parcela")).toBeUndefined();
      expect(rowValue(card, "Total do convidado")).toBe("R$ 106,20");
      await selectInstallments(view.container, 1);
      expect(rowValue(card, "Total do convidado")).toBe("R$ 105,65");
      expect(rowValue(card, "Acréscimo do parcelamento")).toBeUndefined();
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      await view.close();
    }
  });

  it("drops an unavailable selection when a smaller gift only permits an upfront payment", async () => {
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
      await selectInstallments(view.container, 12);
      await view.render(500);
      expect(view.container.querySelector("select")).toBeNull();
      expect(view.container.textContent).not.toContain("R$ 106,75");
      expect(view.container.textContent).toContain(
        "Somente cartão à vista disponível nesta simulação.",
      );
    } finally {
      await view.close();
    }
  });

  it.each([
    [10621, 56, [5310, 5311], "Acréscimo do parcelamento", "R$ 0,56"],
    [10200, -365, [5100, 5100], "Desconto no parcelamento", "R$ 3,65"],
  ] as const)(
    "presents the exact two-payment adjustment for a total of %i cents",
    async (total, surcharge, amounts, label, adjustment) => {
      const preview = installmentResponse();
      preview.methods[1].installmentOptions = [
        preview.methods[1].installmentOptions[0],
        {
          installmentCount: 2,
          totalCents: total,
          installmentSurchargeCents: surcharge,
          installmentCents: [...amounts],
        },
      ];
      const view = mount(async () => preview);
      try {
        await view.render(10000);
        await selectInstallments(view.container, 2);
        const card = view.container.querySelector(
          'section[aria-label="Cartão"]',
        );
        expect(rowValue(card, label)).toBe(adjustment);
        expect(rowValue(card, "Líquido do casal")).toBe("R$ 100,00");
        if (surcharge > 0) {
          expect(rowValue(card, "Primeira parcela")).toBe("R$ 53,10");
          expect(rowValue(card, "Última parcela")).toBe("R$ 53,11");
          expect(rowValue(card, "Total do convidado")).toBe("R$ 106,21");
        } else {
          expect(rowValue(card, "Parcelas")).toBe("2x de R$ 51,00");
          expect(rowValue(card, "Total do convidado")).toBe("R$ 102,00");
        }
      } finally {
        await view.close();
      }
    },
  );

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
