import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const turbo = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../turbo.json"), "utf8"),
) as { tasks: { build: { env: string[] } } };
const astroConfig = readFileSync(
  resolve(import.meta.dirname, "../astro.config.mjs"),
  "utf8",
);

describe("wedding demo build inputs", () => {
  it("invalidates cached builds when handoff or publication state changes", () => {
    expect(turbo.tasks.build.env).toEqual(
      expect.arrayContaining(["PUBLIC_ADMIN_ORIGIN", "PUBLIC_SITE_INACTIVE"]),
    );
  });
});

describe("progressive enhancement", () => {
  it("transforms the workspace UI package during SSR development", () => {
    expect(astroConfig).toContain('noExternal: ["@entrelacos/ui"]');
  });

  it("provides an honest host-owned fallback for interactive guest areas", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "pages/index.astro"),
      "utf8",
    );
    expect(source).toContain('client:only="react"');
    expect(source).toContain('slot="fallback"');
    expect(source).toContain("Esta área interativa precisa de JavaScript");
  });

  it("uses the guest confirmation feature as the only section heading", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "pages/index.astro"),
      "utf8",
    );
    expect(source).toContain('id="guest-access"');
    expect(source).toContain("<GuestAccess");
    expect(source).not.toContain("guest-access-section-title");
    expect(source).not.toContain("demo-guest-access__heading");
    expect(source).not.toContain("Seu convite, no seu tempo.");
  });

  it("lists gallery before story to match the default home order", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "pages/index.astro"),
      "utf8",
    );
    const navigation = source.slice(
      source.indexOf("const navigation"),
      source.indexOf("const footer"),
    );
    expect(navigation.indexOf('href: "#gallery"')).toBeGreaterThan(-1);
    expect(navigation.indexOf('href: "#gallery"')).toBeLessThan(
      navigation.indexOf('href: "#story"'),
    );
  });

  it("hides the header monogram on tablet and mobile", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "pages/index.astro"),
      "utf8",
    );
    expect(source).toMatch(
      /@media \(max-width:\s*1024px\)[\s\S]*?\.demo-monogram\s*\{[\s\S]*?display:\s*none;/,
    );
  });

  it("keeps the header monogram ring visible after leaving the hero", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "pages/index.astro"),
      "utf8",
    );
    const start = source.indexOf(".demo-monogram {");
    expect(start).toBeGreaterThanOrEqual(0);
    const block = source.slice(start, source.indexOf("}", start));
    expect(block).toContain("border:");
    expect(block).toContain("currentColor");
    expect(block).not.toContain("rgba(244, 240, 232");
  });
});
