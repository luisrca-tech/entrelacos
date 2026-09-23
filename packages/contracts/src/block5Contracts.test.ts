import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  block5EndpointPaths,
  invitationDeleteConfirmationSchema,
  invitationExportQuerySchema,
  invitationMessageResponseSchema,
  messageMutationInputSchema,
  messageMutationResponseSchema,
  messageTextSchema,
  muralConfigurationSchema,
  publicMuralQuerySchema,
  publicMuralResponseSchema,
  siteMessageBlockInputSchema,
} from "./index";

const requestId = randomUUID();
const instant = "2027-05-01T18:00:00.000Z";

describe("Block 5 contracts", () => {
  it("accepts Unicode and newlines while enforcing the message boundary", () => {
    expect(
      messageTextSchema.parse("Viva os noivos! 👩‍❤️‍👨\r\nCom carinho."),
    ).toBe("Viva os noivos! 👩‍❤️‍👨\nCom carinho.");
    expect(messageTextSchema.parse("😀".repeat(1_000))).toHaveLength(2_000);
    expect(() => messageTextSchema.parse("😀".repeat(1_001))).toThrow();
    expect(() => messageTextSchema.parse("   \n ")).toThrow();
    expect(() => messageTextSchema.parse("<strong>Olá</strong>")).toThrow();
    expect(() => messageTextSchema.parse("Olá\u0000")).toThrow();
  });

  it("requires revision and UUID idempotency without accepting identity", () => {
    const input = { requestId, expectedRevision: 0, text: "Com carinho" };
    expect(messageMutationInputSchema.parse(input)).toEqual(input);
    expect(() =>
      messageMutationInputSchema.parse({
        ...input,
        authorName: "Pessoa inventada",
      }),
    ).toThrow();
    expect(() =>
      messageMutationInputSchema.parse({ ...input, expectedRevision: -1 }),
    ).toThrow();
  });

  it("keeps invitation message state explicit and private", () => {
    const message = {
      id: "message-1",
      authorName: "Ana Silva",
      invitationName: "Família Silva",
      text: "Com carinho",
      revision: 1,
      createdAt: instant,
      updatedAt: instant,
    };
    expect(
      invitationMessageResponseSchema.parse({
        siteId: "site-demo",
        invitationId: "invitation-demo",
        currentRevision: 1,
        canEdit: true,
        readOnlyReason: null,
        message,
      }),
    ).toMatchObject({ message });
    expect(() =>
      invitationMessageResponseSchema.parse({
        siteId: "site-demo",
        invitationId: "invitation-demo",
        currentRevision: 1,
        canEdit: true,
        readOnlyReason: null,
        message: { ...message, phone: "+5562999999999" },
      }),
    ).toThrow();
    expect(
      messageMutationResponseSchema.parse({
        requestId,
        acceptedAt: instant,
        result: "APPLIED",
        replayed: false,
        message,
      }),
    ).toMatchObject({ result: "APPLIED" });
  });

  it("defines no-store mural pagination without private guest fields", () => {
    expect(publicMuralQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(
      publicMuralQuerySchema.parse({ cursor: "opaque", limit: "100" }),
    ).toEqual({ cursor: "opaque", limit: 100 });
    expect(() => publicMuralQuerySchema.parse({ limit: 101 })).toThrow();
    expect(
      publicMuralResponseSchema.parse({
        enabled: false,
        messages: [],
        nextCursor: null,
      }),
    ).toEqual({ enabled: false, messages: [], nextCursor: null });
    expect(() =>
      publicMuralResponseSchema.parse({
        enabled: true,
        messages: [
          {
            id: "message-1",
            authorName: "Ana Silva",
            invitationName: "Família Silva",
            text: "Olá",
            createdAt: instant,
            updatedAt: instant,
            rsvpState: "CONFIRMED",
          },
        ],
        nextCursor: null,
      }),
    ).toThrow();
  });

  it("requires explicit administration inputs", () => {
    expect(muralConfigurationSchema.parse({ enabled: true })).toEqual({
      enabled: true,
    });
    expect(siteMessageBlockInputSchema.parse({ blocked: true })).toEqual({
      blocked: true,
    });
    expect(
      invitationDeleteConfirmationSchema.parse({
        confirmInvitationId: "invitation-1",
        confirmInvitationName: "Família Silva",
      }),
    ).toMatchObject({ confirmInvitationId: "invitation-1" });
    expect(() =>
      invitationDeleteConfirmationSchema.parse({
        confirmInvitationId: "invitation-1",
      }),
    ).toThrow();
  });

  it("defaults both export contacts off and accepts invitation filters", () => {
    expect(
      invitationExportQuerySchema.parse({
        requestId,
        includePhone: "false",
        includeEmail: "true",
        search: " Família Silva ",
        status: "PENDING",
        guestType: "CHILD",
      }),
    ).toEqual({
      requestId,
      includePhone: false,
      includeEmail: true,
      search: "Família Silva",
      status: "PENDING",
      guestType: "CHILD",
    });
    expect(invitationExportQuerySchema.parse({ requestId })).toEqual({
      requestId,
      includePhone: false,
      includeEmail: false,
    });
    expect(() =>
      invitationExportQuerySchema.parse({
        requestId,
        includeMessages: "true",
      }),
    ).toThrow();
  });

  it("freezes the Block 5 route surface", () => {
    expect(Object.values(block5EndpointPaths)).toEqual([
      "GET /v1/public/invitation/message",
      "PUT /v1/public/invitation/message",
      "GET /v1/public/sites/:siteId/mural",
      "GET /v1/sites/:siteId/messages",
      "GET /v1/sites/:siteId/mural",
      "PATCH /v1/sites/:siteId/mural",
      "DELETE /v1/sites/:siteId/invitations/:invitationId/message",
      "PATCH /v1/sites/:siteId/invitations/:invitationId/message-block",
      "DELETE /v1/sites/:siteId/invitations/:invitationId",
      "GET /v1/sites/:siteId/reports/invitations.csv",
      "GET /v1/sites/:siteId/reports/invitations.pdf",
    ]);
  });
});
