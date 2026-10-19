import { describe, expect, it } from "vitest";
import {
  createWithdrawalPayoutBinding,
  readWithdrawalPayoutBinding,
  sameWithdrawalPayout,
} from "./withdrawalPayout";

function fixture() {
  const scope = {
    siteId: "site-1",
    accountId: "account-1",
    accountReference: "acct-1",
    operatorUserId: "holder-1",
    environment: "sandbox" as const,
    holderId: "holder-record-1",
    holderConsentId: "holder-consent-1",
  };
  const configuration = {
    version: 1,
    reviewId: "review-1",
    key: {
      version: 1,
      keyId: "key-1",
      nonce: "nonce",
      ciphertext: "ciphertext",
      tag: "tag",
    },
    review: {
      siteId: "site-1",
      mode: "sandbox",
      keyType: "EMAIL",
      maskedKey: "c***@p***",
      ownerName: "Sandbox Recipient",
      maskedCpfCnpj: "***.123.456-**",
      bankName: "Sandbox Bank",
      identity: "MISMATCH",
      observedAt: "2026-10-19T10:00:00.000Z",
      destinationSaved: false,
      withdrawalEnabled: false,
    },
    actor: { siteId: "site-1", userId: "holder-1", sessionId: "session-1" },
    authenticatedAt: "2026-10-19T09:59:00.000Z",
    proofKind: "PASSWORD_REAUTHENTICATION",
    confirmRecipient: true,
    acceptThirdParty: true,
  };
  const destination = { id: "payout-1", version: 2, configuration };
  return {
    scope,
    configuration,
    destination,
    now: new Date("2026-10-19T10:00:01.000Z"),
  };
}
describe("immutable external payout consent binding", () => {
  it("freezes reviewed destination and holder acknowledgement without plaintext keys", () => {
    const f = fixture();
    const bound = createWithdrawalPayoutBinding(
      f.scope,
      f.destination as never,
      f.now,
    );
    expect(bound).toMatchObject({
      destinationId: "payout-1",
      destinationVersion: 2,
      reviewId: "review-1",
      holderId: "holder-record-1",
      holderConsentId: "holder-consent-1",
      acceptThirdParty: true,
      maskedKey: "c***@p***",
      ownerName: "Sandbox Recipient",
      keyType: "EMAIL",
    });
    expect(bound.configurationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(bound).not.toHaveProperty("key");
    expect(readWithdrawalPayoutBinding(bound)).toEqual(bound);
  });
  it("does not substitute another current key/configuration under the same version", () => {
    const f = fixture();
    const bound = createWithdrawalPayoutBinding(
      f.scope,
      f.destination as never,
      f.now,
    );
    f.configuration.key.ciphertext = "different";
    expect(
      sameWithdrawalPayout(
        bound,
        createWithdrawalPayoutBinding(f.scope, f.destination as never, f.now),
      ),
    ).toBe(false);
  });
  it("requires explicit third-party acknowledgement for mismatched recipients", () => {
    const f = fixture();
    f.configuration.acceptThirdParty = false;
    expect(() =>
      createWithdrawalPayoutBinding(f.scope, f.destination as never, f.now),
    ).toThrow();
  });
  it.each(["siteId", "userId"])(
    "rejects configuration from another actor %s",
    (key) => {
      const f = fixture();
      (f.configuration.actor as Record<string, unknown>)[key] = "another";
      expect(() =>
        createWithdrawalPayoutBinding(f.scope, f.destination as never, f.now),
      ).toThrow();
    },
  );
  it("rejects a future review", () => {
    const f = fixture();
    f.configuration.review.observedAt = "2026-10-20T00:00:00.000Z";
    expect(() =>
      createWithdrawalPayoutBinding(f.scope, f.destination as never, f.now),
    ).toThrow();
  });
});
