import { describe, expect, it } from "vitest";
import {
  block3EndpointPaths,
  familySessionResponseSchema,
  guestAccessPinResponseSchema,
  guestChallengeStartResponseSchema,
  guestChallengeVerifyInputSchema,
  guestGroupCreateInputSchema,
  guestGroupRecordSchema,
  guestGroupUpdateInputSchema,
  guestLookupInputSchema,
} from "./index";

describe("Block 3 public contracts", () => {
  it("does not expose a simulation guest-grant endpoint", () => {
    expect(Object.values(block3EndpointPaths)).not.toContain(
      "POST /v1/owner/sites/:siteId/demo/guest-grant",
    );
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
      isIndividual: false,
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

  it("marks individual invitations as one-member groups that cannot change kind", () => {
    expect(
      guestGroupCreateInputSchema.parse({
        name: "Ana Silva",
        isIndividual: true,
        isForeign: false,
        phone: "(11) 99999-9999",
        members: [{ fullName: "Ana Silva", isRepresentative: true }],
      }),
    ).toMatchObject({ isIndividual: true, name: "Ana Silva" });
    expect(() =>
      guestGroupCreateInputSchema.parse({
        name: "Família Silva",
        isIndividual: true,
        isForeign: false,
        phone: "(11) 99999-9999",
        members: [
          { fullName: "Ana Silva", isRepresentative: true },
          { fullName: "João Silva", isRepresentative: false },
        ],
      }),
    ).toThrow();
    expect(() =>
      guestGroupUpdateInputSchema.parse({ isIndividual: true }),
    ).toThrow();
    expect(() =>
      guestGroupRecordSchema.parse({
        id: "group-1",
        siteId: "site-demo",
        name: "Ana Silva",
        isForeign: false,
        phone: "+5511999999999",
        members: [
          { id: "member-1", fullName: "Ana Silva", isRepresentative: true },
        ],
        createdAt: "2026-09-11T12:00:00.000Z",
        updatedAt: "2026-09-11T12:00:00.000Z",
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
      }),
    ).toEqual({
      challengeId,
      expiresAt: "2026-09-11T12:10:00.000Z",
    });
    expect(() =>
      guestChallengeStartResponseSchema.parse({
        challengeId,
        expiresAt: "2026-09-11T12:10:00.000Z",
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
