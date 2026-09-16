import { describe, expect, it } from "vitest";
import { hasValidAccessToken, readAccessTokenFromHash } from "./accessToken";

describe("admin access token fragments", () => {
  it("reads a valid token from an activation URL fragment", () => {
    const token = "a".repeat(43);

    expect(readAccessTokenFromHash(`#token=${token}`)).toBe(token);
    expect(hasValidAccessToken(token)).toBe(true);
  });

  it("rejects missing and malformed token fragments", () => {
    expect(readAccessTokenFromHash("")).toBe("");
    expect(hasValidAccessToken("short-token")).toBe(false);
  });
});
