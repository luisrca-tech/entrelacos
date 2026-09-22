import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { guestGroup } from "./schema";

const migrationsDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

function migrationSql(): string {
  return readdirSync(migrationsDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()
    .map((name) => readFileSync(join(migrationsDirectory, name), "utf8"))
    .join("\n");
}

describe("individual guest group kind", () => {
  it("declares isIndividual on guest groups", () => {
    expect(guestGroup.isIndividual).toBeDefined();
  });

  it("backfills existing one-member groups as individual invitations", () => {
    const sql = migrationSql();
    expect(sql).toContain('ADD COLUMN "is_individual"');
    expect(sql).toContain('SET "is_individual" = true');
    expect(sql).toContain("HAVING COUNT(*) = 1");
  });
});
