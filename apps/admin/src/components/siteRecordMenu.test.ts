import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("offers publication registration as the primary action in its own section", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "SiteSettingsView.tsx"),
    "utf8",
  );
  const publication = source.slice(
    source.indexOf('tab === "publication"'),
    source.indexOf('tab === "address"'),
  );
  expect(publication).toContain("Registrar publicação");
  expect(publication).toContain('onEditRecord("publication")');
  expect(publication).not.toContain("OverflowMenu");
});
