import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  adminRsvpWriteInputSchema,
  block4EndpointPaths,
  invitationRsvpResponseSchema,
  invitationRsvpWriteInputSchema,
  rsvpDeadlineSchema,
  rsvpErrorCodeSchema,
  rsvpHistoryQuerySchema,
  rsvpHistoryResponseSchema,
  rsvpStateSchema,
  siteRsvpResponseSchema,
} from "./index";

const requestId = randomUUID();

describe("Block 4 RSVP contracts", () => {
  it("accepts the three guest states and rejects unknown states", () => {
    expect(rsvpStateSchema.options).toEqual([
      "PENDING",
      "CONFIRMED",
      "DECLINED",
    ]);
    expect(rsvpStateSchema.parse("PENDING")).toBe("PENDING");
    expect(() => rsvpStateSchema.parse("MAYBE")).toThrow();
  });

  it("requires a paired nullable deadline and a valid IANA timezone", () => {
    expect(
      rsvpDeadlineSchema.parse({
        deadlineAt: null,
        deadlineTimezone: null,
      }),
    ).toEqual({ deadlineAt: null, deadlineTimezone: null });
    expect(
      rsvpDeadlineSchema.parse({
        deadlineAt: "2027-05-01T18:00:00.000Z",
        deadlineTimezone: "America/Sao_Paulo",
      }),
    ).toEqual({
      deadlineAt: "2027-05-01T18:00:00.000Z",
      deadlineTimezone: "America/Sao_Paulo",
    });
    expect(
      rsvpDeadlineSchema.parse({
        deadlineAt: "2027-05-01T18:00:00.000Z",
        deadlineTimezone: "UTC",
      }),
    ).toMatchObject({ deadlineTimezone: "UTC" });
    expect(() =>
      rsvpDeadlineSchema.parse({
        deadlineAt: null,
        deadlineTimezone: "America/Sao_Paulo",
      }),
    ).toThrow();
    expect(() =>
      rsvpDeadlineSchema.parse({
        deadlineAt: "2027-05-01T18:00:00.000Z",
        deadlineTimezone: "Not/A_Timezone",
      }),
    ).toThrow();
    expect(() =>
      rsvpDeadlineSchema.parse({
        deadlineAt: null,
        deadlineTimezone: null,
        serverNow: "2027-04-01T18:00:00.000Z",
        canEdit: true,
        readOnlyReason: null,
        extra: true,
      }),
    ).toThrow();
  });

  it("requires UUID idempotency and guest-level expected revisions", () => {
    const payload = {
      requestId,
      guests: [
        { guestId: "guest-1", state: "CONFIRMED", expectedRevision: 0 },
        { guestId: "guest-2", state: "PENDING", expectedRevision: 4 },
      ],
    } as const;

    expect(invitationRsvpWriteInputSchema.parse(payload)).toEqual(payload);
    expect(adminRsvpWriteInputSchema.parse(payload)).toEqual(payload);
    expect(() =>
      invitationRsvpWriteInputSchema.parse({
        ...payload,
        requestId: "request-1",
      }),
    ).toThrow();
    expect(() =>
      invitationRsvpWriteInputSchema.parse({
        ...payload,
        guests: [
          { guestId: "guest-1", state: "CONFIRMED", expectedRevision: -1 },
        ],
      }),
    ).toThrow();
    expect(() =>
      invitationRsvpWriteInputSchema.parse({
        ...payload,
        guests: [
          { guestId: "guest-1", state: "CONFIRMED", expectedRevision: 0 },
          { guestId: "guest-1", state: "DECLINED", expectedRevision: 0 },
        ],
      }),
    ).toThrow();
    expect(() =>
      invitationRsvpWriteInputSchema.parse({ ...payload, actorId: "admin-1" }),
    ).toThrow();
  });

  it("keeps public and administrative reads explicit and strict", () => {
    expect(
      invitationRsvpResponseSchema.parse({
        siteId: "site-demo",
        invitationId: "invitation-demo",
        invitationName: "Família Silva",
        deadlineAt: null,
        deadlineTimezone: null,
        serverNow: "2027-04-01T18:00:00.000Z",
        canEdit: true,
        readOnlyReason: null,
        guests: [
          {
            id: "guest-1",
            fullName: "Ana Silva",
            guestType: "ADULT",
            state: "CONFIRMED",
            revision: 1,
          },
        ],
      }),
    ).toMatchObject({ siteId: "site-demo", invitationId: "invitation-demo" });

    expect(
      siteRsvpResponseSchema.parse({
        siteId: "site-demo",
        deadlineAt: "2027-05-01T18:00:00.000Z",
        deadlineTimezone: "America/Sao_Paulo",
        lifecycle: "ACTIVE",
        totals: { pending: 0, confirmed: 1, declined: 0 },
        invitations: [
          {
            id: "invitation-demo",
            name: "Família Silva",
            totals: { pending: 0, confirmed: 1, declined: 0 },
            guests: [
              {
                id: "guest-1",
                fullName: "Ana Silva",
                guestType: "ADULT",
                state: "CONFIRMED",
                revision: 1,
              },
            ],
          },
        ],
      }),
    ).toMatchObject({ siteId: "site-demo" });

    expect(() =>
      invitationRsvpResponseSchema.parse({
        siteId: "site-demo",
        invitationId: "invitation-demo",
        deadlineAt: null,
        deadlineTimezone: null,
        guests: [],
        phone: "+5511999999999",
      }),
    ).toThrow();
  });

  it("supports bounded history filters and stable RSVP errors", () => {
    expect(
      rsvpHistoryQuerySchema.parse({
        cursor: "cursor-1",
        limit: "25",
        invitationId: "invitation-demo",
        guestId: "guest-1",
        actorType: "INVITATION",
      }),
    ).toEqual({
      cursor: "cursor-1",
      limit: 25,
      invitationId: "invitation-demo",
      guestId: "guest-1",
      actorType: "INVITATION",
    });
    expect(() =>
      rsvpHistoryQuerySchema.parse({ cursor: "cursor-1", unknown: true }),
    ).toThrow();
    expect(
      rsvpHistoryResponseSchema.parse({
        entries: [
          {
            id: "history-1",
            siteId: "site-demo",
            invitationId: "invitation-demo",
            invitationName: "Família Silva",
            guestId: "guest-1",
            guestDisplayName: "Ana Silva",
            beforeState: "PENDING",
            afterState: "CONFIRMED",
            actorType: "INVITATION",
            actorId: "invitation-1",
            actorDisplayName: "Ana Silva",
            occurredAt: "2027-04-01T18:00:00.000Z",
          },
        ],
        nextCursor: null,
      }),
    ).toMatchObject({ nextCursor: null });
    expect(
      ["RSVP_CONFLICT", "RSVP_DEADLINE_PASSED", "IDEMPOTENCY_KEY_REUSED"].map(
        (code) => rsvpErrorCodeSchema.parse(code),
      ),
    ).toEqual([
      "RSVP_CONFLICT",
      "RSVP_DEADLINE_PASSED",
      "IDEMPOTENCY_KEY_REUSED",
    ]);
  });

  it("freezes the Block 4 HTTP surface", () => {
    expect(block4EndpointPaths).toEqual({
      publicInvitationRsvpRead: "GET /v1/public/invitation/rsvp",
      publicInvitationRsvpWrite: "POST /v1/public/invitation/rsvp",
      siteRsvpRead: "GET /v1/sites/:siteId/rsvp",
      siteRsvpWrite: "POST /v1/sites/:siteId/rsvp",
      siteRsvpDeadlineRead: "GET /v1/sites/:siteId/rsvp/deadline",
      siteRsvpDeadlineUpdate: "PATCH /v1/sites/:siteId/rsvp/deadline",
      siteRsvpHistoryRead: "GET /v1/sites/:siteId/rsvp/history",
    });
  });
});
