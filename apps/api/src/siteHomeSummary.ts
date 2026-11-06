import {
  type ReceivingReadiness,
  type SiteAccess,
  siteHomeSummarySchema,
} from "@entrelacos/contracts";
import { type SQL, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { assertFinancialReadAccess } from "./financialAuthorization";

export async function readSiteHomeSummary(
  db: Pick<NodePgDatabase, "execute">,
  access: SiteAccess,
  readReadiness: (siteId: string) => Promise<ReceivingReadiness>,
) {
  const { siteId, capabilities } = access;
  let receiving: ReceivingReadiness | undefined;
  if (capabilities.readFinance) {
    assertFinancialReadAccess(access, siteId);
    receiving = await readReadiness(siteId);
    if (receiving.siteId !== siteId)
      throw new Error("Unexpected readiness site");
  }

  const fields: SQL[] = [];
  if (capabilities.manageInvitations) {
    fields.push(sql`(
      select json_build_object(
        'total', (select count(*)::int from invitation where site_id = ${siteId}),
        'confirmed', count(*) filter (where rsvp_state = 'CONFIRMED')::int,
        'pending', count(*) filter (where rsvp_state = 'PENDING')::int,
        'declined', count(*) filter (where rsvp_state = 'DECLINED')::int
      ) from invitation_guest where site_id = ${siteId}
    ) as invitations`);
  }
  if (capabilities.manageMessages) {
    fields.push(sql`(
      select count(*)::int from mural_message where site_id = ${siteId}
    ) as messages`);
  }
  if (capabilities.manageCatalog) {
    fields.push(sql`(
      select count(*)::int from gift_item
      where site_id = ${siteId} and publication_state = 'PUBLISHED'
    ) as "publishedGifts"`);
  }
  if (receiving && receiving.mode !== "disabled") {
    fields.push(sql`(
      select count(distinct order_id)::int from gift_payment_record
      where site_id = ${siteId} and environment = ${receiving.mode}
        and verification_status = 'VERIFIED' and provider_status = 'RECEIVED'
    ) as "receivedGifts"`);
  }
  if (capabilities.manageTeam) {
    fields.push(sql`(
      select count(*)::int from site_membership sm
      inner join "user" u on u.id = sm.user_id
      where sm.site_id = ${siteId} and sm.revoked_at is null and u.state = 'ACTIVE'
    ) as "peopleWithAccess"`);
  }
  const result = fields.length
    ? await db.execute(sql`select ${sql.join(fields, sql`, `)}`)
    : undefined;
  return siteHomeSummarySchema.parse({
    ...result?.rows[0],
    ...(receiving && { receiving }),
  });
}
