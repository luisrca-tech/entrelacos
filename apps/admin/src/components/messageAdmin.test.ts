import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/apiClient";
import { mergeSiteMessages, messageAdminError } from "./messageAdmin";

const group = {
  groupId: "group-a",
  groupName: "Família Silva",
  blocked: false,
  currentRevision: 1,
  message: null,
};

describe("message administration helpers", () => {
  it("replaces refreshed pages and deduplicates appended groups", () => {
    expect(
      mergeSiteMessages([group], [{ ...group, blocked: true }], false),
    ).toEqual([{ ...group, blocked: true }]);
    expect(
      mergeSiteMessages(
        [group],
        [group, { ...group, groupId: "group-b", groupName: "Família Lima" }],
        true,
      ).map(({ groupId }) => groupId),
    ).toEqual(["group-a", "group-b"]);
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
