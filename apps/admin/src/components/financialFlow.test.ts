import type { FinancialOverview } from "@entrelacos/contracts";
import { describe, expect, it } from "vitest";
import { financialFlow, purchaseNetCents } from "./financialFlow";

const overview: FinancialOverview = {
  siteId: "site-1",
  currency: "BRL",
  nominalReceivedCents: 1000,
  netReceivedCents: 881,
  processingCents: 99,
  commissionCents: 20,
  awaitingReleaseCents: 52600,
  availableCents: 581,
  pendingCommitmentsCents: 0,
  withdrawnCents: 300,
  refundedCents: 0,
  synchronizedAt: "2026-11-04T09:31:00.000Z",
  availability: "CURRENT",
  mode: "sandbox",
};

describe("financial flow", () => {
  it("splits the tracked money into the overview segments", () => {
    const flow = financialFlow(overview);
    expect(flow.segments.map(({ id, cents }) => [id, cents])).toEqual([
      ["awaiting", 52600],
      ["fees", 119],
      ["withdrawn", 300],
      ["available", 581],
    ]);
    expect(flow.totalCents).toBe(53600);
    expect(flow.releasedGrossCents).toBe(1000);
    expect(flow.netForCoupleCents).toBe(53481);
  });
  it("adds pending withdrawals and refunds only when they exist", () => {
    const flow = financialFlow({
      ...overview,
      pendingCommitmentsCents: 200,
      refundedCents: 150,
    });
    expect(flow.segments.map(({ id }) => id)).toEqual([
      "awaiting",
      "fees",
      "withdrawn",
      "pending",
      "refunded",
      "available",
    ]);
  });
  it("never turns an unknown balance into zero", () => {
    for (const availability of ["STALE", "UNKNOWN"] as const) {
      const flow = financialFlow({
        ...overview,
        availability,
        availableCents: null,
        synchronizedAt: null,
      });
      expect(flow.availableCents).toBeNull();
      expect(flow.segments.map(({ id }) => id)).not.toContain("available");
      expect(flow.totalCents).toBe(53019);
    }
  });
});

describe("purchase net amount", () => {
  it("subtracts the quoted fees from what the guest paid", () => {
    expect(
      purchaseNetCents({
        nominalCents: 1000,
        commissionCents: 20,
        processingCents: 99,
        totalCents: 1119,
      }),
    ).toBe(1000);
    expect(
      purchaseNetCents({
        nominalCents: 55000,
        commissionCents: 1052,
        processingCents: 1348,
        feeAllocation: "RECIPIENT_DEDUCTED",
        totalCents: 55000,
      }),
    ).toBe(52600);
  });
});

it("keeps funded platform adjustments out of what guests paid", () => {
  const flow = financialFlow({
    ...overview,
    netReceivedCents: 1000,
    processingCents: 150,
    platformAdjustmentOwedCents: 25,
    platformAdjustmentFundedCents: 50,
  });
  expect(flow.releasedGrossCents).toBe(1120);
  expect(flow.netForCoupleCents).toBe(53625);
});

it("accounts for the installment surcharge in combined quoted fees", () => {
  expect(
    purchaseNetCents({
      nominalCents: 10000,
      commissionCents: 200,
      processingCents: 400,
      installmentSurchargeCents: 100,
      feeAllocation: "BUYER_GROSS_UP",
      totalCents: 10600,
    }),
  ).toBe(10000);
});
