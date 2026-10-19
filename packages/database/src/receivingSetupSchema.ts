import { sql } from "drizzle-orm";
import {
  check,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { site, user } from "./schema";

// Designation is set once by the platform owner. Consent is an independent holder action.
export const receivingSetupHolder = pgTable(
  "receiving_setup_holder",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id")
      .notNull()
      .references(() => site.id),
    environment: text("environment").notNull(),
    holderUserId: text("holder_user_id")
      .notNull()
      .references(() => user.id),
    designatedByUserId: text("designated_by_user_id")
      .notNull()
      .references(() => user.id),
    designatedAt: timestamp("designated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    consentId: text("consent_id"),
    consentVersion: text("consent_version"),
    consentAt: timestamp("consent_at", { withTimezone: true }),
    consentSessionId: text("consent_session_id"),
    consentAuthenticatedAt: timestamp("consent_authenticated_at", {
      withTimezone: true,
    }),
  },
  (table) => [
    uniqueIndex("receiving_setup_holder_site_environment_idx").on(
      table.siteId,
      table.environment,
    ),
    check(
      "receiving_setup_holder_environment_check",
      sql`${table.environment} IN ('sandbox', 'live')`,
    ),
    check(
      "receiving_setup_holder_consent_check",
      sql`(${table.consentId} IS NULL AND ${table.consentVersion} IS NULL AND ${table.consentAt} IS NULL AND ${table.consentSessionId} IS NULL AND ${table.consentAuthenticatedAt} IS NULL) OR (${table.consentId} IS NOT NULL AND ${table.consentVersion} IS NOT NULL AND ${table.consentAt} IS NOT NULL AND ${table.consentSessionId} IS NOT NULL AND ${table.consentAuthenticatedAt} IS NOT NULL AND ${table.consentAt} >= ${table.designatedAt} AND ${table.consentAuthenticatedAt} <= ${table.consentAt})`,
    ),
  ],
);
