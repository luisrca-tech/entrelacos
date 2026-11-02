import { describe, expect, it, vi } from "vitest";
import {
  allowsShowcaseCatalog,
  readShowcaseCatalogAccess,
} from "./showcaseCatalog";

describe("server showcase catalog identity", () => {
  const identity = {
    id: "demo-wedding-cartas",
    isDemo: true,
    repositorySlug: "demo-wedding-cartas",
    publicUrl: "https://demo-cartas.entrelacos.workers.dev/",
  };
  it("requires the exact identity and explicit environment", () => {
    expect(allowsShowcaseCatalog(identity, "production")).toBe(true);
    for (const environment of ["test", "development", undefined] as const)
      expect(allowsShowcaseCatalog(identity, environment)).toBe(false);
    for (const changes of [
      { isDemo: false },
      { repositorySlug: "customer" },
      { publicUrl: null },
      { id: "customer" },
    ])
      expect(
        allowsShowcaseCatalog({ ...identity, ...changes }, "production"),
      ).toBe(false);
  });
  it("never queries storage for arbitrary demos or unselected environments", async () => {
    const execute = vi.fn();
    const db = { execute } as never;
    expect(
      await readShowcaseCatalogAccess(db, "customer-demo", "production"),
    ).toBeUndefined();
    expect(
      await readShowcaseCatalogAccess(db, identity.id, undefined),
    ).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });
});
