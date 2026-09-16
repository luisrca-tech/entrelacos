import { describe, expect, it } from "vitest";
import { missingWorkspaceEntries } from "../../scripts/workspaceGate";

describe("workspace discovery CI gate", () => {
  it("accepts every discovered workspace present in the frozen lockfile", () => {
    expect(
      missingWorkspaceEntries(
        ["apps/admin", "apps/api", "packages/contracts"],
        `"apps/admin": {}, "apps/api": {}, "packages/contracts": {}`,
      ),
    ).toEqual([]);
  });

  it("reports a nested workspace omitted from the lockfile", () => {
    expect(
      missingWorkspaceEntries(
        ["apps/admin", "apps/template-fixture", "packages/contracts"],
        `"apps/admin": {}, "packages/contracts": {}`,
      ),
    ).toEqual(["apps/template-fixture"]);
  });
});
