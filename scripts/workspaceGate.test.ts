import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyWorkspaceDiscovery } from "./workspaceGate";

const roots: string[] = [];
function fixture(
  workspaces = ["apps/*", "packages/*", "packages/templates/*"],
) {
  const root = mkdtempSync(join(tmpdir(), "entrelacos-workspaces-"));
  roots.push(root);
  mkdirSync(join(root, "apps"));
  mkdirSync(join(root, "packages/templates"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces }));
  writeFileSync(join(root, "bun.lock"), "{}");
  return root;
}
function addPackage(root: string, path: string, name: string) {
  mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, path, "package.json"), JSON.stringify({ name }));
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
describe("nested template workspace discovery", () => {
  it("detects a template missing from the lockfile", () => {
    const root = fixture();
    addPackage(
      root,
      "packages/templates/cartas-do-nosso-sim",
      "@entrelacos/template-cartas-do-nosso-sim",
    );
    expect(verifyWorkspaceDiscovery(root)).toContain(
      "packages/templates/cartas-do-nosso-sim: workspace is absent from bun.lock",
    );
  });
  it("rejects duplicate package identities across flat and nested workspaces", () => {
    const root = fixture();
    addPackage(root, "packages/ui", "@entrelacos/duplicate");
    addPackage(
      root,
      "packages/templates/cartas-do-nosso-sim",
      "@entrelacos/duplicate",
    );
    expect(verifyWorkspaceDiscovery(root)).toContain(
      "packages/ui: duplicate package name @entrelacos/duplicate",
    );
  });
  it("requires the nested template glob even if the lockfile includes the package", () => {
    const root = fixture(["apps/*", "packages/*"]);
    expect(verifyWorkspaceDiscovery(root).join("\n")).toContain(
      "packages/templates/*",
    );
  });
  it("accepts correctly declared and locked nested workspaces", () => {
    const root = fixture();
    addPackage(
      root,
      "packages/templates/cinema-botanico",
      "@entrelacos/template-cinema-botanico",
    );
    writeFileSync(
      join(root, "bun.lock"),
      '{"packages/templates/cinema-botanico": {}}',
    );
    expect(verifyWorkspaceDiscovery(root)).toEqual([]);
  });
});
