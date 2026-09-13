import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const turbo = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../turbo.json"), "utf8"),
) as { tasks: { build: { env: string[] } } };

describe("wedding demo build inputs", () => {
  it("invalidates cached builds when handoff or publication state changes", () => {
    expect(turbo.tasks.build.env).toEqual(
      expect.arrayContaining(["PUBLIC_ADMIN_ORIGIN", "PUBLIC_SITE_INACTIVE"]),
    );
  });
});

describe("progressive enhancement", () => {
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
});
