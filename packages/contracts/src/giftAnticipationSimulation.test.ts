import { describe, expect, it } from "vitest";
import { simulateGiftAnticipation } from "./giftAnticipationSimulation";

const singleInstallment = {
  nominalCents: 10_000,
  commissionBasisPoints: 200,
  processingBasisPoints: 299,
  fixedCents: 49,
  monthlyAnticipationBasisPoints: 115,
  installmentDays: [30],
};

const threeInstallments = {
  ...singleInstallment,
  processingBasisPoints: 349,
  monthlyAnticipationBasisPoints: 160,
  installmentDays: [30, 60, 90],
};

describe("gift anticipation planning simulation", () => {
  it("rounds each fee up to cents and preserves the nominal gift", () => {
    expect(simulateGiftAnticipation(singleInstallment)).toEqual({
      planningOnly: true,
      totalCents: 10_688,
      surchargeCents: 688,
      commissionCents: 200,
      processingFeeCents: 369,
      anticipationFeeCents: 119,
      installmentCents: [10_688],
      netCoupleCents: 10_000,
    });
  });

  it("allocates all cents and combines processing, anticipation and commission", () => {
    const simulation = simulateGiftAnticipation({
      ...threeInstallments,
      nominalCents: 12_345,
    });
    expect(simulation.commissionCents).toBe(247);
    expect(simulation.netCoupleCents).toBe(12_345);
    expect(
      simulation.installmentCents.reduce((sum, cents) => sum + cents),
    ).toBe(simulation.totalCents);
    expect(simulation.surchargeCents).toBe(
      simulation.processingFeeCents +
        simulation.anticipationFeeCents +
        simulation.commissionCents,
    );
  });

  it("increases the anticipation fee and total for a longer receivable tenor", () => {
    const shorter = simulateGiftAnticipation(threeInstallments);
    const longer = simulateGiftAnticipation({
      ...threeInstallments,
      installmentDays: [30, 60, 120],
    });
    expect(longer.anticipationFeeCents).toBeGreaterThan(
      shorter.anticipationFeeCents,
    );
    expect(longer.totalCents).toBeGreaterThan(shorter.totalCents);
  });

  it("supports zero anticipation and amounts up to safe integer cents", () => {
    expect(
      simulateGiftAnticipation({
        nominalCents: Number.MAX_SAFE_INTEGER,
        commissionBasisPoints: 0,
        processingBasisPoints: 0,
        fixedCents: 0,
        monthlyAnticipationBasisPoints: 0,
        installmentDays: [0, 30, 60],
      }),
    ).toMatchObject({
      totalCents: Number.MAX_SAFE_INTEGER,
      netCoupleCents: Number.MAX_SAFE_INTEGER,
      surchargeCents: 0,
      anticipationFeeCents: 0,
      installmentCents: [
        3_002_399_751_580_330, 3_002_399_751_580_330, 3_002_399_751_580_331,
      ],
    });
  });

  it("requires at least one cent in each simulated installment", () => {
    const input = {
      nominalCents: 1,
      commissionBasisPoints: 0,
      processingBasisPoints: 0,
      fixedCents: 0,
      monthlyAnticipationBasisPoints: 0,
      installmentDays: [30, 60],
    };
    expect(() => simulateGiftAnticipation(input)).toThrow(RangeError);
    expect(simulateGiftAnticipation({ ...input, fixedCents: 1 })).toMatchObject(
      {
        installmentCents: [1, 1],
        netCoupleCents: 1,
      },
    );
  });

  it.each([
    { nominalCents: 0 },
    { nominalCents: 1.5 },
    { nominalCents: Number.MAX_SAFE_INTEGER + 1 },
    { nominalCents: Number.MAX_SAFE_INTEGER },
    { fixedCents: -1 },
    { commissionBasisPoints: -1 },
    { processingBasisPoints: 10_000 },
    { monthlyAnticipationBasisPoints: 10_000 },
    { installmentDays: [] },
    { installmentDays: [-30] },
    { installmentDays: [30, 60.5] },
    { installmentDays: [30, Number.MAX_SAFE_INTEGER] },
    { installmentDays: Array.from({ length: 13 }, () => 30) },
    { installmentDays: [0, 300], monthlyAnticipationBasisPoints: 1_000 },
  ])("rejects invalid or unrepresentable simulation input %o", (overrides) => {
    expect(() =>
      simulateGiftAnticipation({ ...singleInstallment, ...overrides }),
    ).toThrow(RangeError);
  });
});
