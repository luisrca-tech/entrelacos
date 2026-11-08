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
    publicUrl: "https://demo-cartas.entrelacosbr.site/",
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
  it.each(["production", "development"] as const)(
    "accepts only exact new and retained legacy URLs in %s",
    (environment) => {
      const suffix = environment === "development" ? "-dev" : "";
      for (const [id, host] of [
        ["demo-wedding", "demo-botanico"],
        ["demo-wedding-cartas", "demo-cartas"],
      ]) {
        const candidate = { id, repositorySlug: id, isDemo: true };
        for (const domain of ["entrelacosbr.site", "entrelacos.workers.dev"]) {
          const publicUrl = `https://${host}${suffix}.${domain}/`;
          expect(
            allowsShowcaseCatalog({ ...candidate, publicUrl }, environment),
          ).toBe(true);
          for (const invalid of [
            `${publicUrl}path`,
            publicUrl.replace("https:", "http:"),
            publicUrl.replace(".site/", ".site.attacker.test/"),
          ]) {
            if (invalid !== publicUrl)
              expect(
                allowsShowcaseCatalog(
                  { ...candidate, publicUrl: invalid },
                  environment,
                ),
              ).toBe(false);
          }
          expect(
            allowsShowcaseCatalog(
              { ...candidate, publicUrl },
              environment === "production" ? "development" : "production",
            ),
          ).toBe(false);
        }
      }
    },
  );
  it.each(["development", "production"] as const)(
    "preserves the original Botanical Worker URL in %s",
    (environment) => {
      const suffix = environment === "development" ? "-dev" : "";
      const identity = {
        id: "demo-wedding",
        isDemo: true,
        repositorySlug: "demo-wedding",
        publicUrl: `https://demo${suffix}.entrelacos.workers.dev/`,
      };
      expect(allowsShowcaseCatalog(identity, environment)).toBe(true);
      expect(
        allowsShowcaseCatalog(
          identity,
          environment === "production" ? "development" : "production",
        ),
      ).toBe(false);
      expect(
        allowsShowcaseCatalog(
          {
            ...identity,
            id: "demo-wedding-cartas",
            repositorySlug: "demo-wedding-cartas",
          },
          environment,
        ),
      ).toBe(false);
    },
  );
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
