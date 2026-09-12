import { describe, expect, it } from "vitest";
import {
  DEMO_GUEST_GRANT_TTL_MS,
  issueDemoGuestGrant,
  verifyDemoGuestGrant,
} from "./demoGuestGrant";

const now = new Date("2028-02-29T12:00:00.000Z");
const input = {
  siteId: "site-demo",
  phoneE164: "+5511999999999",
  secret: "demo-grant-secret-with-at-least-32-characters",
  now,
};

describe("demo guest grants", () => {
  it("binds an opaque grant to site and phone without embedding the phone", () => {
    const token = issueDemoGuestGrant(input);

    expect(token).not.toContain(input.phoneE164);
    expect(token.split(".")).toHaveLength(2);
    expect(verifyDemoGuestGrant(token, input)).toMatchObject({
      siteId: input.siteId,
      expiresAt: new Date(now.getTime() + DEMO_GUEST_GRANT_TTL_MS),
    });
  });

  it.each([
    ["site-demo-other", input.phoneE164],
    [input.siteId, "+5521999999998"],
  ])("rejects a grant used for another %s", (siteId, phoneE164) => {
    const token = issueDemoGuestGrant(input);

    expect(() =>
      verifyDemoGuestGrant(token, { ...input, siteId, phoneE164 }),
    ).toThrowError("Demo guest grant does not match request");
  });

  it("rejects tampering and expiry", () => {
    const token = issueDemoGuestGrant(input);
    const [payload, signature] = token.split(".");

    expect(() =>
      verifyDemoGuestGrant(`${payload}.X${signature.slice(1)}`, input),
    ).toThrowError("Invalid demo guest grant");
    expect(() =>
      verifyDemoGuestGrant(token, {
        ...input,
        now: new Date(now.getTime() + DEMO_GUEST_GRANT_TTL_MS),
      }),
    ).toThrowError("Demo guest grant expired");
  });
});
