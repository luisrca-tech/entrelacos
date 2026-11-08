import { sql } from "drizzle-orm";
import type { GiftDatabase } from "./gifts";

type Environment = "development" | "test" | "production" | undefined;
export type ShowcaseCatalogIdentity = {
  id: string;
  isDemo: boolean;
  repositorySlug: string;
  publicUrl: string | null;
};

function showcaseOrigin(
  siteId: string,
  environment: Environment,
): string | null {
  if (environment !== "development" && environment !== "production")
    return null;
  const host =
    siteId === "demo-wedding"
      ? "demo-botanico"
      : siteId === "demo-wedding-cartas"
        ? "demo-cartas"
        : null;
  return host
    ? `https://${host}${environment === "development" ? "-dev" : ""}.entrelacosbr.site/`
    : null;
}

export function isShowcaseCatalogCandidate(
  siteId: string,
  environment: Environment,
): boolean {
  return showcaseOrigin(siteId, environment) !== null;
}

export function allowsShowcaseCatalog(
  identity: ShowcaseCatalogIdentity,
  environment: Environment,
): boolean {
  const origin = showcaseOrigin(identity.id, environment);
  // Keep exact legacy aliases during the staged domain migration.
  const legacyOrigin = origin?.replace(
    ".entrelacosbr.site/",
    ".entrelacos.workers.dev/",
  );
  const originalBotanicalOrigin =
    identity.id === "demo-wedding"
      ? legacyOrigin?.replace("https://demo-botanico", "https://demo")
      : undefined;
  return (
    origin !== null &&
    identity.isDemo === true &&
    identity.repositorySlug === identity.id &&
    (identity.publicUrl === origin ||
      identity.publicUrl === legacyOrigin ||
      identity.publicUrl === originalBotanicalOrigin)
  );
}

export async function readShowcaseCatalogAccess(
  db: GiftDatabase,
  siteId: string,
  environment: Environment,
) {
  if (!showcaseOrigin(siteId, environment)) return undefined;
  const result = await db.execute(sql`
    SELECT id, is_demo AS "isDemo", repository_slug AS "repositorySlug", public_url AS "publicUrl"
    FROM site WHERE id = ${siteId}
  `);
  const row = result.rows[0] as ShowcaseCatalogIdentity | undefined;
  return row?.id === siteId && allowsShowcaseCatalog(row, environment)
    ? { siteId, mode: "demonstration" as const }
    : undefined;
}
