import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { readInvitationMessage, writeInvitationMessage } from "./messages";

describe("messages service validation", () => {
  it("parses the shared plain text contract before opening a transaction", async () => {
    const transaction = vi.fn();
    const db = { transaction } as never;
    await expect(
      writeInvitationMessage(
        db,
        "invitation-token",
        {
          requestId: randomUUID(),
          expectedRevision: 0,
          text: "<script>alert(1)</script>",
        },
        new Date("2029-01-10T12:00:00.000Z"),
      ),
    ).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects an invalid clock without querying the database", async () => {
    const execute = vi.fn();
    const db = { execute } as never;
    await expect(
      readInvitationMessage(db, "invitation-token", new Date("invalid")),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    expect(execute).not.toHaveBeenCalled();
  });

  it("reads an invitation-owned message without a representative", async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [
        {
          session_id: "session-1",
          site_id: "site-1",
          invitation_id: "invitation-1",
          expires_at: "2029-01-11T12:00:00.000Z",
          revoked_at: null,
          lifecycle: "ACTIVE",
          mural_enabled: true,
          invitation_name: "Família Silva",
          message_blocked: false,
          message_revision: 1,
          message_id: "message-1",
          author_name: "Família Silva",
          message_invitation_name: "Família Silva",
          message_text: "Com carinho",
          message_revision_value: 1,
          message_created_at: "2029-01-10T10:00:00.000Z",
          message_updated_at: "2029-01-10T10:00:00.000Z",
        },
      ],
    });
    const response = await readInvitationMessage(
      { execute } as never,
      "invitation-token",
      new Date("2029-01-10T12:00:00.000Z"),
    );
    expect(response).toMatchObject({
      siteId: "site-1",
      invitationId: "invitation-1",
      canEdit: true,
      message: { authorName: "Família Silva", invitationName: "Família Silva" },
    });
    expect(JSON.stringify(response)).not.toMatch(/representative|groupId/iu);
  });
});
