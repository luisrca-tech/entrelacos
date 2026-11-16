import { siteIdSchema } from "@entrelacos/contracts";
import { type SQL, sql } from "drizzle-orm";

export interface LiveSitePolicy {
  /** Demo sites explicitly opted into live production receiving. */
  readonly liveDemoSiteIds?: readonly string[];
}

function validSiteIds(ids: unknown): string[] {
  return Array.isArray(ids)
    ? ids.filter(
        (id): id is string =>
          typeof id === "string" && siteIdSchema.safeParse(id).success,
      )
    : [];
}

export function allowsLiveSite(
  input: LiveSitePolicy & {
    siteId: string;
    isDemo: boolean;
    mode: "disabled" | "sandbox" | "live";
    applicationEnvironment: "development" | "test" | "production";
  },
): boolean {
  return (
    input.mode === "live" &&
    input.applicationEnvironment === "production" &&
    siteIdSchema.safeParse(input.siteId).success &&
    (input.isDemo === false ||
      (input.isDemo === true &&
        validSiteIds(input.liveDemoSiteIds).includes(input.siteId)))
  );
}

/** The configured showcases this runtime may actually serve live (empty outside live production). */
export function allowedLiveDemoSiteIds(
  input: LiveSitePolicy & {
    mode: "disabled" | "sandbox" | "live";
    applicationEnvironment: "development" | "test" | "production";
  },
): readonly string[] {
  return validSiteIds(input.liveDemoSiteIds).filter((siteId) =>
    allowsLiveSite({ ...input, siteId, isDemo: true }),
  );
}

/** The opted-in showcases as one bound `text[]` parameter, for `st.id = ANY(...)`. */
export function liveDemoSiteIdsSql(ids: readonly string[] | undefined): SQL {
  return sql`${sql.param(validSiteIds(ids))}::text[]`;
}

/** Runtime guard for configuration objects captured from untrusted shapes. */
export function isLiveDemoSiteIds(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (id) => typeof id === "string" && siteIdSchema.safeParse(id).success,
    )
  );
}
