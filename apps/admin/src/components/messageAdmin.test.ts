import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/apiClient";
import { mergeSiteMessages, messageAdminError } from "./messageAdmin";

const message = {
  id: "message-a",
  authorName: "Luís Felipe",
  text: "Felicidades!",
  createdAt: "2026-09-24T12:00:00.000Z",
};

describe("message administration helpers", () => {
  it("replaces refreshed pages and deduplicates appended messages by ID", () => {
    expect(
      mergeSiteMessages([message], [{ ...message, text: "Atualizada" }], false),
    ).toEqual([{ ...message, text: "Atualizada" }]);
    expect(
      mergeSiteMessages(
        [message],
        [message, { ...message, id: "message-b" }],
        true,
      ).map(({ id }) => id),
    ).toEqual(["message-a", "message-b"]);
  });

  it("explains a removed message without exposing backend details", () => {
    expect(messageAdminError(new ApiError(404, "MESSAGE_NOT_FOUND"))).toContain(
      "não existe mais",
    );
  });
});
