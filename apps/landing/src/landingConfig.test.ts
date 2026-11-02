import { describe, expect, it } from "vitest";
import { landingConfig } from "./landingConfig";

describe("landing public destinations", () => {
  it("uses independent local demos during development", () => {
    const config = landingConfig({}, false);
    expect(config.botanicalUrl).toBe("http://localhost:4321/");
    expect(config.lettersUrl).toBe("http://localhost:4322/");
    expect(config.contactUrl).toBeNull();
  });
  it("requires verified destinations before production", () => {
    expect(() => landingConfig({}, true)).toThrow("PUBLIC_SITE_URL");
  });
  const env = {
    PUBLIC_SITE_URL: "https://entrelacos.example/",
    PUBLIC_BOTANICAL_DEMO_URL: "https://botanico.example/",
    PUBLIC_LETTERS_DEMO_URL: "https://cartas.example/",
  };
  it("preserves exact HTTPS destinations", () => {
    expect(landingConfig(env, true)).toEqual({
      siteUrl: env.PUBLIC_SITE_URL,
      botanicalUrl: env.PUBLIC_BOTANICAL_DEMO_URL,
      lettersUrl: env.PUBLIC_LETTERS_DEMO_URL,
      contactUrl: null,
    });
  });
  it.each([
    "javascript:alert(1)",
    "http://demo.example/",
    "https://user:secret@example.com/",
    "https://localhost/",
    "https://127.0.0.1/",
    "not-a-url",
  ])("rejects unsafe production destination %s", (url) => {
    expect(() =>
      landingConfig({ ...env, PUBLIC_LETTERS_DEMO_URL: url }, true),
    ).toThrow("PUBLIC_LETTERS_DEMO_URL");
  });
  it("rejects a demo pointing at the other demo", () => {
    expect(() =>
      landingConfig(
        { ...env, PUBLIC_LETTERS_DEMO_URL: env.PUBLIC_BOTANICAL_DEMO_URL },
        true,
      ),
    ).toThrow("independent");
  });
  it("accepts an explicitly configured contact destination", () => {
    expect(
      landingConfig(
        { ...env, PUBLIC_CONTACT_URL: "https://wa.me/5562999999999" },
        true,
      ).contactUrl,
    ).toBe("https://wa.me/5562999999999");
  });
  it("never guesses a contact from account data", () => {
    expect(
      landingConfig({ ...env, OWNER_EMAIL: "private@example.com" }, true)
        .contactUrl,
    ).toBeNull();
  });
});
