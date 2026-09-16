import { describe, expect, it } from "vitest";
import { publicSiteHandoffUrl } from "./sitePublicUrl";

describe("public site handoff URL", () => {
  it("keeps the registered wedding origin and scopes the panel trigger", () => {
    expect(publicSiteHandoffUrl("https://wedding.example.test/")).toBe(
      "https://wedding.example.test/#panel",
    );
    expect(publicSiteHandoffUrl("http://localhost:4321/")).toBe(
      "http://localhost:4321/#panel",
    );
  });

  it("rejects public URLs that are not the registered site root", () => {
    expect(() =>
      publicSiteHandoffUrl("https://evil.example.test/path"),
    ).toThrow();
    expect(() =>
      publicSiteHandoffUrl("https://evil.example.test/?next=panel"),
    ).toThrow();
  });
});
