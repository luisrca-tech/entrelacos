import { describe, expect, it } from "vitest";
import {
  demoGuestGrantResponseSchema,
  familySessionResponseSchema,
  guestAccessPinResponseSchema,
  guestChallengeStartResponseSchema,
  guestChallengeVerifyInputSchema,
  guestGroupCreateInputSchema,
  guestLookupInputSchema,
} from "./index";

describe("Block 3 public contracts", () => {
  it("keeps demo grants opaque and short-lived", () => {
    const response = demoGuestGrantResponseSchema.parse({
      grant: `${"a".repeat(120)}.${"b".repeat(43)}`,
      expiresAt: "2026-09-11T12:05:00.000Z",
    });
    expect(response.grant).not.toContain("+");
    expect(() =>
      demoGuestGrantResponseSchema.parse({
        grant: `${"a".repeat(120)}.${"b".repeat(42)}!`,
        expiresAt: "2026-09-11T12:05:00.000Z",
      }),
    ).toThrow();
  });

  it("requires a named group with exactly one representative", () => {
    expect(
      guestGroupCreateInputSchema.parse({
        name: "Família Silva",
        isForeign: false,
        phone: "(11) 99999-9999",
        members: [
          { fullName: "Ana Silva", isRepresentative: true },
          { fullName: "João Silva", isRepresentative: false },
        ],
      }),
    ).toEqual({
      name: "Família Silva",
      isForeign: false,
      phone: "+5511999999999",
      members: [
        { fullName: "Ana Silva", isRepresentative: true },
        { fullName: "João Silva", isRepresentative: false },
      ],
    });

    expect(() =>
      guestGroupCreateInputSchema.parse({
        name: "Família Silva",
        isForeign: false,
        phone: null,
        members: [{ fullName: "Ana Silva", isRepresentative: false }],
      }),
    ).toThrow();

    expect(
      guestGroupCreateInputSchema.parse({
        name: "Família estrangeira",
        isForeign: true,
        phone: null,
        members: [{ fullName: "Alex Smith", isRepresentative: true }],
      }),
    ).toMatchObject({ isForeign: true, phone: null });
    expect(() =>
      guestGroupCreateInputSchema.parse({
        name: "Família Silva",
        isForeign: true,
        phone: "+5511999999999",
        members: [{ fullName: "Ana Silva", isRepresentative: true }],
      }),
    ).toThrow();
    expect(() =>
      guestGroupCreateInputSchema.parse({
        name: "Família Silva",
        isForeign: false,
        phone: "+14155552671",
        members: [{ fullName: "Ana Silva", isRepresentative: true }],
      }),
    ).toThrow();
    expect(() =>
      guestGroupCreateInputSchema.parse({
        name: "Família Silva",
        isForeign: false,
        phone: "+5511999999999",
        members: [
          { fullName: "Ana Silva", isRepresentative: true },
          { fullName: "João Silva", isRepresentative: true },
        ],
      }),
    ).toThrow();
  });

  it("keeps public lookup and challenge payloads opaque and strict", () => {
    const challengeId = "a".repeat(43);
    expect(
      guestLookupInputSchema.parse({
        fullName: " Ana   Silva ",
        phone: "+5511999999999",
      }),
    ).toEqual({
      fullName: " Ana   Silva ",
      phone: "+5511999999999",
    });
    expect(() =>
      guestLookupInputSchema.parse({
        fullName: "Ana Silva",
        phone: "+5511999999999",
        groupId: "group-secret",
      }),
    ).toThrow();
    expect(
      guestChallengeStartResponseSchema.parse({
        challengeId,
        expiresAt: "2026-09-11T12:10:00.000Z",
        resendAvailableAt: "2026-09-11T12:10:00.000Z",
        sendStatus: "MANUAL",
        deliveryMode: "MANUAL_PIN",
      }),
    ).toMatchObject({ sendStatus: "MANUAL", deliveryMode: "MANUAL_PIN" });

    expect(
      guestChallengeStartResponseSchema.parse({
        challengeId,
        expiresAt: "2026-09-11T12:10:00.000Z",
        resendAvailableAt: "2026-09-11T12:01:00.000Z",
        sendStatus: "UNKNOWN",
        deliveryMode: "SIMULATED",
        simulationCode: "123456",
      }),
    ).toMatchObject({
      challengeId,
      sendStatus: "UNKNOWN",
      deliveryMode: "SIMULATED",
      simulationCode: "123456",
    });
    expect(() =>
      guestChallengeStartResponseSchema.parse({
        challengeId,
        expiresAt: "2026-09-11T12:10:00.000Z",
        resendAvailableAt: "2026-09-11T12:01:00.000Z",
        sendStatus: "PROVIDER_ACCEPTED",
        deliveryMode: "REAL_SMS",
        simulationCode: "123456",
      }),
    ).toThrow();
    expect(
      guestChallengeVerifyInputSchema.parse({ challengeId, code: "123456" }),
    ).toEqual({ challengeId, code: "123456" });
    expect(() =>
      guestChallengeVerifyInputSchema.parse({
        challengeId,
        code: "12345",
        token: "secret",
      }),
    ).toThrow();
  });

  it("keeps manually shared group PINs six-digit and explicit", () => {
    expect(guestAccessPinResponseSchema.parse({ accessPin: "004218" })).toEqual(
      {
        accessPin: "004218",
      },
    );
    expect(() =>
      guestAccessPinResponseSchema.parse({ accessPin: "4218" }),
    ).toThrow();
  });

  it("returns only family identity and absolute expiry after verification", () => {
    expect(
      familySessionResponseSchema.parse({
        sessionToken: "b".repeat(43),
        siteId: "site-demo",
        groupId: "group-1",
        members: [
          { id: "member-1", fullName: "Ana Silva", isRepresentative: true },
        ],
        expiresAt: "2026-09-18T12:00:00.000Z",
      }),
    ).toMatchObject({ siteId: "site-demo", groupId: "group-1" });
    expect(() =>
      familySessionResponseSchema.parse({
        sessionToken: "b".repeat(43),
        siteId: "site-demo",
        groupId: "group-1",
        members: [
          { id: "member-1", fullName: "Ana Silva", isRepresentative: true },
        ],
        expiresAt: "2026-09-18T12:00:00.000Z",
        tokenHash: "secret",
      }),
    ).toThrow();
  });
});
