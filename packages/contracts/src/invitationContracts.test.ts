import { describe, expect, it } from "vitest";
import {
  formatInvitationPhoneInput,
  invitationAccessInputSchema,
  invitationAccessPinResponseSchema,
  invitationCreateInputSchema,
  invitationEndpointPaths,
  invitationLookupInputSchema,
  invitationRecordSchema,
  invitationSessionResponseSchema,
  invitationUpdateInputSchema,
} from "./index";

describe("invitation contracts", () => {
  it("normalizes Brazilian national and international phone input to E.164", () => {
    expect(formatInvitationPhoneInput("11999999999")).toBe("(11) 99999-9999");
    expect(formatInvitationPhoneInput("+14155552671")).toBe("+1 415 555 2671");
    expect(
      invitationLookupInputSchema.parse({ phone: "(11) 99999-9999" }),
    ).toEqual({
      phone: "+5511999999999",
    });
    expect(
      invitationLookupInputSchema.parse({ phone: "+1 415 555 2671" }),
    ).toEqual({
      phone: "+14155552671",
    });
    expect(() =>
      invitationLookupInputSchema.parse({
        phone: "Call me at (11) 99999-9999",
      }),
    ).toThrow();
    expect(
      invitationAccessPinResponseSchema.parse({ accessPin: "004218" }),
    ).toEqual({ accessPin: "004218" });
    expect(() =>
      invitationAccessPinResponseSchema.parse({ accessPin: "4218" }),
    ).toThrow();
    expect(() =>
      invitationLookupInputSchema.parse({ phone: "+1 415 555 2" }),
    ).toThrow();
  });

  it("requires phone and at least one explicitly classified guest", () => {
    const input = {
      name: "Família Silva",
      phone: "(11) 99999-9999",
      email: "  Ana.Silva@Example.com  ",
      guests: [
        { fullName: "Ana Silva", guestType: "ADULT" },
        { fullName: "Bia Silva", guestType: "CHILD" },
      ],
    };

    expect(invitationCreateInputSchema.parse(input)).toEqual({
      ...input,
      phone: "+5511999999999",
      email: "ana.silva@example.com",
    });
    expect(
      invitationCreateInputSchema.parse({
        ...input,
        email: "",
        guests: [input.guests[0]],
      }),
    ).toMatchObject({ email: null, guests: [{ guestType: "ADULT" }] });
    expect(() =>
      invitationCreateInputSchema.parse({ ...input, phone: null }),
    ).toThrow();
    expect(() =>
      invitationCreateInputSchema.parse({ ...input, guests: [] }),
    ).toThrow();
    expect(() =>
      invitationCreateInputSchema.parse({
        ...input,
        guests: [{ fullName: "Ana Silva", guestType: "UNKNOWN" }],
      }),
    ).toThrow();
    expect(() =>
      invitationCreateInputSchema.parse({ ...input, email: "invalid" }),
    ).toThrow();
    expect(() =>
      invitationCreateInputSchema.parse({ ...input, isIndividual: true }),
    ).toThrow();
  });

  it("normalizes optional email without clearing omitted update fields", () => {
    expect(
      invitationUpdateInputSchema.parse({ email: "  ANA@Example.COM " }),
    ).toEqual({ email: "ana@example.com" });
    expect(invitationUpdateInputSchema.parse({ email: "" })).toEqual({
      email: null,
    });
    expect(
      invitationUpdateInputSchema.parse({
        guests: [{ fullName: "Ana", guestType: "ADULT" }],
      }),
    ).toEqual({
      guests: [{ fullName: "Ana", guestType: "ADULT" }],
    });
    expect(() => invitationUpdateInputSchema.parse({})).toThrow();
  });

  it("accepts phone plus PIN without requiring a guest name", () => {
    expect(
      invitationAccessInputSchema.parse({
        phone: "(11) 99999-9999",
        accessPin: "004218",
      }),
    ).toEqual({ phone: "+5511999999999", accessPin: "004218" });
    expect(() =>
      invitationAccessInputSchema.parse({
        phone: "(11) 99999-9999",
        accessPin: "4218",
        fullName: "Ana Silva",
      }),
    ).toThrow();
  });

  it("returns invitation identity and guests without representative fields", () => {
    const invitation = {
      id: "invitation-1",
      siteId: "site-demo",
      name: "Família Silva",
      phone: "+5511999999999",
      email: null,
      guests: [
        {
          id: "guest-1",
          fullName: "Ana Silva",
          guestType: "ADULT",
          rsvpState: "PENDING",
          rsvpRevision: 0,
        },
      ],
      createdAt: "2026-09-11T12:00:00.000Z",
      updatedAt: "2026-09-11T12:00:00.000Z",
    };

    expect(invitationRecordSchema.parse(invitation)).toEqual(invitation);
    expect(() =>
      invitationRecordSchema.parse({
        ...invitation,
        guests: [{ ...invitation.guests[0], isRepresentative: true }],
      }),
    ).toThrow();
  });

  it("uses canonical invitation routes and session identifiers", () => {
    expect(Object.values(invitationEndpointPaths)).toContain(
      "POST /v1/public/sites/:siteId/invitation/access",
    );
    expect(Object.values(invitationEndpointPaths)).not.toContain(
      "POST /v1/public/sites/:siteId/guest/challenge",
    );
    expect(
      invitationSessionResponseSchema.parse({
        sessionToken: "b".repeat(43),
        siteId: "site-demo",
        invitationId: "invitation-1",
        invitationName: "Família Silva",
        guests: [
          {
            id: "guest-1",
            fullName: "Ana Silva",
            guestType: "ADULT",
            rsvpState: "PENDING",
          },
        ],
        expiresAt: "2026-09-18T12:00:00.000Z",
      }),
    ).toMatchObject({ invitationId: "invitation-1" });
    expect(() =>
      invitationSessionResponseSchema.parse({
        sessionToken: "b".repeat(43),
        siteId: "site-demo",
        invitationId: "invitation-1",
        invitationName: "Família Silva",
        guests: [],
        expiresAt: "2026-09-18T12:00:00.000Z",
        tokenHash: "secret",
      }),
    ).toThrow();
  });
});
