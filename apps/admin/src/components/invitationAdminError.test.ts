import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/apiClient";
import { invitationAdminError } from "./invitationAdminError";

describe("invitation admin errors", () => {
  it("explains a duplicate phone without exposing a technical code", () => {
    expect(invitationAdminError(new ApiError(409, "PHONE_CONFLICT"))).toContain(
      "telefone",
    );
  });

  it("explains concurrent confirmation edits", () => {
    expect(invitationAdminError(new ApiError(409, "RSVP_CONFLICT"))).toContain(
      "alterou",
    );
  });
});
