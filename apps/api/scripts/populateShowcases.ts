import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  createDatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import { decodeGiftImage } from "../src/giftImageDecoder";
import { readGiftMediaConfig } from "../src/giftMediaConfig";
import { createR2GiftMediaStorage } from "../src/giftMediaStorage";
import { normalizeInvitationName } from "../src/invitations";
import {
  assertShowcaseSource,
  showcaseConfiguration,
  showcaseFamilies,
  showcaseGifts,
  showcaseMessages,
} from "../src/showcaseData";

export async function populateShowcases(env: NodeJS.ProcessEnv) {
  const config = showcaseConfiguration(
    env.ENTRELACOS_DATABASE_TARGET ?? "",
    env.ENTRELACOS_SHOWCASE_CONFIRM ?? "",
    env.ENTRELACOS_PRODUCTION_SHOWCASE_AUTHORIZED ===
      "POPULATE production showcases",
  );
  if (env.APP_ENV !== config.target)
    throw new Error("Application and database target must match");
  const mediaConfig = readGiftMediaConfig(env, config.target);
  if (mediaConfig.mode !== "r2")
    throw new Error("Configured showcase media storage is required");
  const connection = createDatabaseConnection({ target: config.target, env });
  const storage = createR2GiftMediaStorage(mediaConfig);
  try {
    const client = await connection.pool.connect();
    let inTransaction = false;
    try {
      await verifyDatabaseConnection(connection);
      await client.query("BEGIN");
      inTransaction = true;
      await client.query("SET LOCAL lock_timeout = '8s'");
      await client.query("SET LOCAL statement_timeout = '20s'");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('entrelacos:showcase:v1',0))",
      );
      const source = (
        await client.query(
          "SELECT *,to_char(event_date,'YYYY-MM-DD') AS event_date FROM site WHERE id=$1 FOR UPDATE",
          [config.botanicalSiteId],
        )
      ).rows[0];
      assertShowcaseSource(source, config);
      const managers = (
        await client.query(
          "SELECT m.user_id,m.role,m.invited_by_user_id FROM site_membership m JOIN \"user\" u ON u.id=m.user_id WHERE m.site_id=$1 AND m.revoked_at IS NULL AND u.state='ACTIVE' ORDER BY m.user_id",
          [config.botanicalSiteId],
        )
      ).rows;
      if (!managers.length)
        throw new Error("Existing showcase must have active site managers");
      const term = (
        await client.query(
          "SELECT to_char(starts_on,'YYYY-MM-DD') AS starts_on,to_char(ends_on,'YYYY-MM-DD') AS ends_on FROM site_term WHERE site_id=$1",
          [config.botanicalSiteId],
        )
      ).rows[0];
      if (!term || new Date().toISOString().slice(0, 10) > term.ends_on)
        throw new Error("Existing showcase must have a current approved term");

      // These fingerprints prove the run preserves pre-existing operational rows.
      const preservedTables = [
        "invitation",
        "invitation_guest",
        "mural_message",
        "gift_item",
        "site_membership",
      ];
      const fingerprint = async (table: string) =>
        (
          await client.query(
            `SELECT md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY id),'')) AS hash FROM ${table} t WHERE site_id=$1 AND id NOT LIKE 'showcase-v1:%'`,
            [config.botanicalSiteId],
          )
        ).rows[0].hash;
      const original: string[] = [];
      for (const table of preservedTables)
        original.push(await fingerprint(table));

      await client.query(
        `INSERT INTO site (id,repository_slug,provisioning_key,display_name,partner_one_name,partner_two_name,event_date,lifecycle,publication_state,is_demo,public_url,mural_enabled,review_approved_at)
       VALUES ($1,'demo-wedding-cartas','repo:demo-wedding-cartas','Marina & Caio — Cartas do Nosso Sim','Marina','Caio','2027-09-18','ACTIVE','PUBLISHED',true,$2,true,now()) ON CONFLICT (id) DO NOTHING`,
        [config.lettersSiteId, `${config.lettersOrigin}/`],
      );
      const letters = (
        await client.query(
          "SELECT *,to_char(event_date,'YYYY-MM-DD') AS event_date FROM site WHERE id=$1 FOR UPDATE",
          [config.lettersSiteId],
        )
      ).rows[0];
      assertShowcaseSource(
        {
          ...letters,
          id: config.botanicalSiteId,
          repository_slug: "demo-wedding",
          public_url: `${config.botanicalOrigin}/`,
        },
        config,
      );
      if (
        letters.repository_slug !== "demo-wedding-cartas" ||
        letters.provisioning_key !== "repo:demo-wedding-cartas" ||
        letters.public_url !== `${config.lettersOrigin}/`
      )
        throw new Error("Letters showcase conflicts with existing data");
      await client.query(
        "INSERT INTO site_term (id,site_id,starts_on,ends_on,approved_at) VALUES ($1,$2,$3,$4,now()) ON CONFLICT(site_id) DO NOTHING",
        [
          `showcase-v1:${config.lettersSiteId}:term`,
          config.lettersSiteId,
          term.starts_on,
          term.ends_on,
        ],
      );
      for (const origin of [
        config.lettersOrigin,
        ...(config.target === "development" ? ["http://localhost:4322"] : []),
      ]) {
        await client.query(
          "INSERT INTO site_origin(id,site_id,origin) VALUES($1,$2,$3) ON CONFLICT(origin) DO NOTHING",
          [
            `showcase-v1:${config.lettersSiteId}:origin:${createHash("sha256").update(origin).digest("hex").slice(0, 12)}`,
            config.lettersSiteId,
            origin,
          ],
        );
        const match = (
          await client.query(
            "SELECT site_id FROM site_origin WHERE origin=$1",
            [origin],
          )
        ).rows[0];
        if (match?.site_id !== config.lettersSiteId)
          throw new Error("Showcase origin belongs to another site");
      }
      for (const manager of managers) {
        await client.query(
          "INSERT INTO site_membership(id,site_id,user_id,role,invited_by_user_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(site_id,user_id) DO NOTHING",
          [
            `showcase-v1:${config.lettersSiteId}:manager:${manager.user_id}`,
            config.lettersSiteId,
            manager.user_id,
            manager.role,
            manager.invited_by_user_id,
          ],
        );
        const match = (
          await client.query(
            "SELECT role,revoked_at FROM site_membership WHERE site_id=$1 AND user_id=$2",
            [config.lettersSiteId, manager.user_id],
          )
        ).rows[0];
        if (match.role !== manager.role || match.revoked_at !== null)
          throw new Error(
            "Existing Letters membership conflicts; no access was restored",
          );
      }

      for (const siteId of [config.botanicalSiteId, config.lettersSiteId]) {
        for (const family of showcaseFamilies) {
          const id = `showcase-v1:${siteId}:family:${family.slug}`;
          await client.query(
            "INSERT INTO invitation(id,site_id,name,normalized_name,phone_e164,manual_pin_seed) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING",
            [
              id,
              siteId,
              family.name,
              normalizeInvitationName(family.name),
              family.phone,
              randomBytes(32).toString("hex"),
            ],
          );
          for (const [index, guest] of family.guests.entries()) {
            const guestId = `showcase-v1:${siteId}:guest:${family.slug}:${index}`;
            const added = await client.query(
              "INSERT INTO invitation_guest(id,site_id,invitation_id,full_name,normalized_name,guest_type) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING RETURNING id",
              [
                guestId,
                siteId,
                id,
                guest.name,
                normalizeInvitationName(guest.name),
                guest.type,
              ],
            );
            // Initial example confirmations retain the same audit trail the Dashboard displays.
            if (added.rowCount && guest.state !== "PENDING") {
              await client.query(
                "UPDATE invitation_guest SET rsvp_state=$1,rsvp_revision=1 WHERE id=$2 AND site_id=$3",
                [guest.state, guestId, siteId],
              );
              await client.query(
                "INSERT INTO rsvp_history(id,site_id,invitation_id,guest_id,invitation_name,guest_display_name,before_state,after_state,actor_type,actor_id,actor_display_name) VALUES($1,$2,$3,$4,$5,$6,'PENDING',$7,'ADMIN',$8,'EntreLaços · dados de exemplo')",
                [
                  `showcase-v1:${siteId}:history:${family.slug}:${index}`,
                  siteId,
                  id,
                  guestId,
                  family.name,
                  guest.name,
                  guest.state,
                  managers[0].user_id,
                ],
              );
            }
          }
        }
        for (const [index, message] of showcaseMessages.entries()) {
          await client.query(
            "INSERT INTO mural_message(id,site_id,author_name,text,created_at) VALUES($1,$2,$3,$4,now()-($5::int*interval '1 day')) ON CONFLICT(id) DO NOTHING",
            [
              `showcase-v1:${siteId}:message:${message.slug}`,
              siteId,
              message.author,
              message.text,
              showcaseMessages.length - index,
            ],
          );
        }
        const maximum = Number(
          (
            await client.query(
              "SELECT coalesce(max(sort_order),-1) AS maximum FROM gift_item WHERE site_id=$1",
              [siteId],
            )
          ).rows[0].maximum,
        );
        for (const [index, gift] of showcaseGifts.entries()) {
          const id = `showcase-v1:${siteId}:gift:${gift.slug}`;
          const existing = (
            await client.query("SELECT site_id FROM gift_item WHERE id=$1", [
              id,
            ])
          ).rows[0];
          if (existing) {
            if (existing.site_id !== siteId)
              throw new Error("Showcase gift identity conflict");
            continue;
          }
          const response = await fetch(
            `https://images.unsplash.com/${gift.photo}?fm=jpg&w=1200&fit=crop&q=82`,
            { signal: AbortSignal.timeout(15000) },
          );
          if (!response.ok)
            throw new Error("Licensed showcase image download failed");
          const image = await decodeGiftImage(
            new Uint8Array(await response.arrayBuffer()),
            "image/jpeg",
          );
          const hash = createHash("sha256").update(image.bytes).digest("hex");
          const assetId = `showcase-v1:${siteId}:media:${gift.slug}`;
          const derivativeKey = `gifts/${siteId}/${assetId}/${hash}.webp`;
          // The existing storage boundary enforces immutable, conditional publication.
          const published = await storage.publishDerivative(
            derivativeKey,
            image.bytes,
          );
          const head = await storage.headDerivative(derivativeKey);
          if (head.byteLength !== image.byteLength)
            throw new Error("Showcase media verification failed");
          await client.query(
            `INSERT INTO gift_media_asset(id,site_id,staging_key,expires_at,stable_object_version,state,derivative_key,public_url,content_type,byte_length,width,height)
           VALUES($1,$2,$3,now()+interval '1 day',$4,'FINALIZED',$5,$6,'image/webp',$7,$8,$9) ON CONFLICT(id) DO NOTHING`,
            [
              assetId,
              siteId,
              `showcase-original/${siteId}/${gift.slug}`,
              head.etag,
              derivativeKey,
              published.url,
              image.byteLength,
              image.width,
              image.height,
            ],
          );
          await client.query(
            "INSERT INTO gift_item(id,site_id,title,description,nominal_cents,currency,media_asset_id,alt_text,sort_order,publication_state) VALUES($1,$2,$3,$4,$5,'BRL',$6,$7,$8,'PUBLISHED')",
            [
              id,
              siteId,
              gift.title,
              gift.description,
              gift.cents,
              assetId,
              gift.alt,
              maximum + 1 + index,
            ],
          );
        }
      }
      const after: string[] = [];
      for (const table of preservedTables) after.push(await fingerprint(table));
      if (original.some((hash, index) => hash !== after[index]))
        throw new Error("Population changed existing operational data");
      const counts = await client.query(
        `SELECT s.id,
      (SELECT count(*)::int FROM invitation i WHERE i.site_id=s.id) AS invitations,
      (SELECT count(*)::int FROM invitation_guest g WHERE g.site_id=s.id) AS guests,
      (SELECT count(*)::int FROM mural_message m WHERE m.site_id=s.id) AS messages,
      (SELECT count(*)::int FROM gift_item g WHERE g.site_id=s.id) AS gifts
      FROM site s WHERE s.id=ANY($1::text[]) ORDER BY s.id`,
        [[config.botanicalSiteId, config.lettersSiteId]],
      );
      await client.query("COMMIT");
      inTransaction = false;
      return {
        target: config.target,
        managersCopied: managers.length,
        sites: counts.rows,
        financialConfiguration: "unchanged",
      };
    } catch (error) {
      if (inTransaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    try {
      await storage.close();
    } finally {
      await connection.close();
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  populateShowcases(process.env)
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error(
        "Showcase population failed; database changes were rolled back. Inspect configuration and conflicts without printing secrets.",
      );
      process.exitCode = 1;
    });
}
