import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const turbo = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../turbo.json"), "utf8"),
) as { tasks: { build: { env: string[] }; dev: { env?: string[] } } };
const astroConfig = readFileSync(
  resolve(import.meta.dirname, "../astro.config.mjs"),
  "utf8",
);

describe("wedding demo build inputs", () => {
  it("forwards the explicit application environment to development tasks", () => {
    expect(turbo.tasks.dev.env).toContain("APP_ENV");
  });

  it("invalidates cached builds when handoff or publication state changes", () => {
    expect(turbo.tasks.build.env).toEqual(
      expect.arrayContaining(["PUBLIC_ADMIN_ORIGIN", "PUBLIC_SITE_INACTIVE"]),
    );
  });

  it("applies local PUBLIC defaults only through the astro dev config", () => {
    expect(astroConfig).toContain("localPublicEnvPatch");
    expect(astroConfig).toContain("astroCliCommand");
    expect(astroConfig).toContain("hasEnvFile");
  });
});

describe("progressive enhancement", () => {
  it("composes runtime gifts in the template seam without enabling live demo payments", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "components/DemoFeatures.astro"),
      "utf8",
    );
    expect(source).toContain("<GiftSection");
    expect(source).toContain("<GiftRegistry");
    expect(source).toContain("demo={true}");
    expect(source).not.toContain("Há palavras que também viram lembrança.");
    expect(source).not.toContain("gift-quotes");
    expect(source).not.toContain("R2_SECRET");
  });
  it("transforms the workspace UI package during SSR development", () => {
    expect(astroConfig).toContain('noExternal: ["@entrelacos/ui"]');
  });

  it("provides an honest host-owned fallback for interactive guest areas", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "components/DemoFeatures.astro"),
      "utf8",
    );
    expect(source).toContain('client:only="react"');
    expect(source).toContain('slot="fallback"');
    expect(source).toContain("Esta área interativa precisa de JavaScript");
  });

  it("uses the guest confirmation feature as the only section heading", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "components/DemoFeatures.astro"),
      "utf8",
    );
    expect(source).toContain('id="guest-access"');
    expect(source).toContain("<GuestAccess");
    expect(source).not.toContain("guest-access-section-title");
    expect(source).not.toContain("demo-guest-access__heading");
    expect(source).not.toContain("Seu convite, no seu tempo.");
  });

  it("uses the letter composition at the app root", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "pages/index.astro"),
      "utf8",
    );
    expect(source).toContain("<LetterComposition");
    expect(source).not.toContain("WeddingHome");
    expect(source).not.toContain("GallerySection");
  });
});
