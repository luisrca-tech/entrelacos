import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("authentication page headings", () => {
  it.each([
    ["AccessForm.tsx", "components/AccessForm.tsx"],
    ["handoff.tsx", "routes/handoff.tsx"],
  ])("uses exactly one h1 on %s", (_name, relativePath) => {
    const source = readFileSync(
      resolve(import.meta.dirname, relativePath),
      "utf8",
    );
    expect(source.match(/<h1\b/g)).toHaveLength(1);
  });
});
