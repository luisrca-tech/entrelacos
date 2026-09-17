import { describe, expect, it } from "vitest";
import { inspectPublicHtml } from "../../scripts/publicBuildGate";

const validHtml = `<!doctype html>
<html lang="pt-BR">
  <head>
    <title>Wedding</title>
    <meta name="robots" content="noindex, nofollow">
    <link rel="canonical" href="https://example.test/">
    <meta property="og:image" content="https://example.test/hero.webp">
    <meta name="twitter:image" content="https://example.test/hero.webp">
  </head>
  <body>
    <img src="/hero.webp" alt="Couple">
    <video poster="/poster.webp"><source src="/intro.mp4"></video>
  </body>
</html>`;

describe("public build CI gate", () => {
  it("accepts one complete pt-BR SEO surface and existing local media", () => {
    expect(
      inspectPublicHtml(
        "dist/index.html",
        validHtml,
        new Set(["hero.webp", "poster.webp", "intro.mp4"]),
      ),
    ).toEqual([]);
  });

  it("rejects missing or duplicated SEO and unresolved emitted media", () => {
    const broken = validHtml
      .replace('<html lang="pt-BR">', '<html lang="en-US">')
      .replace(
        "</head>",
        '<link rel="canonical" href="https://duplicate.test/"></head>',
      )
      .replace(
        '<meta name="twitter:image" content="https://example.test/hero.webp">',
        "",
      );

    expect(inspectPublicHtml("dist/broken.html", broken, new Set())).toEqual(
      expect.arrayContaining([
        expect.stringContaining("lang=pt-BR"),
        expect.stringContaining("exactly one canonical"),
        expect.stringContaining("exactly one twitter:image"),
        expect.stringContaining("hero.webp"),
        expect.stringContaining("poster.webp"),
        expect.stringContaining("intro.mp4"),
      ]),
    );
  });
});
