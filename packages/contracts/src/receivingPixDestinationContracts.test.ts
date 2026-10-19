import { describe, expect, it } from "vitest";
import {
  receivingPixDestinationConfirmationInputSchema,
  receivingPixDestinationInputSchema,
  receivingPixDestinationReviewSchema,
} from "./receivingPixDestinationContracts";

describe("receiving Pix destination contracts", () => {
  it("requires an opaque reviewed destination and explicit confirmation, never a replacement key or name", () => {
    const body = {
      reviewToken: "opaque-review-token-for-testing",
      confirmRecipient: true,
      acceptThirdParty: true,
      reauthenticationToken: "real-password-proof",
    };
    expect(receivingPixDestinationConfirmationInputSchema.parse(body)).toEqual(
      body,
    );
    for (const extra of [
      { key: "other-key" },
      { ownerName: "Forged Person" },
      { withdrawalEnabled: true },
      { confirmRecipient: false },
    ])
      expect(
        receivingPixDestinationConfirmationInputSchema.safeParse({
          ...body,
          ...extra,
        }).success,
      ).toBe(false);
  });
  it.each([
    { type: "CPF", key: "12345678909" },
    { type: "CNPJ", key: "12345678000195" },
    { type: "PHONE", key: "47996515839" },
    { type: "EMAIL", key: "holder@example.test" },
    { type: "EVP", key: "123e4567-e89b-42d3-a456-426614174000" },
  ])("accepts a bounded key of the declared type: $type", (value) => {
    expect(receivingPixDestinationInputSchema.parse(value)).toEqual(value);
  });
  it.each([
    { type: "CPF", key: "123" },
    { type: "PHONE", key: "+5547996515839" },
    { type: "EMAIL", key: "not-an-email" },
    { type: "EVP", key: "not-a-key" },
    { type: "CPF", key: "12345678909", ownerName: "Forged name" },
  ])("rejects invalid or client-supplied ownership data", (value) => {
    expect(receivingPixDestinationInputSchema.safeParse(value).success).toBe(
      false,
    );
  });
  it("cannot describe an enabled withdrawal or a persisted destination", () => {
    expect(
      receivingPixDestinationReviewSchema.safeParse({ withdrawalEnabled: true })
        .success,
    ).toBe(false);
  });
});
