import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
function source(directory: string): string {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      if (["node_modules", "dist", ".astro"].includes(entry.name)) return [];
      const path = resolve(directory, entry.name);
      return entry.isDirectory()
        ? source(path)
        : /\.(?:astro|ts|tsx|css)$/.test(path)
          ? readFileSync(path, "utf8")
          : [];
    })
    .join("\n");
}
describe("independent wedding templates", () => {
  it.each(["cinema-botanico", "cartas-do-nosso-sim"])(
    "keeps %s standalone",
    (name) => {
      const directory = resolve(root, "packages/templates", name);
      const manifest = JSON.parse(
        readFileSync(resolve(directory, "package.json"), "utf8"),
      );
      expect(manifest.name).toBe(`@entrelacos/template-${name}`);
      expect(source(resolve(directory, "src"))).not.toMatch(
        /@entrelacos\/template-(?:root|cinema-botanico|cartas-do-nosso-sim)/,
      );
      expect(source(resolve(directory, "src"))).not.toMatch(
        /packages\/templates|wedding-demo-/,
      );
    },
  );
  it("keeps botanical presentation free of letter-only styles and behavior", () => {
    const directory = resolve(root, "packages/templates/cinema-botanico");
    expect(source(resolve(directory, "src"))).not.toMatch(
      /LetterComposition|data-wedding-theme|template-letter-|theme === "letters"/,
    );
  });
  it.each([
    ["botanico", "cinema-botanico"],
    ["cartas", "cartas-do-nosso-sim"],
  ])("gives %s its own root and dependency", (app, template) => {
    const directory = resolve(root, `apps/wedding-demo-${app}`);
    const manifest = JSON.parse(
      readFileSync(resolve(directory, "package.json"), "utf8"),
    );
    expect(manifest.dependencies[`@entrelacos/template-${template}`]).toBe(
      "workspace:*",
    );
    expect(source(resolve(directory, "src"))).not.toMatch(
      /@entrelacos\/template-root|\.\.\/.*wedding-demo-/,
    );
    expect(existsSync(resolve(directory, "src/pages/index.astro"))).toBe(true);
    expect(
      existsSync(
        resolve(directory, "src/pages/cartas-do-nosso-sim/index.astro"),
      ),
    ).toBe(false);
  });
  it("does not ship botanical assets to letters", () => {
    const publicDir = resolve(root, "apps/wedding-demo-cartas/public");
    const files = readdirSync(publicDir);
    expect(files.filter((name) => /\.(webp|mp4)$/.test(name)).sort()).toEqual([
      "marina-caio-gallery-three.webp",
      "marina-caio-story-home.webp",
    ]);
  });
});
