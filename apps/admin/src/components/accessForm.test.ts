import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "AccessForm.tsx"),
  "utf8",
);

describe("first-access password bounds", () => {
  it("asks for 6 to 10 characters", () => {
    expect(source).toContain("minLength={6}");
    expect(source).toContain("maxLength={10}");
    expect(source).toContain("Use de 6 a 10 caracteres.");
    expect(source).not.toContain("minLength={10}");
    expect(source).not.toContain("maxLength={12}");
    expect(source).not.toContain("Use de 10 a 12 caracteres.");
  });
});
