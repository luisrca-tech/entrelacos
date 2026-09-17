import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { siteAdminMenuActions } from "./siteAdminMenu";

describe("site admin overflow actions", () => {
  it("offers issue, revoke, and disable for a pending administrator", () => {
    expect(siteAdminMenuActions("PENDING")).toEqual([
      {
        id: "issue-access",
        label: "Gerar link de ativação",
      },
      { id: "revoke-access", label: "Revogar link" },
      {
        id: "disable-access",
        label: "Desativar acesso",
        variant: "destructive",
      },
    ]);
  });

  it("labels the issue action as recovery for an active administrator", () => {
    expect(siteAdminMenuActions("ACTIVE")[0]).toEqual({
      id: "issue-access",
      label: "Gerar link de recuperação",
    });
  });

  it("hides overflow actions for a disabled administrator", () => {
    expect(siteAdminMenuActions("DISABLED")).toEqual([]);
  });

  it("renders administrator actions through the overflow menu", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "SiteWorkspace.tsx"),
      "utf8",
    );
    expect(source).toContain("OverflowMenu");
    expect(source).toContain("siteAdminMenuActions");
    expect(source).not.toContain("Gerar link de ativação");
  });
});
