import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "AccessForm.tsx"),
  "utf8",
);

describe("first-access password bounds", () => {
  it("asks for 10 to 12 characters instead of a 12-character minimum", () => {
    expect(source).toContain("minLength={10}");
    expect(source).toContain("maxLength={12}");
    expect(source).toContain("Use de 10 a 12 caracteres.");
    expect(source).not.toContain("minLength={12}");
    expect(source).not.toContain("Use pelo menos 12 caracteres.");
  });
});
