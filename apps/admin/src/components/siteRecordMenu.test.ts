import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { siteRecordMenuActions } from "./siteRecordMenu";

describe("site record overflow actions", () => {
  it("offers profile, dates, and publication edits", () => {
    expect(siteRecordMenuActions).toEqual([
      { id: "profile", label: "Editar cadastro" },
      { id: "dates", label: "Editar datas" },
      { id: "publication", label: "Registrar publicação" },
    ]);
  });

  it("renders record actions through the overflow menu", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "SiteWorkspace.tsx"),
      "utf8",
    );
    expect(source).toContain("siteRecordMenuActions");
    expect(source).toContain("OverflowMenu");
    expect(source).not.toMatch(
      /setSettingsDialog\("profile"\)[\s\S]*Editar cadastro/,
    );
  });
});
