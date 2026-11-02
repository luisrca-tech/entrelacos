import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { landingConfig } from "../apps/landing/src/landingConfig";
import { publicConsumerApps } from "./publicBuildGate";
import { verifyWorkspaceDiscovery } from "./workspaceGate";

const root = resolve(import.meta.dirname, "..");

describe("landing workspace integration", () => {
  it("provides credential-free build destinations for CI", () => {
    const workflow = readFileSync(
      resolve(root, ".github/workflows/ci.yml"),
      "utf8",
    );
    const environment = Object.fromEntries(
      [...workflow.matchAll(/^\s+(PUBLIC_[A-Z_]+): (https:\S+)$/gm)].map(
        (match) => [match[1], match[2]],
      ),
    );
    expect(landingConfig(environment, true)).toMatchObject({
      siteUrl: expect.stringContaining(".example.test/"),
      botanicalUrl: expect.stringContaining(".example.test/"),
      lettersUrl: expect.stringContaining(".example.test/"),
    });
  });
  it("includes the marketing app in the public artifact gate", () => {
    expect(publicConsumerApps).toContain("landing");
  });

  it("tracks every landing build destination in Turbo's cache key", () => {
    const turbo = JSON.parse(readFileSync(resolve(root, "turbo.json"), "utf8"));
    expect(turbo.tasks.build.env).toEqual(
      expect.arrayContaining([
        "PUBLIC_SITE_URL",
        "PUBLIC_BOTANICAL_DEMO_URL",
        "PUBLIC_LETTERS_DEMO_URL",
        "PUBLIC_CONTACT_URL",
      ]),
    );
  });

  it("discovers and locks the landing with the existing workspaces", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, "apps/landing/package.json"), "utf8"),
    );
    expect(manifest.name).toBe("@entrelacos/landing");
    expect(verifyWorkspaceDiscovery(root)).toEqual([]);
  });
});
