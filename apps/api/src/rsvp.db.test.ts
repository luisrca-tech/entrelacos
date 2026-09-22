import { randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import { invitationSession, site, user } from "@entrelacos/database/schema";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashInvitationSessionToken } from "./guestVerification";
import { createInvitation } from "./invitations";
import {
  listRsvpHistory,
  readInvitationRsvp,
  readRsvpDeadline,
  readSiteRsvp,
  updateRsvpDeadline,
  writeAdminRsvp,
  writeInvitationRsvp,
} from "./rsvp";
import { approveReview, createSite, startReview } from "./sites";

const prefix = `canonical-rsvp-${process.pid}-${randomUUID().slice(0, 8)}`;
const now = new Date("2028-04-01T12:00:00.000Z");
const ownerId = `${prefix}-owner`;
const owner = { userId: ownerId, role: "OWNER" as const };

let connection: DatabaseConnection;
const siteIds: string[] = [];

async function fixture(label: string) {
  const wedding = await createSite(
    connection.db,
    {
      repositorySlug: `${prefix}-${label}`,
      provisioningKey: `${prefix}:key:${label}`,
      displayName: `RSVP ${label}`,
      coupleNames: ["Ana", "João"],
      eventDate: "2029-06-10",
    },
    now,
  );
  siteIds.push(wedding.id);
  const first = await createInvitation(
    connection.db,
    owner,
    wedding.id,
    {
      name: "Família Silva",
      phone: "+5511999999999",
      guests: [
        { fullName: "Ana Silva", guestType: "ADULT" },
        { fullName: "Bia Silva", guestType: "CHILD" },
      ],
    },
    now,
  );
  const second = await createInvitation(
    connection.db,
    owner,
    wedding.id,
    {
      name: "Casal Souza",
      phone: "+5511888888888",
      guests: [{ fullName: "Caio Souza", guestType: "ADULT" }],
    },
    now,
  );
  await startReview(connection.db, wedding.id, {}, now);
  await approveReview(connection.db, wedding.id, {}, now);

  const token = randomUUID().replaceAll("-", "").padEnd(43, "s").slice(0, 43);
  const sessionId = randomUUID();
  await connection.db.insert(invitationSession).values({
    id: sessionId,
    siteId: wedding.id,
    invitationId: first.id,
    tokenHash: hashInvitationSessionToken(token),
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    createdAt: now,
  });
  const firstGuest = first.guests[0];
  const childGuest = first.guests[1];
  const secondGuest = second.guests[0];
  if (!firstGuest || !childGuest || !secondGuest) {
    throw new Error("Expected guests in RSVP fixture");
  }
  return {
    wedding,
    first,
    second,
    token,
    sessionId,
    firstGuest,
    childGuest,
    secondGuest,
  };
}

describe("canonical RSVP PostgreSQL service", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    await connection.db
      .delete(site)
      .where(like(site.repositorySlug, `${prefix}%`));
    await connection.db.insert(user).values({
      id: ownerId,
      name: "RSVP Owner",
      email: `${ownerId}@example.test`,
      role: "OWNER",
      state: "ACTIVE",
    });
  });

  afterAll(async () => {
    for (const siteId of siteIds) {
      await connection.db.delete(site).where(eq(site.id, siteId));
    }
    await connection.db.delete(user).where(eq(user.id, ownerId));
    await connection.close();
  });

  it("reads invitation guests and applies idempotent, revisioned public updates", async () => {
    const data = await fixture("public-write");
    const initial = await readInvitationRsvp(connection.db, data.token, now);
    expect(initial).toMatchObject({
      siteId: data.wedding.id,
      invitationId: data.first.id,
      invitationName: "Família Silva",
      canEdit: true,
      guests: [
        {
          id: data.firstGuest.id,
          fullName: "Ana Silva",
          guestType: "ADULT",
          state: "PENDING",
          revision: 0,
        },
        {
          id: data.childGuest.id,
          guestType: "CHILD",
          state: "PENDING",
          revision: 0,
        },
      ],
    });

    const input = {
      requestId: randomUUID(),
      guests: [
        {
          guestId: data.firstGuest.id,
          state: "CONFIRMED" as const,
          expectedRevision: 0,
        },
      ],
    };
    const applied = await writeInvitationRsvp(
      connection.db,
      data.token,
      input,
      now,
    );
    expect(applied).toMatchObject({
      result: "APPLIED",
      replayed: false,
      guests: [{ id: data.firstGuest.id, state: "CONFIRMED", revision: 1 }],
    });
    await expect(
      writeInvitationRsvp(
        connection.db,
        data.token,
        input,
        new Date(now.getTime() + 1_000),
      ),
    ).resolves.toMatchObject({
      requestId: input.requestId,
      acceptedAt: applied.acceptedAt,
      result: "APPLIED",
      replayed: true,
    });

    const history = await listRsvpHistory(
      connection.db,
      owner,
      data.wedding.id,
      {
        invitationId: data.first.id,
        guestId: data.firstGuest.id,
        actorType: "INVITATION",
      },
    );
    expect(history.entries).toEqual([
      expect.objectContaining({
        invitationId: data.first.id,
        invitationName: "Família Silva",
        guestId: data.firstGuest.id,
        guestDisplayName: "Ana Silva",
        actorType: "INVITATION",
        actorId: data.first.id,
        afterState: "CONFIRMED",
      }),
    ]);
  });

  it("isolates invitation sessions and reports current revisions on conflicts", async () => {
    const data = await fixture("isolation");
    const firstWrite = {
      requestId: randomUUID(),
      guests: [
        {
          guestId: data.firstGuest.id,
          state: "CONFIRMED" as const,
          expectedRevision: 0,
        },
      ],
    };
    await writeInvitationRsvp(connection.db, data.token, firstWrite, now);

    await expect(
      writeInvitationRsvp(
        connection.db,
        data.token,
        {
          requestId: randomUUID(),
          guests: [
            {
              guestId: data.firstGuest.id,
              state: "DECLINED",
              expectedRevision: 0,
            },
          ],
        },
        now,
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "RSVP_CONFLICT",
      details: {
        guests: [{ id: data.firstGuest.id, state: "CONFIRMED", revision: 1 }],
      },
    });

    await expect(
      writeInvitationRsvp(
        connection.db,
        data.token,
        {
          requestId: randomUUID(),
          guests: [
            {
              guestId: data.secondGuest.id,
              state: "CONFIRMED",
              expectedRevision: 0,
            },
          ],
        },
        now,
      ),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("filters admin views, enforces public deadlines, and permits admin correction", async () => {
    const data = await fixture("deadline");
    const siteView = await readSiteRsvp(connection.db, owner, data.wedding.id, {
      state: "PENDING",
    });
    expect(siteView.totals).toEqual({ pending: 3, confirmed: 0, declined: 0 });
    expect(siteView.invitations).toHaveLength(2);
    expect(
      siteView.invitations.every((record) =>
        record.guests.every((guest) => guest.state === "PENDING"),
      ),
    ).toBe(true);

    const deadline = {
      deadlineAt: "2028-04-02T03:00:00.000Z",
      deadlineTimezone: "America/Sao_Paulo",
    };
    await expect(
      readRsvpDeadline(connection.db, owner, data.wedding.id),
    ).resolves.toEqual({
      deadlineAt: null,
      deadlineTimezone: null,
    });
    await expect(
      updateRsvpDeadline(connection.db, owner, data.wedding.id, deadline, now),
    ).resolves.toEqual(deadline);
    const atDeadline = new Date(deadline.deadlineAt);
    await expect(
      readInvitationRsvp(connection.db, data.token, atDeadline),
    ).resolves.toMatchObject({
      canEdit: false,
      readOnlyReason: "DEADLINE_PASSED",
    });
    await expect(
      writeInvitationRsvp(
        connection.db,
        data.token,
        {
          requestId: randomUUID(),
          guests: [
            {
              guestId: data.firstGuest.id,
              state: "CONFIRMED",
              expectedRevision: 0,
            },
          ],
        },
        atDeadline,
      ),
    ).rejects.toMatchObject({ status: 409, code: "RSVP_DEADLINE_PASSED" });

    await expect(
      writeAdminRsvp(
        connection.db,
        owner,
        data.wedding.id,
        {
          requestId: randomUUID(),
          guests: [
            {
              guestId: data.firstGuest.id,
              state: "CONFIRMED",
              expectedRevision: 0,
            },
          ],
        },
        atDeadline,
      ),
    ).resolves.toMatchObject({
      result: "APPLIED",
      guests: [{ id: data.firstGuest.id, state: "CONFIRMED", revision: 1 }],
    });
  });

  it("rejects public access to inactive sites and admin writes to inactive sites", async () => {
    const data = await fixture("inactive");
    await connection.db
      .update(site)
      .set({ lifecycle: "INACTIVE", previousLifecycle: "ACTIVE" })
      .where(eq(site.id, data.wedding.id));

    await expect(
      readInvitationRsvp(connection.db, data.token, now),
    ).rejects.toMatchObject({ status: 401, code: "SESSION_INVALID" });
    await expect(
      writeAdminRsvp(
        connection.db,
        owner,
        data.wedding.id,
        {
          requestId: randomUUID(),
          guests: [
            {
              guestId: data.firstGuest.id,
              state: "CONFIRMED",
              expectedRevision: 0,
            },
          ],
        },
        now,
      ),
    ).rejects.toMatchObject({ status: 409, code: "SITE_INACTIVE" });
  });
});
