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

  it("rewrites to the local public site only from a loopback panel origin", () => {
    expect(
      publicSiteHandoffUrl(
        "https://demo.entrelacos.workers.dev/",
        "http://localhost:3000",
      ),
    ).toBe("http://localhost:4321/#panel");
    expect(
      publicSiteHandoffUrl(
        "https://demo.entrelacos.workers.dev/",
        "http://127.0.0.1:3000",
      ),
    ).toBe("http://localhost:4321/#panel");
    expect(
      publicSiteHandoffUrl(
        "https://demo.entrelacos.workers.dev/",
        "http://[::1]:3000",
      ),
    ).toBe("http://localhost:4321/#panel");
  });

  it("keeps the registered public URL on deployed panels", () => {
    expect(
      publicSiteHandoffUrl(
        "https://demo.entrelacos.workers.dev/",
        "https://admin.entrelacos.workers.dev",
      ),
    ).toBe("https://demo.entrelacos.workers.dev/#panel");
    expect(
      publicSiteHandoffUrl(
        "https://demo.entrelacos.workers.dev/",
        "https://admin-dev.entrelacos.workers.dev",
      ),
    ).toBe("https://demo.entrelacos.workers.dev/#panel");
  });
});
