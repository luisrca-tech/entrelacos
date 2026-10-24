import { afterEach, describe, expect, it, vi } from "vitest";
import { showSandboxNotice } from "./applicationEnvironment";

afterEach(() => vi.unstubAllGlobals());
describe("application environment payment notices", () => {
  it.each([
    ["development", "sandbox", true],
    ["development", "live", false],
    ["production", "sandbox", false],
    ["production", "live", false],
    ["test", "sandbox", false],
    [undefined, "sandbox", false],
    ["development", "disabled", false],
  ])(
    "shows notices only for explicit development sandbox (%s, %s)",
    (environment, mode, expected) => {
      vi.stubGlobal("__APP_ENV__", environment);
      expect(showSandboxNotice(mode)).toBe(expected);
    },
  );
  it("defaults to no notice when no build environment is provided", () => {
    expect(showSandboxNotice("sandbox")).toBe(false);
  });
});
