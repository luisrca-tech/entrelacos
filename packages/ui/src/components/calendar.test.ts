import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "calendar.tsx"),
  "utf8",
);

describe("Calendar layout", () => {
  it("keeps month arrows in the caption row instead of overflowing the popover", () => {
    expect(source).toContain("[--cell-size:--spacing(8)]");
    expect(source).toContain("size-(--cell-size)");
    expect(source).toContain(
      "h-(--cell-size) w-full items-center justify-center px-(--cell-size)",
    );
    expect(source).not.toContain("absolute left-1");
    expect(source).not.toContain("absolute right-1");
    expect(source).not.toContain(
      '"absolute left-1 size-10 p-0 aria-disabled:opacity-50"',
    );
  });

  it("fills each day cell so the current-day number stays centered", () => {
    expect(source).toContain(
      "aspect-square size-auto w-full min-w-(--cell-size) items-center justify-center",
    );
  });
});
