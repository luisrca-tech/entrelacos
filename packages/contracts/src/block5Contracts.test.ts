import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  block5EndpointPaths,
  invitationDeleteConfirmationSchema,
  invitationExportQuerySchema,
  messageTextSchema,
  muralConfigurationSchema,
  publicMuralQuerySchema,
  publicMuralResponseSchema,
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
            text: "Olá",
            createdAt: instant,
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
      "GET /v1/public/sites/:siteId/mural",
      "POST /v1/public/sites/:siteId/mural",
      "GET /v1/sites/:siteId/messages",
      "GET /v1/sites/:siteId/mural",
      "PATCH /v1/sites/:siteId/mural",
      "DELETE /v1/sites/:siteId/messages/:messageId",
      "DELETE /v1/sites/:siteId/invitations/:invitationId",
      "GET /v1/sites/:siteId/reports/invitations.csv",
      "GET /v1/sites/:siteId/reports/invitations.pdf",
    ]);
  });
});
