import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/apiClient";
import { mergeSiteMessages, messageAdminError } from "./messageAdmin";

const invitation = {
  invitationId: "invitation-a",
  invitationName: "Família Silva",
  blocked: false,
  currentRevision: 1,
  message: null,
};

describe("message administration helpers", () => {
  it("replaces refreshed pages and deduplicates appended invitations", () => {
    expect(
      mergeSiteMessages(
        [invitation],
        [{ ...invitation, blocked: true }],
        false,
      ),
    ).toEqual([{ ...invitation, blocked: true }]);
    expect(
      mergeSiteMessages(
        [invitation],
        [
          invitation,
          {
            ...invitation,
            invitationId: "invitation-b",
            invitationName: "Família Lima",
          },
        ],
        true,
      ).map(({ invitationId }) => invitationId),
    ).toEqual(["invitation-a", "invitation-b"]);
  });

  it("explains moderation conflicts without exposing backend details", () => {
    expect(messageAdminError(new ApiError(409, "MESSAGE_CONFLICT"))).toContain(
      "alterada",
    );
    expect(messageAdminError(new ApiError(404, "MESSAGE_NOT_FOUND"))).toContain(
      "não existe mais",
    );
  });
});
