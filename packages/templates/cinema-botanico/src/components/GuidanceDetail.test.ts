import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "GuidanceDetail.tsx"),
  "utf8",
);

describe("GuidanceDetail", () => {
  it("opens host-owned detail copy and image from the item label", () => {
    expect(source).toContain("detail.label");
    expect(source).toContain("detail.title");
    expect(source).toContain("detail.body");
    expect(source).toContain("detail.closeLabel");
    expect(source).toContain("detail.media.src");
    expect(source).toContain("detail.media.width");
    expect(source).toContain("detail.media.height");
    expect(source).toContain("<Dialog");
    expect(source).toContain("<DialogTrigger");
    expect(source).not.toContain("Madrinhas");
    expect(source).not.toContain("Padrinhos");
  });
});
