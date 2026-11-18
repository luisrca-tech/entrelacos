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
  destinationSaved: false,
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
      ["account", "locked"],
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
      "current",
      "available",
      "done",
    ]);
    expect(track.next?.id).toBe("activation");
    expect(track.completed).toBe(3);
  });

  it("moves the next step forward while Pagar.me reviews the account", () => {
    const track = deriveReceivingTrack({
      ...base,
      provider: { ...provider, accountState: "UNDER_REVIEW" },
    });
    expect(track.steps[2].status).toBe("review");
    expect(track.next?.id).toBe("account");
    expect(track.steps[3].status).toBe("current");
    expect(track.steps[4].status).toBe("done");
  });

  it("keeps activation current while identity verification is pending", () => {
    for (const accountState of ["UNVERIFIED", "ONBOARDING"] as const) {
      const track = deriveReceivingTrack({
        ...base,
        provider: { ...provider, accountState },
      });
      expect(track.steps[2].status).toBe("current");
      expect(track.next?.id).toBe("activation");
    }
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
    expect(track.next?.id).toBe("account");
  });

  it("asks for attention when Pagar.me blocks or suspends the recipient", () => {
    for (const accountState of ["BLOCKED", "SUSPENDED"] as const) {
      const adjusted = { ...provider, accountState };
      const track = deriveReceivingTrack({ ...base, provider: adjusted });
      expect(track.steps[2].status).toBe("attention");
      expect(track.next?.id).toBe("activation");
    }
  });

  it("counts saved destination and the fixed fees as done", () => {
    const track = deriveReceivingTrack({
      ...base,
      provider: { ...provider, accountState: "UNDER_REVIEW" },
      destinationSaved: true,
    });
    expect(track.completed).toBe(4);
    expect(track.next?.id).toBe("activation");
    expect(track.next?.status).toBe("review");
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
      destinationSaved: true,
    });
    expect(track.completed).toBe(5);
    expect(track.next).toBeNull();
  });

  it("uses the couple's language for every status", () => {
    expect(receivingStepStatusLabel).toEqual({
      done: "Concluída",
      current: "Agora",
      review: "Em análise pela Pagar.me",
      attention: "Precisa de ajuste",
      available: "Pode fazer já",
      locked: "Depois",
    });
  });
});
