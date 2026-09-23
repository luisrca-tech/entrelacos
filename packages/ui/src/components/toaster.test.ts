import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "toaster.tsx"),
  "utf8",
);
const barrel = readFileSync(
  resolve(import.meta.dirname, "../index.ts"),
  "utf8",
);

describe("Toaster defaults", () => {
  it("uses rich colors and top-center as the app-wide toast position", () => {
    expect(source).toContain('position = "top-center"');
    expect(source).toContain("richColors = true");
  });

  it("keeps sonner inside the wrapper and publishes toasts for every island", () => {
    expect(source).toContain('from "sonner"');
    expect(source).toContain("toastEventName");
    expect(source).toContain("sonnerToast[detail.kind]");
    expect(source).toContain('export { toast } from "../lib/publishToast"');
    expect(source).not.toContain('export { toast } from "sonner"');
    expect(barrel).toContain("toast");
    expect(barrel).toContain("Toaster");
  });
});
