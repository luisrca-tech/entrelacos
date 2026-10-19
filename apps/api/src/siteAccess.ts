import {
  adminRoleSchema,
  type SiteAccess,
  siteAccessSchema,
} from "@entrelacos/contracts";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export type SiteAccessDatabase = Pick<
  NodePgDatabase<Record<string, never>>,
  "execute"
>;
export type SiteAccessActor = {
  userId: string;
  role: SiteAccess["membershipRole"];
};
export type ResolveSiteAccessInput = {
  userId: string;
  platformRole: SiteAccessActor["role"];
  siteId: string;
};

export class SiteAccessDeniedError extends Error {
  readonly status = 403;
  readonly code = "MEMBERSHIP_DENIED";

  constructor() {
    super("Site membership denied");
    this.name = "SiteAccessDeniedError";
  }
}

type SiteAccessRow = {
  user_id: string;
  account_role: SiteAccessActor["role"];
  account_state: string;
  site_id: string;
  membership_id: string | null;
  membership_user_id: string | null;
  membership_role: string | null;
  revoked_at: Date | null;
};

const accessColumns = sql`
  u.id AS user_id, u.role AS account_role, u.state AS account_state,
  s.id AS site_id, sm.id AS membership_id, sm.user_id AS membership_user_id,
  sm.role AS membership_role, sm.revoked_at AS revoked_at
`;

function accessFromRow(
  row: SiteAccessRow | undefined,
  input: ResolveSiteAccessInput,
): SiteAccess | null {
  if (
    !row ||
    row.user_id !== input.userId ||
    row.site_id !== input.siteId ||
    row.account_role !== input.platformRole ||
    row.account_state !== "ACTIVE"
  ) {
    return null;
  }

  const owner = row.account_role === "OWNER";
  if (
    !owner &&
    (!row.membership_id ||
      row.membership_user_id !== input.userId ||
      row.revoked_at !== null ||
      (row.membership_role !== "SITE_ADMIN" &&
        row.membership_role !== "SITE_ASSISTANT"))
  ) {
    return null;
  }

  const siteAdmin = !owner && row.membership_role === "SITE_ADMIN";
  const parsed = siteAccessSchema.safeParse({
    siteId: row.site_id,
    userId: row.user_id,
    membershipId: owner ? null : row.membership_id,
    membershipRole: owner ? "OWNER" : row.membership_role,
    capabilities: {
      manageInvitations: true,
      manageMessages: true,
      manageCatalog: true,
      manageTeam: owner || siteAdmin,
      readFinance: owner || siteAdmin,
      configureReceiving: siteAdmin,
      // Withdrawal additionally requires designated-recipient and recent-auth evidence.
      requestWithdrawal: false,
    },
  });
  return parsed.success ? parsed.data : null;
}

export async function resolveSiteAccess(
  db: SiteAccessDatabase,
  input: ResolveSiteAccessInput,
): Promise<SiteAccess | null> {
  if (
    !siteAccessSchema.shape.userId.safeParse(input.userId).success ||
    !siteAccessSchema.shape.siteId.safeParse(input.siteId).success ||
    !adminRoleSchema.safeParse(input.platformRole).success
  ) {
    return null;
  }

  const result = await db.execute(sql`
    SELECT ${accessColumns}
    FROM "user" u
    INNER JOIN site s ON s.id = ${input.siteId}
    LEFT JOIN site_membership sm
      ON sm.user_id = u.id AND sm.site_id = s.id AND sm.revoked_at IS NULL
    WHERE u.id = ${input.userId}
      AND u.state = 'ACTIVE' AND u.role = ${input.platformRole}
  `);
  return accessFromRow(result.rows[0] as SiteAccessRow | undefined, input);
}

export async function requireSiteCapability(
  db: SiteAccessDatabase,
  actor: SiteAccessActor,
  siteId: string,
  capability: keyof SiteAccess["capabilities"],
): Promise<SiteAccess> {
  const access = await resolveSiteAccess(db, {
    userId: actor.userId,
    platformRole: actor.role,
    siteId,
  });
  if (access?.capabilities[capability] !== true) {
    throw new SiteAccessDeniedError();
  }
  return access;
}

export async function getAdministrativeMemberships(
  db: SiteAccessDatabase,
  userId: string,
): Promise<SiteAccess[]> {
  if (!siteAccessSchema.shape.userId.safeParse(userId).success) return [];
  const result = await db.execute(sql`
    SELECT ${accessColumns}
    FROM "user" u
    INNER JOIN site_membership sm
      ON sm.user_id = u.id AND sm.revoked_at IS NULL
    INNER JOIN site s ON s.id = sm.site_id
    WHERE u.id = ${userId} AND u.state = 'ACTIVE'
      AND u.role IN ('SITE_ADMIN', 'SITE_ASSISTANT')
    ORDER BY s.id
  `);
  return (result.rows as SiteAccessRow[]).flatMap((row) => {
    if (
      row.account_role !== "SITE_ADMIN" &&
      row.account_role !== "SITE_ASSISTANT"
    ) {
      return [];
    }
    const access = accessFromRow(row, {
      userId,
      platformRole: row.account_role,
      siteId: row.site_id,
    });
    return access ? [access] : [];
  });
}
