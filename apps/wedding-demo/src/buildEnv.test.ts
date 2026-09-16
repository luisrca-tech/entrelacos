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

  it("keeps the host section label distinct from the guest feature label", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "pages/index.astro"),
      "utf8",
    );
    expect(source).toContain('aria-labelledby="guest-access-section-title"');
    expect(source).toContain('id="guest-access-section-title"');
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
