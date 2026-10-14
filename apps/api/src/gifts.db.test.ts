import { randomUUID } from "node:crypto";
import type {
  GiftCreateInput,
  ReceivingReadiness,
} from "@entrelacos/contracts";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  giftItem,
  giftMediaAsset,
  giftMediaPublicationIntent,
  site,
  siteMembership,
  siteTerm,
  user,
} from "@entrelacos/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSiteGift,
  type GiftServiceOptions,
  listSiteGifts,
  lookupPublishedGift,
  readPublicGifts,
  reorderSiteGifts,
  updateSiteGift,
  updateSiteGiftPublication,
} from "./gifts";

const prefix = `gift-db-${process.pid}-${randomUUID()}`;
const now = new Date("2026-10-12T12:00:00.000Z");
const fixtures: Array<{ siteId: string; userId: string }> = [];
let connection: DatabaseConnection;

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function settleOperation<T>(
  promise: Promise<T>,
): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason }),
  );
}

async function fixture() {
  const siteId = randomUUID();
  const userId = `${prefix}-${randomUUID()}`;
  fixtures.push({ siteId, userId });
  await connection.db.insert(user).values({
    id: userId,
    name: "Catalog assistant fixture",
    email: `${userId}@example.test`,
    role: "SITE_ASSISTANT",
    state: "ACTIVE",
  });
  await connection.db.insert(site).values({
    id: siteId,
    repositorySlug: `${prefix}-${siteId}`,
    provisioningKey: `${prefix}:${siteId}`,
    displayName: "Catalog fixture",
    partnerOneName: "Ana",
    partnerTwoName: "João",
    eventDate: "2027-05-22",
    lifecycle: "ACTIVE",
    publicationState: "PUBLISHED",
    isDemo: true,
    createdAt: now,
    updatedAt: now,
  });
  await connection.db.insert(siteTerm).values({
    id: randomUUID(),
    siteId,
    startsOn: "2026-01-01",
    endsOn: "2027-01-01",
    approvedAt: now,
  });
  await connection.db.insert(siteMembership).values({
    id: randomUUID(),
    siteId,
    userId,
    role: "SITE_ASSISTANT",
  });
  // This explicit test-only projection does not claim provider readiness.
  const readiness: ReceivingReadiness = {
    siteId,
    state: "READY",
    reason: null,
    observedAt: now.toISOString(),
    destinationVersion: 1,
    catalogEligible: true,
    mode: "sandbox",
  };
  const options: GiftServiceOptions = {
    now: () => new Date(now),
    readReadiness: async (requestedSiteId) => {
      expect(requestedSiteId).toBe(siteId);
      return { ...readiness };
    },
  };
  return {
    siteId,
    userId,
    actor: { userId, role: "SITE_ASSISTANT" as const },
    readiness,
    options,
  };
}

function input(title = "Dinner"): GiftCreateInput {
  return {
    title,
    description: "A shared dinner",
    nominalCents: 12500,
    currency: "BRL",
    mediaAssetId: null,
    altText: "",
  };
}

async function finalizedMedia(siteId: string) {
  const id = randomUUID();
  const derivativeKey = `gifts/${siteId}/${id}/fixture.webp`;
  const [row] = await connection.db
    .insert(giftMediaAsset)
    .values({
      id,
      siteId,
      stagingKey: `staging/${siteId}/${id}/private_nonce`,
      declaredContentType: "image/png",
      declaredByteLength: 100,
      expiresAt: new Date(now.getTime() + 300_000),
      state: "FINALIZED",
      stableObjectVersion: '"fixture-version"',
      derivativeKey,
      publicUrl: `https://media.example.test/${derivativeKey}`,
      contentType: "image/webp",
      byteLength: 80,
      width: 2,
      height: 3,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row;
}

describe("gift catalog PostgreSQL service acceptance", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
  });

  afterAll(async () => {
    if (!connection) return;
    try {
      for (const { siteId, userId } of fixtures) {
        await connection.db.delete(giftItem).where(eq(giftItem.siteId, siteId));
        await connection.db
          .delete(giftMediaPublicationIntent)
          .where(eq(giftMediaPublicationIntent.siteId, siteId));
        await connection.db
          .delete(giftMediaAsset)
          .where(eq(giftMediaAsset.siteId, siteId));
        await connection.db
          .delete(siteMembership)
          .where(
            and(
              eq(siteMembership.siteId, siteId),
              eq(siteMembership.userId, userId),
            ),
          );
        await connection.db.delete(siteTerm).where(eq(siteTerm.siteId, siteId));
        await connection.db.delete(site).where(eq(site.id, siteId));
        await connection.db.delete(user).where(eq(user.id, userId));
      }
    } finally {
      await connection.close();
    }
  });

  it("persists create, update, publish, reorder and archive without changing gift identity", async () => {
    const f = await fixture();
    const first = await createSiteGift(
      connection.db,
      f.actor,
      f.siteId,
      input(),
      f.options,
    );
    const second = await createSiteGift(
      connection.db,
      f.actor,
      f.siteId,
      input("Trip"),
      f.options,
    );
    expect(first.gift).toMatchObject({
      siteId: f.siteId,
      publicationState: "DRAFT",
      sortOrder: 0,
    });
    expect(second.gift.sortOrder).toBe(1);
    await expect(
      readPublicGifts(connection.db, f.siteId, f.options),
    ).resolves.toEqual({
      siteId: f.siteId,
      mode: "sandbox",
      gifts: [],
      page: 1,
      pageSize: 20,
      q: "",
      total: 0,
      totalPages: 1,
      hasNext: false,
    });

    const edited = await updateSiteGift(
      connection.db,
      f.actor,
      f.siteId,
      first.gift.id,
      { title: "Updated dinner", nominalCents: 15000 },
      f.options,
    );
    const published = await updateSiteGiftPublication(
      connection.db,
      f.actor,
      f.siteId,
      first.gift.id,
      { publicationState: "PUBLISHED" },
      f.options,
    );
    expect(published.gift.id).toBe(first.gift.id);
    expect(published.gift.createdAt).toBe(first.gift.createdAt);
    expect(
      (
        await lookupPublishedGift(
          connection.db,
          f.siteId,
          first.gift.id,
          f.options,
        )
      ).title,
    ).toBe(edited.gift.title);

    const ordered = await reorderSiteGifts(
      connection.db,
      f.actor,
      f.siteId,
      { giftIds: [second.gift.id, first.gift.id] },
      f.options,
    );
    expect(ordered.gifts.map((gift) => [gift.id, gift.sortOrder])).toEqual([
      [second.gift.id, 0],
      [first.gift.id, 1],
    ]);
    await updateSiteGiftPublication(
      connection.db,
      f.actor,
      f.siteId,
      first.gift.id,
      { publicationState: "ARCHIVED" },
      f.options,
    );
    const reordered = await reorderSiteGifts(
      connection.db,
      f.actor,
      f.siteId,
      { giftIds: [second.gift.id] },
      f.options,
    );
    expect(
      reordered.gifts.find((gift) => gift.id === first.gift.id)
        ?.publicationState,
    ).toBe("ARCHIVED");
    await expect(
      lookupPublishedGift(connection.db, f.siteId, first.gift.id, f.options),
    ).rejects.toMatchObject({ code: "GIFT_NOT_FOUND" });
    const rows = await connection.db
      .select()
      .from(giftItem)
      .where(eq(giftItem.siteId, f.siteId));
    expect(rows).toHaveLength(2);
    expect(rows.find((gift) => gift.id === first.gift.id)).toMatchObject({
      nominalCents: 15000,
      title: "Updated dinner",
      publicationState: "ARCHIVED",
    });
  });

  it("serializes concurrent creates and rejects partial or foreign reorder lists without writes", async () => {
    const f = await fixture();
    const other = await fixture();
    const created = await Promise.all([
      createSiteGift(connection.db, f.actor, f.siteId, input("One"), f.options),
      createSiteGift(connection.db, f.actor, f.siteId, input("Two"), f.options),
    ]);
    expect(created.map(({ gift }) => gift.sortOrder).sort()).toEqual([0, 1]);
    const foreign = await createSiteGift(
      connection.db,
      other.actor,
      other.siteId,
      input("Foreign"),
      other.options,
    );
    const before = await listSiteGifts(
      connection.db,
      f.actor,
      f.siteId,
      f.options,
    );
    for (const giftIds of [
      [created[0].gift.id],
      [created[0].gift.id, foreign.gift.id],
    ]) {
      await expect(
        reorderSiteGifts(
          connection.db,
          f.actor,
          f.siteId,
          { giftIds },
          f.options,
        ),
      ).rejects.toMatchObject({ code: "GIFT_REORDER_CONFLICT" });
    }
    expect(
      await listSiteGifts(connection.db, f.actor, f.siteId, f.options),
    ).toEqual(before);
    await expect(
      updateSiteGift(
        connection.db,
        f.actor,
        f.siteId,
        foreign.gift.id,
        { title: "Cross-site" },
        f.options,
      ),
    ).rejects.toMatchObject({ code: "GIFT_NOT_FOUND" });
  });

  it("returns only finalized public media and rejects foreign or pending media associations", async () => {
    const f = await fixture();
    const other = await fixture();
    const media = await finalizedMedia(f.siteId);
    const foreign = await finalizedMedia(other.siteId);
    await expect(
      createSiteGift(
        connection.db,
        f.actor,
        f.siteId,
        { ...input(), mediaAssetId: foreign.id, altText: "Foreign" },
        f.options,
      ),
    ).rejects.toMatchObject({ code: "GIFT_MEDIA_INVALID" });
    const created = await createSiteGift(
      connection.db,
      f.actor,
      f.siteId,
      { ...input(), mediaAssetId: media.id, altText: "Shared dinner image" },
      f.options,
    );
    await updateSiteGiftPublication(
      connection.db,
      f.actor,
      f.siteId,
      created.gift.id,
      { publicationState: "PUBLISHED" },
      f.options,
    );
    const page = await readPublicGifts(connection.db, f.siteId, f.options);
    expect(page.gifts).toEqual([
      {
        id: created.gift.id,
        siteId: f.siteId,
        title: "Dinner",
        description: "A shared dinner",
        nominalCents: 12500,
        currency: "BRL",
        image: { url: media.publicUrl, alt: "Shared dinner image" },
        sortOrder: 0,
      },
    ]);
    const serialized = JSON.stringify(page);
    for (const privateValue of [
      media.stagingKey,
      media.stableObjectVersion,
      "derivativeKey",
      "mediaAssetId",
      "createdAt",
      "publicationState",
      "processingId",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    await connection.db
      .update(giftMediaAsset)
      .set({ state: "PENDING" })
      .where(eq(giftMediaAsset.id, media.id));
    await expect(
      readPublicGifts(connection.db, f.siteId, f.options),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", status: 503 });
    await expect(
      updateSiteGift(
        connection.db,
        f.actor,
        f.siteId,
        created.gift.id,
        { altText: "Pending image" },
        f.options,
      ),
    ).rejects.toMatchObject({ code: "GIFT_MEDIA_INVALID" });
    expect(
      (
        await connection.db
          .select()
          .from(giftItem)
          .where(eq(giftItem.id, created.gift.id))
      )[0].altText,
    ).toBe("Shared dinner image");
  });

  it.each(["term", "site", "user", "membership", "readiness"] as const)(
    "rechecks current %s after the initial capability check",
    async (change) => {
      const f = await fixture();
      const created = await createSiteGift(
        connection.db,
        f.actor,
        f.siteId,
        input(),
        f.options,
      );
      let observations = 0;
      const options: GiftServiceOptions = {
        ...f.options,
        readReadiness: async () => {
          const snapshot = { ...f.readiness };
          if (++observations === 1) {
            if (change === "term")
              await connection.db
                .update(siteTerm)
                .set({ endsOn: "2026-10-11" })
                .where(eq(siteTerm.siteId, f.siteId));
            if (change === "site")
              await connection.db
                .update(site)
                .set({ lifecycle: "INACTIVE", previousLifecycle: "ACTIVE" })
                .where(eq(site.id, f.siteId));
            if (change === "user")
              await connection.db
                .update(user)
                .set({ state: "DISABLED" })
                .where(eq(user.id, f.userId));
            if (change === "membership")
              await connection.db
                .update(siteMembership)
                .set({ revokedAt: now })
                .where(
                  and(
                    eq(siteMembership.siteId, f.siteId),
                    eq(siteMembership.userId, f.userId),
                  ),
                );
            if (change === "readiness")
              Object.assign(f.readiness, {
                state: "BLOCKED",
                reason: "EVIDENCE_STALE",
                catalogEligible: false,
              });
          }
          return snapshot;
        },
      };
      const codes = {
        term: "SITE_EXPIRED",
        site: "SITE_INACTIVE",
        user: "MEMBERSHIP_DENIED",
        membership: "MEMBERSHIP_DENIED",
        readiness: "RECEIVING_NOT_READY",
      };
      await expect(
        updateSiteGift(
          connection.db,
          f.actor,
          f.siteId,
          created.gift.id,
          { title: "Must not persist" },
          options,
        ),
      ).rejects.toMatchObject({ code: codes[change] });
      expect(
        (
          await connection.db
            .select()
            .from(giftItem)
            .where(eq(giftItem.id, created.gift.id))
        )[0].title,
      ).toBe("Dinner");
    },
  );

  it("reads the committed term after an actual PostgreSQL site lock wait", async () => {
    const f = await fixture();
    const locked = gate();
    const release = gate();
    let blockerPid = 0;
    let blocker: Promise<PromiseSettledResult<void>> | undefined;
    let pending:
      | Promise<
          PromiseSettledResult<Awaited<ReturnType<typeof createSiteGift>>>
        >
      | undefined;
    try {
      blocker = settleOperation(
        connection.db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT id FROM site WHERE id = ${f.siteId} FOR UPDATE`,
          );
          blockerPid = Number(
            (await tx.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0].pid,
          );
          locked.release();
          await release.promise;
          await tx
            .update(siteTerm)
            .set({ endsOn: "2026-10-11" })
            .where(eq(siteTerm.siteId, f.siteId));
        }),
      );
      await Promise.race([
        locked.promise,
        blocker.then((result) => {
          if (result.status === "rejected") throw result.reason;
          throw new Error("Site lock blocker settled before readiness");
        }),
      ]);
      pending = settleOperation(
        createSiteGift(connection.db, f.actor, f.siteId, input(), f.options),
      );
      let waiting = false;
      // Observe the server lock wait, without guessing timing with a sleep.
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const result = await connection.pool.query<{ waiting: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid))) AS waiting",
          [blockerPid],
        );
        waiting = result.rows[0].waiting;
      }
      expect(waiting).toBe(true);
    } finally {
      release.release();
      await Promise.allSettled([blocker, pending]);
    }
    const blockerResult = await blocker;
    if (blockerResult?.status === "rejected") throw blockerResult.reason;
    if (blockerResult?.status !== "fulfilled")
      throw new Error("Expected committed site lock blocker");
    const pendingResult = await pending;
    if (pendingResult?.status !== "rejected")
      throw new Error("Expected site expiry after the committed term change");
    expect(pendingResult.reason).toMatchObject({ code: "SITE_EXPIRED" });
    expect(
      await connection.db
        .select()
        .from(giftItem)
        .where(eq(giftItem.siteId, f.siteId)),
    ).toEqual([]);
  });

  it("requires current publication and term for public reads", async () => {
    const f = await fixture();
    const created = await createSiteGift(
      connection.db,
      f.actor,
      f.siteId,
      input(),
      f.options,
    );
    await updateSiteGiftPublication(
      connection.db,
      f.actor,
      f.siteId,
      created.gift.id,
      { publicationState: "PUBLISHED" },
      f.options,
    );
    await connection.db
      .update(site)
      .set({ publicationState: "UNPUBLISHED" })
      .where(eq(site.id, f.siteId));
    await expect(
      readPublicGifts(connection.db, f.siteId, f.options),
    ).rejects.toMatchObject({ code: "SITE_INELIGIBLE" });
    await connection.db
      .update(site)
      .set({ publicationState: "PUBLISHED" })
      .where(eq(site.id, f.siteId));
    await connection.db
      .update(siteTerm)
      .set({ endsOn: "2026-10-11" })
      .where(eq(siteTerm.siteId, f.siteId));
    await expect(
      lookupPublishedGift(connection.db, f.siteId, created.gift.id, f.options),
    ).rejects.toMatchObject({ code: "SITE_INELIGIBLE" });
  });
});
