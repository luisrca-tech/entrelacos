import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "WeddingHome.astro"),
  "utf8",
);

describe("WeddingHome navigation state", () => {
  it("starts transparent only when the hero is the first section", () => {
    expect(source).toContain('hasHero={order[0] === "hero"}');
  });

  it("derives the intro sequence from host-owned gallery media", () => {
    expect(source).toContain("props.gallery?.items.map((item) => item.media)");
    expect(source).toContain("introMedia={introMedia}");
  });
});
