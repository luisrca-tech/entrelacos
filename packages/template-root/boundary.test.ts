import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const templateRoot = resolve(repoRoot, "packages/template-root");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : path.endsWith(".astro") || path.endsWith(".ts")
        ? [path]
        : [];
  });
}

describe("template-root public boundary", () => {
  it("exposes v1 and keeps demo data outside package source", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(templateRoot, "package.json"), "utf8"),
    ) as {
      exports?: Record<string, string>;
    };
    expect(packageJson.exports).toEqual({ "./v1": "./src/v1.ts" });
    const publicEntry = readFileSync(
      resolve(templateRoot, "src/v1.ts"),
      "utf8",
    );
    expect(publicEntry).toContain("StoryContent");
    expect(publicEntry).toContain("validateStoryContent");

    const templateSource = sourceFiles(resolve(templateRoot, "src"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    for (const demoValue of [
      "Marina",
      "Caio",
      "Casablanca",
      "Goiânia",
      "EntreLaços",
    ]) {
      expect(templateSource).not.toContain(demoValue);
    }
  });

  it("keeps consumers on the public entrypoint", () => {
    for (const consumer of [
      "apps/wedding-demo/src",
      "apps/template-fixture/src",
    ]) {
      const consumerSource = sourceFiles(resolve(repoRoot, consumer))
        .map((path) => readFileSync(path, "utf8"))
        .join("\n");
      expect(consumerSource).not.toMatch(
        /@entrelacos\/template-root\/(?!v1(?:["'])|styles\.css)/,
      );
      expect(consumerSource).not.toMatch(
        /@entrelacos\/(?:wedding-demo|template-fixture)/,
      );
    }
  });

  it("contains a second host route and a host-owned local section", () => {
    expect(
      existsSync(
        resolve(repoRoot, "apps/template-fixture/src/pages/hospedagem.astro"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(
          repoRoot,
          "apps/template-fixture/src/components/LocalSection.astro",
        ),
      ),
    ).toBe(true);
  });

  it("keeps the demo composition and final media assets host-owned", () => {
    const demoPage = readFileSync(
      resolve(repoRoot, "apps/wedding-demo/src/pages/index.astro"),
      "utf8",
    );
    expect(demoPage).toContain("WeddingHome");
    expect(demoPage).toContain("gallery");
    expect(demoPage).toContain("schedule");
    expect(demoPage).toContain("venue");
    expect(demoPage).toContain("O acaso apresentou. A vida fez o resto.");
    expect(demoPage).toContain("Marina & Caio");
    expect(demoPage).not.toContain('eyebrow: "01 /');
    expect(demoPage).not.toContain('eyebrow: "02 /');
    expect(demoPage).not.toContain('eyebrow: "03 /');
    expect(demoPage).not.toContain('eyebrow: "04 /');
    expect(demoPage).not.toContain('class="demo-eyebrow">05 /');
    expect(demoPage).not.toContain("placeholder");
    expect(demoPage).not.toContain("demo-hero");
    expect(demoPage).toContain('poster: "/marina-caio-hero-poster.webp"');
    expect(demoPage).toContain('src: "/marina-caio-story-encounter.webp"');
    expect(
      existsSync(
        resolve(repoRoot, "apps/wedding-demo/public/marina-caio-hero.mp4"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(
          repoRoot,
          "apps/wedding-demo/public/marina-caio-hero-poster.webp",
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(repoRoot, "apps/wedding-demo/public/marina-caio-monogram.svg"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(
          repoRoot,
          "apps/wedding-demo/public/marina-caio-story-encounter.webp",
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(
          repoRoot,
          "apps/wedding-demo/public/marina-caio-story-celebration.webp",
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(
          repoRoot,
          "apps/wedding-demo/public/marina-caio-gallery-six.webp",
        ),
      ),
    ).toBe(true);
  });
});
