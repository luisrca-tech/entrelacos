import { giftCentsSchema, giftQuoteSchema } from "@entrelacos/contracts";
import { describe, expect, it } from "vitest";
import {
  GiftMoneyServiceError,
  type GiftProcessingPolicy,
  parseBrlCents,
  quoteGiftAmounts,
  serializeBrlCents,
} from "./giftMoney";

// Arithmetic fixtures are explicit local policies, not approved Asaas fees.
function policy(
  overrides: Partial<GiftProcessingPolicy> = {},
): GiftProcessingPolicy {
  return {
    version: "test-policy-v1",
    method: "PIX",
    commissionBasisPoints: 200,
    processingBasisPoints: 0,
    processingFixedCents: 0,
    rounding: "CEILING",
    ...overrides,
  };
}

describe("gift amount quoting", () => {
  it.each(["PIX", "CREDIT_CARD"] as const)(
    "deducts fees from the recipient for %s without increasing buyer total",
    (method) => {
      expect(
        quoteGiftAmounts({
          nominalCents: 1000,
          method,
          policy: policy({
            method,
            feeAllocation: "RECIPIENT_DEDUCTED",
            processingFixedCents: 99,
          }),
        }),
      ).toEqual({
        nominalCents: 1000,
        commissionCents: 20,
        processingCents: 99,
        totalCents: 1000,
        policyVersion: "test-policy-v1",
        feeAllocation: "RECIPIENT_DEDUCTED",
      });
    },
  );

  it("calculates recipient processing on the configured price and rejects nonpositive net", () => {
    expect(
      quoteGiftAmounts({
        nominalCents: 1000,
        method: "PIX",
        policy: policy({
          feeAllocation: "RECIPIENT_DEDUCTED",
          processingBasisPoints: 250,
          processingFixedCents: 39,
        }),
      }),
    ).toMatchObject({
      totalCents: 1000,
      processingCents: 64,
      commissionCents: 20,
    });
    for (const processingFixedCents of [980, 981]) {
      expect(() =>
        quoteGiftAmounts({
          nominalCents: 1000,
          method: "PIX",
          policy: policy({
            feeAllocation: "RECIPIENT_DEDUCTED",
            processingFixedCents,
          }),
        }),
      ).toThrow(expect.objectContaining({ code: "POLICY_UNAVAILABLE" }));
    }
  });

  it("adds the 2% nominal commission independently from processing", () => {
    expect(
      quoteGiftAmounts({
        nominalCents: 10_000,
        method: "PIX",
        policy: policy(),
      }),
    ).toEqual({
      nominalCents: 10_000,
      commissionCents: 200,
      processingCents: 0,
      totalCents: 10_200,
      policyVersion: "test-policy-v1",
    });
  });

  it.each([
    [1, 0],
    [24, 0],
    [25, 1],
    [74, 1],
    [75, 2],
    [125, 3],
  ])(
    "rounds 2%% of nominal %i cents to %i cents",
    (nominalCents, commissionCents) => {
      expect(
        quoteGiftAmounts({ nominalCents, method: "PIX", policy: policy() }),
      ).toMatchObject({
        nominalCents,
        commissionCents,
        processingCents: 0,
        totalCents: nominalCents + commissionCents,
      });
    },
  );

  it("fails closed without an injected processing policy", () => {
    expect(() =>
      quoteGiftAmounts({ nominalCents: 10_000, method: "PIX", policy: null }),
    ).toThrow(GiftMoneyServiceError);
    expect(() =>
      quoteGiftAmounts({ nominalCents: 10_000, method: "PIX", policy: null }),
    ).toThrow(
      expect.objectContaining({ status: 409, code: "POLICY_UNAVAILABLE" }),
    );
  });

  it("grosses up the guest total because processing is charged on the final total", () => {
    const result = quoteGiftAmounts({
      nominalCents: 10_000,
      method: "PIX",
      policy: policy({ processingBasisPoints: 250, processingFixedCents: 39 }),
    });
    expect(result).toEqual({
      nominalCents: 10_000,
      commissionCents: 200,
      processingCents: 302,
      totalCents: 10_502,
      policyVersion: "test-policy-v1",
    });
    // Neither 2% of the final total (210) nor of post-processing net (204).
    expect(result.commissionCents).not.toBe(210);
    expect(result.commissionCents).not.toBe(204);
    expect(
      result.totalCents - result.processingCents - result.commissionCents,
    ).toBe(10_000);
  });

  it("snapshots different policies for Pix and one-payment card", () => {
    const cardPolicy = policy({
      version: "test-card-policy-v2",
      method: "CREDIT_CARD",
      processingBasisPoints: 499,
      processingFixedCents: 49,
    });
    const result = quoteGiftAmounts({
      nominalCents: 10_000,
      method: "CREDIT_CARD",
      policy: cardPolicy,
    });
    expect(result).toEqual({
      nominalCents: 10_000,
      commissionCents: 200,
      processingCents: 588,
      totalCents: 10_788,
      policyVersion: "test-card-policy-v2",
    });
    expect(
      giftQuoteSchema.safeParse({
        ...result,
        id: "quote-one",
        giftId: "gift-one",
        siteId: "site-one",
        title: "Symbolic gift",
        method: "CREDIT_CARD",
        currency: "BRL",
        commissionBasisPoints: 200,
        expiresAt: "2026-10-12T14:00:00.000Z",
        mode: "sandbox",
      }).success,
    ).toBe(true);
  });

  it.each([0, 1, 250, 2_500, 4_999, 9_999])(
    "conserves cents and chooses the smallest total at %i processing basis points",
    (processingBasisPoints) => {
      for (const nominalCents of [1, 24, 25, 99, 125, 10_101]) {
        for (const processingFixedCents of [0, 1, 39]) {
          const injected = policy({
            processingBasisPoints,
            processingFixedCents,
          });
          const result = quoteGiftAmounts({
            nominalCents,
            method: "PIX",
            policy: injected,
          });
          const feeFor = (total: bigint) =>
            BigInt(processingFixedCents) +
            (total * BigInt(processingBasisPoints) + 9_999n) / 10_000n;
          const total = BigInt(result.totalCents);
          const commission = BigInt(result.commissionCents);
          expect(BigInt(result.processingCents)).toBe(feeFor(total));
          expect(total - feeFor(total) - commission).toBe(BigInt(nominalCents));
          expect(total - 1n - feeFor(total - 1n) - commission).toBeLessThan(
            BigInt(nominalCents),
          );
          for (const cents of [
            result.nominalCents,
            result.commissionCents,
            result.processingCents,
            result.totalCents,
          ]) {
            expect(giftCentsSchema.safeParse(cents).success).toBe(true);
          }
        }
      }
    },
  );

  it("matches an independent exhaustive search over small cent amounts", () => {
    for (let nominalCents = 1; nominalCents <= 100; nominalCents += 1) {
      const result = quoteGiftAmounts({
        nominalCents,
        method: "PIX",
        policy: policy({
          processingBasisPoints: 3_500,
          processingFixedCents: 9,
        }),
      });
      const nominal = BigInt(nominalCents);
      const commission = BigInt(result.commissionCents);
      let firstCoveringTotal = 1n;
      for (; firstCoveringTotal <= 1_000n; firstCoveringTotal += 1n) {
        const fee = 9n + (firstCoveringTotal * 3_500n + 9_999n) / 10_000n;
        if (firstCoveringTotal - fee - commission >= nominal) break;
      }
      expect(BigInt(result.totalCents)).toBe(firstCoveringTotal);
    }
  });

  it("handles the 9999-basis-point boundary without an iterative search", () => {
    expect(
      quoteGiftAmounts({
        nominalCents: 1,
        method: "PIX",
        policy: policy({ processingBasisPoints: 9_999 }),
      }),
    ).toMatchObject({
      nominalCents: 1,
      commissionCents: 0,
      processingCents: 9_999,
      totalCents: 10_000,
    });
  });

  it("allows a conserved total exactly at the C1 cents limit", () => {
    expect(
      quoteGiftAmounts({
        nominalCents: 2_105_376_124,
        method: "PIX",
        policy: policy({ processingFixedCents: 1 }),
      }),
    ).toEqual({
      nominalCents: 2_105_376_124,
      commissionCents: 42_107_522,
      processingCents: 1,
      totalCents: 2_147_483_647,
      policyVersion: "test-policy-v1",
    });
  });

  it.each([
    0,
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2_147_483_648,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid nominal cents %s", (nominalCents) => {
    expect(() =>
      quoteGiftAmounts({ nominalCents, method: "PIX", policy: policy() }),
    ).toThrow(GiftMoneyServiceError);
    expect(() =>
      quoteGiftAmounts({ nominalCents, method: "PIX", policy: policy() }),
    ).toThrow(expect.objectContaining({ status: 400, code: "QUOTE_INVALID" }));
  });

  it.each([
    { version: "" },
    { version: "unapproved policy" },
    { commissionBasisPoints: 199 as never },
    { rounding: "FLOOR" as never },
    { processingBasisPoints: -1 },
    { processingBasisPoints: 0.5 },
    { processingBasisPoints: 10_000 },
    { processingBasisPoints: Number.NaN },
    { processingBasisPoints: Number.POSITIVE_INFINITY },
    { processingFixedCents: -1 },
    { processingFixedCents: 0.5 },
    { processingFixedCents: 2_147_483_648 },
  ])("rejects invalid or unsupported injected policy %o", (override) => {
    expect(() =>
      quoteGiftAmounts({
        nominalCents: 100,
        method: "PIX",
        policy: policy(override),
      }),
    ).toThrow(GiftMoneyServiceError);
    expect(() =>
      quoteGiftAmounts({
        nominalCents: 100,
        method: "PIX",
        policy: policy(override),
      }),
    ).toThrow(
      expect.objectContaining({ status: 409, code: "POLICY_UNAVAILABLE" }),
    );
  });

  it("rejects policy/method mismatch rather than quoting another method", () => {
    expect(() =>
      quoteGiftAmounts({
        nominalCents: 100,
        method: "PIX",
        policy: policy({ method: "CREDIT_CARD" }),
      }),
    ).toThrow(
      expect.objectContaining({ status: 409, code: "POLICY_UNAVAILABLE" }),
    );
  });

  it("rejects unsupported payment methods", () => {
    expect(() =>
      quoteGiftAmounts({
        nominalCents: 100,
        method: "BOLETO" as never,
        policy: policy({ method: "BOLETO" as never }),
      }),
    ).toThrow(expect.objectContaining({ status: 400, code: "QUOTE_INVALID" }));
  });

  it.each([
    [2_147_483_647, 0, 0],
    [214_749, 9_999, 0],
    [1, 0, 2_147_483_647],
  ])(
    "fails closed when %i nominal cents have no bounded solution",
    (nominalCents, processingBasisPoints, processingFixedCents) => {
      expect(() =>
        quoteGiftAmounts({
          nominalCents,
          method: "PIX",
          policy: policy({ processingBasisPoints, processingFixedCents }),
        }),
      ).toThrow(
        expect.objectContaining({ status: 409, code: "POLICY_UNAVAILABLE" }),
      );
    },
  );
});

describe("BRL decimal boundaries", () => {
  it.each([
    [0, "0.00"],
    [1, "0.01"],
    [10, "0.10"],
    [99, "0.99"],
    [100, "1.00"],
    [101, "1.01"],
    [10_000, "100.00"],
    [2_147_483_647, "21474836.47"],
  ] as const)("serializes %i cents as %s", (cents, decimal) => {
    expect(serializeBrlCents(cents)).toBe(decimal);
    expect(parseBrlCents(decimal)).toBe(cents);
  });

  it.each([
    ["0", 0],
    ["0.0", 0],
    ["0.00", 0],
    ["1", 100],
    ["100", 10_000],
    ["100.0", 10_000],
    ["100.00", 10_000],
    ["0.1", 10],
    ["0.01", 1],
    ["21474836.4", 2_147_483_640],
  ] as const)("parses %s as %i integer cents", (decimal, cents) => {
    expect(parseBrlCents(decimal)).toBe(cents);
  });

  it.each([
    "",
    " ",
    "100 ",
    " 100",
    "+100",
    "-0",
    "-0.01",
    "-100",
    "1e2",
    "Infinity",
    "NaN",
    "1,00",
    "1.000",
    "1.",
    "0.",
    ".01",
    "00",
    "01.00",
    "100.00\n",
    "100.00\r",
    "1_000",
    "1/2",
    "0x10",
    "21474836.48",
    "99999999999999.99",
    "１２",
    "١",
  ])("rejects noncanonical or out-of-range BRL input %j", (value) => {
    expect(() => parseBrlCents(value)).toThrow(GiftMoneyServiceError);
    expect(() => parseBrlCents(value)).toThrow(
      expect.objectContaining({ status: 400, code: "QUOTE_INVALID" }),
    );
  });

  it.each([undefined, null, 100, true, {}])(
    "does not coerce nonstring values %j into decimal money",
    (value) => {
      expect(() => parseBrlCents(value as never)).toThrow(
        GiftMoneyServiceError,
      );
    },
  );

  it.each([
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2_147_483_648,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid cents %s during serialization", (cents) => {
    expect(() => serializeBrlCents(cents)).toThrow(GiftMoneyServiceError);
    expect(() => serializeBrlCents(cents)).toThrow(
      expect.objectContaining({ status: 400, code: "QUOTE_INVALID" }),
    );
  });

  it("round-trips integer cents without binary decimal arithmetic", () => {
    for (const cents of [
      0, 1, 10, 99, 100, 101, 10_000, 1_001_003, 2_147_483_647,
    ]) {
      expect(parseBrlCents(serializeBrlCents(cents))).toBe(cents);
    }
  });
});

describe("observed fee estimate boundary", () => {
  it("allows estimates only when processing is deducted from recipient proceeds", () => {
    const policy = {
      version: "observed-one",
      method: "PIX" as const,
      commissionBasisPoints: 200 as const,
      processingBasisPoints: 0,
      processingFixedCents: 99,
      rounding: "CEILING" as const,
      feeBasis: "OBSERVED_ESTIMATE" as const,
    };
    expect(() =>
      quoteGiftAmounts({ nominalCents: 1000, method: "PIX", policy }),
    ).toThrow();
    expect(
      quoteGiftAmounts({
        nominalCents: 1000,
        method: "PIX",
        policy: { ...policy, feeAllocation: "RECIPIENT_DEDUCTED" },
      }),
    ).toMatchObject({
      totalCents: 1000,
      commissionCents: 20,
      processingCents: 99,
    });
  });
});
