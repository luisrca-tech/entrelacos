import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "ScheduleSection.astro"),
  "utf8",
);

describe("ScheduleSection host-owned practical content", () => {
  it("renders ordered schedule entries and optional practical guidance", () => {
    expect(source).toContain("content.entries.map");
    expect(source).toContain("entry.time");
    expect(source).toContain("entry.title");
    expect(source).toContain("entry.body");
    expect(source).toContain("content.guidance.map");
    expect(source).toContain("content.guidanceLabel");
    expect(source).not.toContain("Cerimônia");
    expect(source).not.toContain("Recepção");
  });

  it("separates the guidance title from the first practical item", () => {
    expect(source).toContain("mb-7");
  });
});
