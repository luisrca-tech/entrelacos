import { describe, expect, it, vi } from "vitest";
import type {
  ReceivingPixDestinationRecord,
  ReceivingPixDestinationSave,
} from "./receivingPixDestinationSetup";
import { createReceivingPixDestinationSetup } from "./receivingPixDestinationSetup";
import type { ReceivingSetupAccountRecord } from "./receivingSetupRepository";

const actor = {
  userId: "holder-one",
  siteId: "site-one",
  sessionId: "session-one",
};
const at = new Date("2026-10-16T22:00:00Z");
function fixture(identity: "MATCH" | "MISMATCH" | "INCOMPLETE" = "MISMATCH") {
  const scope = {
    provider: "ASAAS" as const,
    siteId: actor.siteId,
    accountId: "account-one",
    accountReference: "provider-one",
    recipientReference: "wallet-one",
    operatorUserId: actor.userId,
    environment: "sandbox" as const,
    destinationVersion: 1,
    membershipId: "membership-one",
    holderId: "holder-custody-one",
    consentId: "consent-one",
  };
  const state = {
    scope,
    current: null as ReceivingPixDestinationRecord | null,
  };
  const snapshot = vi.fn(async () => structuredClone(state));
  const save = vi.fn(async (command: ReceivingPixDestinationSave) => {
    if (
      state.current?.configuration?.reviewId === command.configuration.reviewId
    )
      return state.current;
    if (command.scope.destinationVersion !== state.scope.destinationVersion)
      throw new Error("Stale destination");
    state.current = {
      id: "destination-two",
      version: 2,
      configuration: command.configuration,
    };
    state.scope.destinationVersion = 2;
    return state.current;
  });
  const repository = { snapshot, save };
  const clock = { value: at };
  const service = createReceivingPixDestinationSetup({
    repository,
    mode: "sandbox",
    keyring: new Map([["key-one", new Uint8Array(32).fill(17)]]),
    keyId: "key-one",
    now: () => clock.value,
    generateId: () => "review-one",
  });
  const account = {
    accountId: scope.accountId,
    operatorUserId: actor.userId,
    state: "SUCCEEDED",
    result: {
      accountReference: scope.accountReference,
      recipientReference: scope.recipientReference,
    },
  } as unknown as ReceivingSetupAccountRecord;
  const input = { type: "PHONE" as const, key: "47996515839" };
  const review = {
    siteId: actor.siteId,
    mode: "sandbox" as const,
    keyType: "PHONE" as const,
    maskedKey: "***5839",
    ownerName: "External Test Recipient",
    maskedCpfCnpj: "***.123.456-**",
    bankName: "Test Bank",
    identity,
    observedAt: at.toISOString(),
    destinationSaved: false as const,
    withdrawalEnabled: false as const,
  };
  const proof = {
    ...actor,
    proofKind: "PASSWORD_REAUTHENTICATION" as const,
    provenance: "backend" as const,
    verification: "verified" as const,
    authenticatedAt: at,
    expiresAt: new Date(at.getTime() + 300000),
  };
  return {
    service,
    state,
    snapshot,
    save,
    clock,
    account,
    input,
    review,
    proof,
  };
}
describe("reviewed Pix destination configuration", () => {
  it("saves an explicitly accepted third-party recipient as pending without exposing its key", async () => {
    const v = fixture();
    const issued = await v.service.issueReview(
      actor,
      v.account,
      v.input,
      v.review,
    );
    expect(issued.reviewToken).not.toContain(v.input.key);
    expect(issued.expiresAt).toBe(
      new Date(at.getTime() + 300000).toISOString(),
    );
    const saved = await v.service.confirm(
      actor,
      {
        reviewToken: issued.reviewToken,
        confirmRecipient: true,
        acceptThirdParty: true,
      },
      v.proof,
    );
    expect(saved).toMatchObject({
      siteId: actor.siteId,
      version: 2,
      state: "PENDING",
      identity: "MISMATCH",
      withdrawalEnabled: false,
    });
    expect(JSON.stringify(v.save.mock.calls)).not.toContain(v.input.key);
    expect(JSON.stringify(saved)).not.toContain(v.input.key);
    expect(await v.service.read(actor)).toEqual(saved);
  });
  it.each(["MISMATCH", "INCOMPLETE"] as const)(
    "requires an informed acknowledgment for %s but permits it when confirmed",
    async (identity) => {
      const v = fixture(identity);
      const issued = await v.service.issueReview(
        actor,
        v.account,
        v.input,
        v.review,
      );
      await expect(
        v.service.confirm(
          actor,
          { reviewToken: issued.reviewToken, confirmRecipient: true },
          v.proof,
        ),
      ).rejects.toMatchObject({ code: "PIX_RECIPIENT_CONFIRMATION_REQUIRED" });
      expect(v.save).not.toHaveBeenCalled();
    },
  );
  it("accepts a matching recipient without a third-party acknowledgment", async () => {
    const v = fixture("MATCH");
    const issued = await v.service.issueReview(
      actor,
      v.account,
      v.input,
      v.review,
    );
    await expect(
      v.service.confirm(
        actor,
        { reviewToken: issued.reviewToken, confirmRecipient: true },
        v.proof,
      ),
    ).resolves.toMatchObject({ state: "PENDING" });
  });
  it("keeps receipt replay idempotent", async () => {
    const v = fixture();
    const issued = await v.service.issueReview(
      actor,
      v.account,
      v.input,
      v.review,
    );
    const input = {
      reviewToken: issued.reviewToken,
      confirmRecipient: true as const,
      acceptThirdParty: true as const,
    };
    expect(await v.service.confirm(actor, input, v.proof)).toEqual(
      await v.service.confirm(actor, input, v.proof),
    );
    expect(v.state.scope.destinationVersion).toBe(2);
  });
  it.each(["session", "account", "version", "expiry", "tamper"])(
    "rejects a changed %s before persistence",
    async (change) => {
      const v = fixture();
      const issued = await v.service.issueReview(
        actor,
        v.account,
        v.input,
        v.review,
      );
      const selectedActor = { ...actor };
      let token = issued.reviewToken;
      if (change === "session") selectedActor.sessionId = "other-session";
      if (change === "account") v.state.scope.accountId = "other-account";
      if (change === "version") v.state.scope.destinationVersion = 2;
      if (change === "expiry") v.clock.value = new Date(at.getTime() + 300000);
      if (change === "tamper") token = `${token.slice(0, -10)}AAAAAAAAAA`;
      await expect(
        v.service.confirm(
          selectedActor,
          {
            reviewToken: token,
            confirmRecipient: true,
            acceptThirdParty: true,
          },
          v.proof,
        ),
      ).rejects.toThrow();
      expect(v.save).not.toHaveBeenCalled();
    },
  );
  it("requires real recent password or MFA evidence rather than initial session evidence", async () => {
    const v = fixture();
    const issued = await v.service.issueReview(
      actor,
      v.account,
      v.input,
      v.review,
    );
    await expect(
      v.service.confirm(
        actor,
        {
          reviewToken: issued.reviewToken,
          confirmRecipient: true,
          acceptThirdParty: true,
        },
        { ...v.proof, proofKind: "SESSION_AUTHENTICATION" } as never,
      ),
    ).rejects.toMatchObject({ code: "RECENT_AUTH_REQUIRED" });
    expect(v.save).not.toHaveBeenCalled();
  });
});
