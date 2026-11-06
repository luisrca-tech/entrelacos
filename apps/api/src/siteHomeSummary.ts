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
    // The home summary stays useful when the receiving status is unavailable:
    // financial fields are omitted and the remaining counts are still returned.
    receiving = await readReadiness(siteId).catch(() => undefined);
    if (receiving && receiving.siteId !== siteId)
      throw new Error("Unexpected readiness site");
  }

  const fields: SQL[] = [];
  if (capabilities.manageInvitations) {
    // One row per invitation; the group status mirrors the list filter in
    // listInvitationPage so the filter chips count what they will show.
    fields.push(sql`(
      select json_build_object(
        'total', count(*)::int,
        'confirmed', coalesce(sum(confirmed), 0)::int,
        'pending', coalesce(sum(pending), 0)::int,
        'declined', coalesce(sum(declined), 0)::int,
        'adults', coalesce(sum(adults), 0)::int,
        'children', coalesce(sum(children), 0)::int,
        'byStatus', json_build_object(
          'confirmed', count(*) filter (where status = 'CONFIRMED')::int,
          'pending', count(*) filter (where status = 'PENDING')::int,
          'declined', count(*) filter (where status = 'DECLINED')::int,
          'partial', count(*) filter (where status = 'PARTIAL')::int
        ),
        'guestsByStatus', json_build_object(
          'confirmed', json_build_object(
            'adults', coalesce(sum(confirmed_adults), 0)::int,
            'children', coalesce(sum(confirmed_children), 0)::int
          ),
          'pending', json_build_object(
            'adults', coalesce(sum(pending_adults), 0)::int,
            'children', coalesce(sum(pending_children), 0)::int
          ),
          'declined', json_build_object(
            'adults', coalesce(sum(declined_adults), 0)::int,
            'children', coalesce(sum(declined_children), 0)::int
          )
        )
      ) from (
        select
          count(g.id) filter (where g.rsvp_state = 'CONFIRMED') as confirmed,
          count(g.id) filter (where g.rsvp_state = 'PENDING') as pending,
          count(g.id) filter (where g.rsvp_state = 'DECLINED') as declined,
          count(g.id) filter (where g.guest_type = 'ADULT') as adults,
          count(g.id) filter (where g.guest_type = 'CHILD') as children,
          count(g.id) filter (where g.rsvp_state = 'CONFIRMED'
            and g.guest_type = 'ADULT') as confirmed_adults,
          count(g.id) filter (where g.rsvp_state = 'CONFIRMED'
            and g.guest_type = 'CHILD') as confirmed_children,
          count(g.id) filter (where g.rsvp_state = 'PENDING'
            and g.guest_type = 'ADULT') as pending_adults,
          count(g.id) filter (where g.rsvp_state = 'PENDING'
            and g.guest_type = 'CHILD') as pending_children,
          count(g.id) filter (where g.rsvp_state = 'DECLINED'
            and g.guest_type = 'ADULT') as declined_adults,
          count(g.id) filter (where g.rsvp_state = 'DECLINED'
            and g.guest_type = 'CHILD') as declined_children,
          case when count(distinct g.rsvp_state) > 1 then 'PARTIAL'
            else coalesce(min(g.rsvp_state::text), 'PENDING') end as status
        from invitation i
        left join invitation_guest g
          on g.site_id = i.site_id and g.invitation_id = i.id
        where i.site_id = ${siteId}
        group by i.id
      ) per_invitation
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
