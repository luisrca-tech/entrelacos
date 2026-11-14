import { describe, expect, it, vi } from "vitest";
import { createAsaasGiftAdjustmentPort } from "./giftPaymentAdjustmentWorker";

const command = {
  externalReference: "gift-adjustment-fixture",
  walletId: "couple_wallet",
  amountCents: 3,
};

function createPort(...responses: Record<string, unknown>[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses)
    fetch.mockResolvedValueOnce(Response.json(response));
  return {
    fetch,
    port: createAsaasGiftAdjustmentPort({
      environment: "sandbox",
      platformApiKey: "$aact_hmlg_fixture",
      platformWalletId: "platform_wallet",
      fetch,
      now: () => new Date("2026-11-06T19:00:00Z"),
    }),
  };
}

const transfer = {
  id: "transfer_one",
  object: "transfer",
  type: "ASAAS_ACCOUNT",
  operationType: "INTERNAL",
  externalReference: command.externalReference,
  walletId: command.walletId,
  value: 0.03,
  netValue: 0.03,
  status: "DONE",
  effectiveDate: "2026-11-06",
};

describe("Asaas gift fee compensation", () => {
  it("checks the configured platform wallet and emits exact internal transfer cents", async () => {
    const { port, fetch } = createPort(
      { data: [{ id: "platform_wallet" }] },
      { balance: 0.03 },
      { data: [], hasMore: false },
      transfer,
    );
    expect(await port.canFund(command.amountCents)).toBe(true);
    await expect(port.dispatch(command)).resolves.toEqual({
      reference: "transfer_one",
      funded: true,
    });
    expect(fetch.mock.calls[3]?.[0]).toBe(
      "https://api-sandbox.asaas.com/v3/transfers/",
    );
    expect(JSON.parse(String(fetch.mock.calls[3]?.[1]?.body))).toEqual({
      walletId: command.walletId,
      externalReference: command.externalReference,
      value: 0.03,
    });
  });

  it.each([
    { walletId: "other" },
    { value: 0.04 },
    { netValue: 0.02 },
    { transferFee: 0.01 },
    { effectiveDate: "2026-11-07" },
    { effectiveDate: "2026-11-06 16:00:01" },
  ])("rejects contradictory settlement proof %j", async (changes) => {
    const { port } = createPort({ ...transfer, ...changes });
    await expect(port.dispatch(command)).rejects.toThrow();
  });

  it("reconciles an already bound provider transfer without a second POST", async () => {
    const { port, fetch } = createPort({ ...transfer, walletId: undefined });
    await expect(port.observe(command, "transfer_one")).resolves.toEqual({
      reference: "transfer_one",
      funded: true,
    });
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET");
  });

  it("retains an ambiguous dispatch without destination evidence and never sends a second POST", async () => {
    const { port, fetch } = createPort({
      hasMore: false,
      data: [{ ...transfer, walletId: undefined }],
    });
    await expect(
      port.recover(command, new Date("2026-11-06T19:00:00Z")),
    ).rejects.toThrow();
    expect(fetch.mock.calls).toHaveLength(1);
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET");
  });
});

it("recovers a missing dispatch response using exact recipient-side credit evidence", async () => {
  const { port, fetch } = createPort({
    hasMore: false,
    data: [{ ...transfer, walletId: undefined }],
  });
  const confirmRecipientCredit = vi.fn().mockResolvedValue(true);
  await expect(
    port.recover(
      command,
      new Date("2026-11-06T19:00:00Z"),
      confirmRecipientCredit,
    ),
  ).resolves.toEqual({ reference: "transfer_one", funded: true });
  expect(confirmRecipientCredit).toHaveBeenCalledWith(
    "transfer_one",
    "2026-11-06",
  );
  expect(
    fetch.mock.calls.every(([, options]) => options?.method === "GET"),
  ).toBe(true);
});

it("requires transfer read permission before consuming the dispatch opportunity", async () => {
  const { port, fetch } = createPort(
    { data: [{ id: "platform_wallet" }] },
    { balance: 0.03 },
  );
  fetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
  await expect(port.canFund(command.amountCents)).rejects.toThrow();
  expect(fetch.mock.calls).toHaveLength(3);
  expect(
    fetch.mock.calls.every(([, options]) => options?.method === "GET"),
  ).toBe(true);
});

it("labels a V2 split-divergence top-up transfer with its reason", async () => {
  const topUp = {
    ...command,
    externalReference: "gift-topup-fixture",
    description: "SPLIT_DIVERGENCE_TOPUP",
  };
  const { port, fetch } = createPort({
    ...transfer,
    externalReference: topUp.externalReference,
    description: topUp.description,
  });
  await expect(port.dispatch(topUp)).resolves.toEqual({
    reference: "transfer_one",
    funded: true,
  });
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
    walletId: command.walletId,
    externalReference: topUp.externalReference,
    value: 0.03,
    description: "SPLIT_DIVERGENCE_TOPUP",
  });
});
