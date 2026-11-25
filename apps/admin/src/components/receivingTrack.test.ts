import { describe, expect, it } from "vitest";
import {
  deriveReceivingTrack,
  type ReceivingTrackInput,
  receivingStepStatusLabel,
} from "./receivingTrack";

const provider: NonNullable<ReceivingTrackInput["provider"]> = {
  recipientStatus: "registration",
  accountState: "ONBOARDING",
  receivingEnabled: false,
};
const base: ReceivingTrackInput = {
  holder: true,
  accountState: "CREATED",
  provider,
  ready: false,
};

const statuses = (input: ReceivingTrackInput) =>
  deriveReceivingTrack(input).steps.map(({ id, status }) => [id, status]);

describe("receiving guided track", () => {
  it("starts with the holder step and locks everything after it", () => {
    const track = deriveReceivingTrack({
      ...base,
      holder: false,
      accountState: "NOT_CREATED",
      provider: null,
    });
    expect(track.steps.map(({ status }) => status)).toEqual([
      "current",
      "locked",
      "locked",
      "locked",
    ]);
    expect(track.next?.id).toBe("holder");
    expect(track.completed).toBe(0);
  });

  it("asks for the account data once the holder is chosen", () => {
    expect(
      statuses({ ...base, accountState: "NOT_CREATED", provider: null }),
    ).toEqual([
      ["holder", "done"],
      ["details", "current"],
      ["activation", "locked"],
      ["fees", "locked"],
    ]);
  });

  it("flags an uncertain account creation instead of retrying it", () => {
    const track = deriveReceivingTrack({
      ...base,
      accountState: "UNKNOWN",
      provider: null,
    });
    expect(track.steps[1].status).toBe("attention");
    expect(track.next?.id).toBe("details");
  });

  it("applies the fixed gift fee rule as soon as the Pagar.me recipient exists", () => {
    const track = deriveReceivingTrack(base);
    expect(track.steps.map(({ status }) => status)).toEqual([
      "done",
      "done",
      "review",
      "done",
    ]);
    expect(track.next?.id).toBe("activation");
    expect(track.completed).toBe(3);
  });

  it("shows the account step in review while Pagar.me activates it", () => {
    const track = deriveReceivingTrack({
      ...base,
      provider: { ...provider, accountState: "UNDER_REVIEW" },
    });
    expect(track.steps[2].status).toBe("review");
    expect(track.next?.id).toBe("activation");
    expect(track.next?.status).toBe("review");
    expect(track.steps[3].status).toBe("done");
  });

  it("keeps activation in review while Pagar.me has not activated the recipient", () => {
    for (const accountState of ["UNVERIFIED", "ONBOARDING"] as const) {
      const track = deriveReceivingTrack({
        ...base,
        provider: { ...provider, accountState },
      });
      expect(track.steps[2].status).toBe("review");
      expect(track.next?.id).toBe("activation");
    }
    const pending = deriveReceivingTrack({
      ...base,
      provider: {
        recipientStatus: "affiliation",
        accountState: "UNDER_REVIEW",
        receivingEnabled: false,
        kycStatus: "pending",
        kycStatusReason: "in_analysis",
      },
    });
    expect(pending.steps[2].status).toBe("review");
  });

  it("asks for attention, not an action, when Pagar.me unexpectedly asks for documents", () => {
    const track = deriveReceivingTrack({
      ...base,
      provider: {
        recipientStatus: "affiliation",
        accountState: "UNDER_REVIEW",
        receivingEnabled: false,
        kycStatus: "partially_denied",
        kycStatusReason: "additional_documents_required",
      },
    });
    expect(track.steps[2].status).toBe("attention");
    expect(track.next?.id).toBe("activation");
  });

  it("marks activation done once Pagar.me approves the recipient", () => {
    const track = deriveReceivingTrack({
      ...base,
      provider: {
        recipientStatus: "active",
        accountState: "APPROVED",
        receivingEnabled: true,
      },
    });
    expect(track.steps[2].status).toBe("done");
    expect(track.next).toBeNull();
    expect(track.completed).toBe(4);
  });

  it("asks for attention when Pagar.me refuses the identity check", () => {
    const track = deriveReceivingTrack({
      ...base,
      provider: {
        recipientStatus: "affiliation",
        accountState: "UNDER_REVIEW",
        receivingEnabled: false,
        kycStatus: "denied",
        kycStatusReason: "fully_denied",
      },
    });
    expect(track.steps[2].status).toBe("attention");
  });

  it("asks for attention when Pagar.me blocks or suspends the recipient", () => {
    for (const accountState of ["BLOCKED", "SUSPENDED"] as const) {
      const adjusted = { ...provider, accountState };
      const track = deriveReceivingTrack({ ...base, provider: adjusted });
      expect(track.steps[2].status).toBe("attention");
      expect(track.next?.id).toBe("activation");
    }
  });

  it("names the third step after the account status, not an identity check", () => {
    const step = deriveReceivingTrack(base).steps[2];
    expect(step.title).toBe("Status da conta");
    expect(step.short).toBe("Status da conta");
    expect(step.summary).not.toMatch(/selfie|documento|link/i);
  });

  it("finishes when receiving is ready", () => {
    const track = deriveReceivingTrack({
      ...base,
      provider: {
        ...provider,
        accountState: "APPROVED",
        receivingEnabled: true,
      },
      ready: true,
    });
    expect(track.completed).toBe(4);
    expect(track.next).toBeNull();
  });

  it("uses the couple's language for every status", () => {
    expect(receivingStepStatusLabel).toEqual({
      done: "Concluída",
      current: "Agora",
      review: "Em ativação na Pagar.me",
      attention: "Precisa de ajuste",
      available: "Pode fazer já",
      locked: "Depois",
    });
  });
});
