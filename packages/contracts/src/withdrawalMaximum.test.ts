import { describe, expect, it } from "vitest";
import {
  withdrawalIntentSchema,
  withdrawalPreviewSchema,
} from "./internalGifts";

const intent = {
  id: "withdrawal-1",
  siteId: "site-1",
  amountCents: 1000,
  feeCents: 200,
  netCents: 800,
  feeSemantics: "MAXIMUM",
  currency: "BRL",
  destinationVersion: 2,
  state: "COMPLETED",
  mode: "sandbox",
  createdAt: "2026-10-19T10:00:00.000Z",
  updatedAt: "2026-10-19T10:01:00.000Z",
};
const settlement = {
  totalDebitCents: 800,
  feeCents: 0,
  netCents: 800,
  releasedCents: 200,
};
describe("maximum withdrawal budget with actual settlement", () => {
  it("preserves the approved budget and exposes actual conserved debit and released reserve", () => {
    expect(
      withdrawalIntentSchema.parse({ ...intent, settlement }),
    ).toMatchObject({ amountCents: 1000, feeCents: 200, settlement });
  });
  it.each([
    { ...settlement, feeCents: -1 },
    { ...settlement, feeCents: 201, totalDebitCents: 1001, releasedCents: 0 },
    { ...settlement, totalDebitCents: 801 },
    { ...settlement, releasedCents: 199 },
    { ...settlement, netCents: 799 },
  ])("rejects a contradictory actual settlement %j", (changed) => {
    expect(
      withdrawalIntentSchema.safeParse({ ...intent, settlement: changed })
        .success,
    ).toBe(false);
  });
  it("never adds a maximum settlement to a pending or legacy exact-fee intent", () => {
    expect(
      withdrawalIntentSchema.safeParse({
        ...intent,
        state: "PROCESSING",
        settlement,
      }).success,
    ).toBe(false);
    expect(
      withdrawalIntentSchema.safeParse({
        ...intent,
        feeSemantics: undefined,
        settlement,
      }).success,
    ).toBe(false);
  });
  it("shows the reviewed masked Pix destination and beneficiary with maximum fee terms", () => {
    const preview = {
      siteId: "site-1",
      requestId: "request-1",
      mode: "sandbox",
      currency: "BRL",
      amountCents: 1000,
      feeCents: 200,
      netCents: 800,
      feeSemantics: "MAXIMUM",
      destinationVersion: 2,
      maskedDestination: "Pix EMAIL: c***@p***",
      payoutRecipientName: "Sandbox Recipient",
      operatorDisplayName: "Original Holder",
      policyVersion: "asaas-pix-max-v1-200",
      issuedAt: "2026-10-19T10:00:00.000Z",
      expiresAt: "2026-10-19T10:01:00.000Z",
    };
    expect(withdrawalPreviewSchema.safeParse(preview).success).toBe(true);
    expect(
      withdrawalPreviewSchema.safeParse({
        ...preview,
        maskedDestination: "Pix EMAIL: unmasked@example.test",
      }).success,
    ).toBe(false);
  });
});
