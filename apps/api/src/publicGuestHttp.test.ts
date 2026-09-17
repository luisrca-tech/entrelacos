import { describe, expect, it } from "vitest";
import { forwardedClientIp } from "./publicGuestHttp";

describe("public guest client IP", () => {
  it("prefers Railway's client IP header over forwarded fallbacks", () => {
    expect(
      forwardedClientIp(
        new Headers({
          "X-Real-IP": "198.51.100.10",
          "CF-Connecting-IP": "198.51.100.20",
          "X-Forwarded-For": "198.51.100.30, 198.51.100.40",
        }),
      ),
    ).toBe("198.51.100.10");
  });
});
