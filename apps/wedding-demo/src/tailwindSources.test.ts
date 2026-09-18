import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(
  resolve(import.meta.dirname, "styles/tailwind.css"),
  "utf8",
);

describe("wedding demo Tailwind sources", () => {
  it("scans utility classes owned by the shared UI and template packages", () => {
    expect(stylesheet).toContain('@source "../../../../packages/ui/src";');
    expect(stylesheet).toContain(
      '@source "../../../../packages/template-root/src";',
    );
  });
});
