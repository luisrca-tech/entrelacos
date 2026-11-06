import { describe, expect, it } from "vitest";
import {
  deriveReceivingTrack,
  type ReceivingTrackInput,
  receivingStepStatusLabel,
} from "./receivingTrack";

const provider: NonNullable<ReceivingTrackInput["provider"]> = {
  commercialInfo: "APPROVED",
  bankAccountInfo: "PENDING",
  documentation: "PENDING",
  general: "PENDING",
  commercialInfoExpired: false,
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

  it("applies the fixed gift fee rule as soon as the Asaas account exists", () => {
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

  it("moves the next step forward while Asaas reviews the account", () => {
    const track = deriveReceivingTrack({
      ...base,
      provider: {
        ...provider,
        documentation: "AWAITING_APPROVAL",
        general: "AWAITING_APPROVAL",
      },
    });
    expect(track.steps[2].status).toBe("review");
    expect(track.next?.id).toBe("account");
    expect(track.steps[3].status).toBe("current");
    expect(track.steps[4].status).toBe("done");
  });

  it("asks for a fix when Asaas rejects data or it expires", () => {
    for (const adjusted of [
      { ...provider, documentation: "REJECTED" as const },
      { ...provider, commercialInfoExpired: true },
    ]) {
      const track = deriveReceivingTrack({ ...base, provider: adjusted });
      expect(track.steps[2].status).toBe("attention");
      expect(track.next?.id).toBe("activation");
    }
  });

  it("counts saved destination and the fixed fees as done", () => {
    const track = deriveReceivingTrack({
      ...base,
      provider: { ...provider, general: "AWAITING_APPROVAL" },
      destinationSaved: true,
    });
    expect(track.completed).toBe(4);
    expect(track.next?.id).toBe("activation");
    expect(track.next?.status).toBe("review");
  });

  it("finishes when receiving is ready", () => {
    const track = deriveReceivingTrack({
      ...base,
      provider: { ...provider, general: "APPROVED" },
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
      review: "Em análise pelo Asaas",
      attention: "Precisa de ajuste",
      available: "Pode fazer já",
      locked: "Depois",
    });
  });
});
