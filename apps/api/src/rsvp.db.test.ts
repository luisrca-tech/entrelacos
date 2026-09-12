import { randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  familySession,
  guestMember,
  guestVerificationChallenge,
  rsvpHistory,
  site,
  siteMembership,
  user,
} from "@entrelacos/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashFamilySessionToken } from "./familySession";
import { createGuestGroup, updateGuestGroup } from "./guestGroups";
import {
  listRsvpHistory,
  readFamilyRsvp,
  readRsvpDeadline,
  readSiteRsvp,
  updateRsvpDeadline,
  writeAdminRsvp,
  writeFamilyRsvp,
} from "./rsvp";
import {
  approveReview,
  createSite,
  deactivateSite,
  startReview,
} from "./sites";

const prefix = `b4-rsvp-${process.pid}-${randomUUID().slice(0, 8)}`;
const now = new Date("2028-04-01T12:00:00.000Z");
const token = randomUUID().replaceAll("-", "").padEnd(43, "t").slice(0, 43);
const foreignToken = randomUUID()
  .replaceAll("-", "")
  .padEnd(43, "f")
  .slice(0, 43);
let connection: DatabaseConnection;
let siteId: string;
let groupId: string;
let otherSiteId: string;
let otherMemberId: string;
const adminId = `${prefix}-admin`;
const admin = { userId: adminId, role: "SITE_ADMIN" as const };
const ownerId = `${prefix}-owner`;
const owner = { userId: ownerId, role: "OWNER" as const };

describe("RSVP PostgreSQL service", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    const wedding = await createSite(
      connection.db,
      {
        repositorySlug: `${prefix}-site`,
        provisioningKey: `${prefix}:site`,
        displayName: "RSVP Wedding",
        coupleNames: ["Ana", "João"],
        eventDate: "2029-06-10",
      },
      now,
    );
    siteId = wedding.id;
    await connection.db.insert(user).values({
      id: adminId,
      name: "Cerimonial RSVP",
      email: `${adminId}@example.test`,
      role: "SITE_ADMIN",
      state: "ACTIVE",
    });
    await connection.db.insert(user).values({
      id: ownerId,
      name: "Owner RSVP",
      email: `${ownerId}@example.test`,
      role: "OWNER",
      state: "ACTIVE",
    });
    await connection.db.insert(siteMembership).values({
      id: `${prefix}-membership`,
      siteId,
      userId: adminId,
    });
    const group = await createGuestGroup(
      connection.db,
      { userId: "owner", role: "OWNER" },
      siteId,
      {
        name: "Família Silva",
        isForeign: false,
        phone: "+5511999999999",
        members: [
          { fullName: "Ana Silva", isRepresentative: true },
          { fullName: "Bia Silva", isRepresentative: false },
        ],
      },
      now,
    );
    groupId = group.id;
    await startReview(connection.db, siteId, {}, now);
    await approveReview(connection.db, siteId, {}, now);
    await connection.db.insert(familySession).values({
      id: `${prefix}-session`,
      siteId,
      groupId: group.id,
      tokenHash: hashFamilySessionToken(token),
      expiresAt: new Date("2028-04-08T12:00:00.000Z"),
      createdAt: now,
    });
    const otherWedding = await createSite(
      connection.db,
      {
        repositorySlug: `${prefix}-sentinel`,
        provisioningKey: `${prefix}:sentinel`,
        displayName: "Sentinel Wedding",
        coupleNames: ["Bia", "Caio"],
        eventDate: "2029-07-10",
      },
      now,
    );
    otherSiteId = otherWedding.id;
    const otherGroup = await createGuestGroup(
      connection.db,
      { userId: "owner", role: "OWNER" },
      otherSiteId,
      {
        name: "Sentinel Group",
        isForeign: true,
        phone: null,
        members: [{ fullName: "Sentinel Guest", isRepresentative: true }],
      },
      now,
    );
    otherMemberId = otherGroup.members[0]?.id as string;
  });

  afterAll(async () => {
    if (siteId) await connection.db.delete(site).where(eq(site.id, siteId));
    if (otherSiteId)
      await connection.db.delete(site).where(eq(site.id, otherSiteId));
    await connection.db.delete(user).where(eq(user.id, adminId));
    await connection.db.delete(user).where(eq(user.id, ownerId));
    await connection.close();
  });

  it("reads without mutation and saves only submitted members with history", async () => {
    const initial = await readFamilyRsvp(connection.db, token, now);
    expect(initial.members).toHaveLength(2);
    expect(initial.members.every((member) => member.state === "PENDING")).toBe(
      true,
    );
    expect(initial.canEdit).toBe(true);

    const target = initial.members[0] as (typeof initial.members)[number];
    const result = await writeFamilyRsvp(
      connection.db,
      token,
      {
        requestId: randomUUID(),
        members: [
          {
            memberId: target.id,
            state: "CONFIRMED",
            expectedRevision: target.revision,
          },
        ],
      },
      now,
    );
    expect(result).toMatchObject({ result: "APPLIED", replayed: false });
    expect(result.members).toEqual([
      expect.objectContaining({
        id: target.id,
        state: "CONFIRMED",
        revision: 1,
      }),
    ]);

    const current = await readFamilyRsvp(connection.db, token, now);
    expect(
      current.members.find((member) => member.id === target.id),
    ).toMatchObject({
      state: "CONFIRMED",
      revision: 1,
    });
    expect(
      current.members.find((member) => member.id !== target.id),
    ).toMatchObject({
      state: "PENDING",
      revision: 0,
    });
    const [history] = await connection.db
      .select()
      .from(rsvpHistory)
      .where(eq(rsvpHistory.siteId, siteId));
    expect(history).toMatchObject({
      actorType: "FAMILY",
      actorId: initial.members.find((member) => member.isRepresentative)?.id,
      actorDisplayName: initial.members.find(
        (member) => member.isRepresentative,
      )?.fullName,
    });
  });

  it("does not depend on the prior SMS provider state after authentication", async () => {
    await connection.db.insert(guestVerificationChallenge).values({
      id: `${prefix}-stale-sms`,
      siteId,
      groupId,
      mode: "TWILIO",
      status: "REVOKED",
      phoneE164: "+5511999999999",
      expiresAt: new Date("2028-04-01T12:05:00.000Z"),
      resendAvailableAt: now,
      revokedAt: now,
      revocationReason: "TEST_PROVIDER_STATE",
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      readFamilyRsvp(connection.db, token, now),
    ).resolves.toMatchObject({
      siteId,
      groupId,
      canEdit: true,
    });
  });

  it("replays a completed request and does not invent no-op history", async () => {
    const current = await readFamilyRsvp(connection.db, token, now);
    const member = current.members[0] as (typeof current.members)[number];
    const requestId = randomUUID();
    const input = {
      requestId,
      members: [
        {
          memberId: member.id,
          state: member.state,
          expectedRevision: member.revision,
        },
      ],
    };
    const historyBefore = await connection.db
      .select()
      .from(rsvpHistory)
      .where(eq(rsvpHistory.siteId, siteId));

    const first = await writeFamilyRsvp(connection.db, token, input, now);
    const replay = await writeFamilyRsvp(
      connection.db,
      token,
      input,
      new Date("2028-04-01T12:01:00.000Z"),
    );

    expect(first).toMatchObject({ result: "NO_CHANGE", replayed: false });
    expect(replay).toMatchObject({
      result: "NO_CHANGE",
      replayed: true,
      acceptedAt: first.acceptedAt,
    });
    expect(
      await connection.db
        .select()
        .from(rsvpHistory)
        .where(eq(rsvpHistory.siteId, siteId)),
    ).toHaveLength(historyBefore.length);
    await expect(
      writeFamilyRsvp(
        connection.db,
        token,
        {
          ...input,
          members: [{ ...input.members[0], state: "DECLINED" }],
        },
        now,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("rolls back every member when one expected revision is stale", async () => {
    const current = await readFamilyRsvp(connection.db, token, now);
    const [stale, untouched] = current.members;
    if (!stale || !untouched) throw new Error("Expected two RSVP members");
    const historyBefore = await connection.db
      .select()
      .from(rsvpHistory)
      .where(eq(rsvpHistory.siteId, siteId));

    await expect(
      writeFamilyRsvp(
        connection.db,
        token,
        {
          requestId: randomUUID(),
          members: [
            {
              memberId: stale.id,
              state: "DECLINED",
              expectedRevision: Math.max(0, stale.revision - 1),
            },
            {
              memberId: untouched.id,
              state: "CONFIRMED",
              expectedRevision: untouched.revision,
            },
          ],
        },
        now,
      ),
    ).rejects.toMatchObject({ code: "RSVP_CONFLICT" });

    const after = await readFamilyRsvp(connection.db, token, now);
    expect(after.members).toEqual(current.members);
    expect(
      await connection.db
        .select()
        .from(rsvpHistory)
        .where(eq(rsvpHistory.siteId, siteId)),
    ).toHaveLength(historyBefore.length);
  });

  it("allows concurrent updates to different members", async () => {
    const current = await readFamilyRsvp(connection.db, token, now);
    const [first, second] = current.members;
    if (!first || !second) throw new Error("Expected two RSVP members");

    const results = await Promise.all([
      writeFamilyRsvp(
        connection.db,
        token,
        {
          requestId: randomUUID(),
          members: [
            {
              memberId: first.id,
              state: "DECLINED",
              expectedRevision: first.revision,
            },
          ],
        },
        now,
      ),
      writeFamilyRsvp(
        connection.db,
        token,
        {
          requestId: randomUUID(),
          members: [
            {
              memberId: second.id,
              state: "CONFIRMED",
              expectedRevision: second.revision,
            },
          ],
        },
        now,
      ),
    ]);

    expect(results.every((result) => result.result === "APPLIED")).toBe(true);
    const after = await readFamilyRsvp(connection.db, token, now);
    expect(after.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, state: "DECLINED" }),
        expect.objectContaining({ id: second.id, state: "CONFIRMED" }),
      ]),
    );
  });

  it("accepts only one concurrent update to the same member revision", async () => {
    const current = await readFamilyRsvp(connection.db, token, now);
    const member = current.members[0];
    if (!member) throw new Error("Expected RSVP member");
    const nextStates = (["PENDING", "CONFIRMED", "DECLINED"] as const).filter(
      (state) => state !== member.state,
    );

    const results = await Promise.allSettled(
      nextStates.map((state) =>
        writeFamilyRsvp(
          connection.db,
          token,
          {
            requestId: randomUUID(),
            members: [
              {
                memberId: member.id,
                state,
                expectedRevision: member.revision,
              },
            ],
          },
          now,
        ),
      ),
    );

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: "RSVP_CONFLICT" }),
      }),
    ]);
  });

  it("rejects member and history access from another wedding", async () => {
    await expect(
      writeFamilyRsvp(
        connection.db,
        token,
        {
          requestId: randomUUID(),
          members: [
            {
              memberId: otherMemberId,
              state: "CONFIRMED",
              expectedRevision: 0,
            },
          ],
        },
        now,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      readSiteRsvp(connection.db, admin, otherSiteId, {}),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      listRsvpHistory(connection.db, admin, otherSiteId, {}),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("scopes admin idempotency receipts to the wedding", async () => {
    const main = await readSiteRsvp(connection.db, owner, siteId, {});
    const mainMember = main.groups[0]?.members[0];
    if (!mainMember) throw new Error("Expected main RSVP member");
    const requestId = randomUUID();

    const first = await writeAdminRsvp(
      connection.db,
      owner,
      siteId,
      {
        requestId,
        members: [
          {
            memberId: mainMember.id,
            state: mainMember.state === "CONFIRMED" ? "DECLINED" : "CONFIRMED",
            expectedRevision: mainMember.revision,
          },
        ],
      },
      now,
    );
    const second = await writeAdminRsvp(
      connection.db,
      owner,
      otherSiteId,
      {
        requestId,
        members: [
          {
            memberId: otherMemberId,
            state: "CONFIRMED",
            expectedRevision: 0,
          },
        ],
      },
      now,
    );

    expect(first).toMatchObject({ replayed: false });
    expect(second).toMatchObject({
      replayed: false,
      members: [expect.objectContaining({ id: otherMemberId })],
    });
  });

  it("preserves RSVP state and revision when an admin corrects a member name", async () => {
    const current = await readSiteRsvp(connection.db, admin, siteId, {});
    const group = current.groups[0];
    const target = group?.members[0];
    if (!group || !target) throw new Error("Expected RSVP group and member");

    await updateGuestGroup(
      connection.db,
      admin,
      siteId,
      group.id,
      {
        name: group.name,
        isForeign: false,
        phone: "+5511999999999",
        members: group.members.map((member) => ({
          id: member.id,
          fullName:
            member.id === target.id
              ? `${member.fullName} Corrigido`
              : member.fullName,
          isRepresentative: member.isRepresentative,
        })),
      },
      now,
    );

    const corrected = await readSiteRsvp(connection.db, admin, siteId, {});
    expect(
      corrected.groups[0]?.members.find((member) => member.id === target.id),
    ).toMatchObject({
      fullName: `${target.fullName} Corrigido`,
      state: target.state,
      revision: target.revision,
    });
  });

  it("keeps foreign groups on the administrative RSVP path", async () => {
    const foreign = await createGuestGroup(
      connection.db,
      admin,
      siteId,
      {
        name: "Convidado internacional",
        isForeign: true,
        phone: null,
        members: [{ fullName: "International Guest", isRepresentative: true }],
      },
      now,
    );
    const member = foreign.members[0];
    if (!member) throw new Error("Expected foreign RSVP member");
    await connection.db.insert(familySession).values({
      id: `${prefix}-foreign-session`,
      siteId,
      groupId: foreign.id,
      tokenHash: hashFamilySessionToken(foreignToken),
      expiresAt: new Date("2028-04-08T12:00:00.000Z"),
      createdAt: now,
    });
    await expect(
      readFamilyRsvp(connection.db, foreignToken, now),
    ).rejects.toMatchObject({ status: 401, code: "SESSION_INVALID" });
    await expect(
      writeFamilyRsvp(
        connection.db,
        token,
        {
          requestId: randomUUID(),
          members: [
            {
              memberId: member.id,
              state: "CONFIRMED",
              expectedRevision: 0,
            },
          ],
        },
        now,
      ),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      writeAdminRsvp(
        connection.db,
        admin,
        siteId,
        {
          requestId: randomUUID(),
          members: [
            {
              memberId: member.id,
              state: "CONFIRMED",
              expectedRevision: 0,
            },
          ],
        },
        now,
      ),
    ).resolves.toMatchObject({
      members: [expect.objectContaining({ id: member.id, state: "CONFIRMED" })],
    });
  });

  it("uses the server deadline and permits an authorized correction afterward", async () => {
    await expect(
      readRsvpDeadline(connection.db, admin, siteId),
    ).resolves.toEqual({
      deadlineAt: null,
      deadlineTimezone: null,
    });
    const deadline = {
      deadlineAt: "2028-04-02T03:00:00.000Z",
      deadlineTimezone: "America/Sao_Paulo",
    };
    await expect(
      updateRsvpDeadline(connection.db, admin, siteId, deadline, now),
    ).resolves.toEqual(deadline);

    const beforeDeadline = new Date("2028-04-02T02:59:59.999Z");
    const beforeView = await readFamilyRsvp(
      connection.db,
      token,
      beforeDeadline,
    );
    expect(beforeView.canEdit).toBe(true);
    const replayTarget = beforeView.members[0];
    if (!replayTarget) throw new Error("Expected RSVP member");
    const replayHistoryBefore = await connection.db
      .select()
      .from(rsvpHistory)
      .where(eq(rsvpHistory.memberId, replayTarget.id));
    const replayInput = {
      requestId: randomUUID(),
      members: [
        {
          memberId: replayTarget.id,
          state:
            replayTarget.state === "CONFIRMED"
              ? ("DECLINED" as const)
              : ("CONFIRMED" as const),
          expectedRevision: replayTarget.revision,
        },
      ],
    };
    const appliedBeforeDeadline = await writeFamilyRsvp(
      connection.db,
      token,
      replayInput,
      beforeDeadline,
    );
    const replayedAfterDeadline = await writeFamilyRsvp(
      connection.db,
      token,
      replayInput,
      new Date("2028-04-02T03:00:00.001Z"),
    );
    expect(appliedBeforeDeadline).toMatchObject({
      result: "APPLIED",
      replayed: false,
    });
    expect(replayedAfterDeadline).toMatchObject({
      result: "APPLIED",
      replayed: true,
      acceptedAt: appliedBeforeDeadline.acceptedAt,
    });
    expect(
      await connection.db
        .select()
        .from(rsvpHistory)
        .where(eq(rsvpHistory.memberId, replayTarget.id)),
    ).toHaveLength(replayHistoryBefore.length + 1);

    const atDeadline = new Date(deadline.deadlineAt);
    const publicView = await readFamilyRsvp(connection.db, token, atDeadline);
    expect(publicView).toMatchObject({
      canEdit: false,
      readOnlyReason: "DEADLINE_PASSED",
    });
    const target = publicView.members[1];
    if (!target) throw new Error("Expected RSVP member");
    await expect(
      writeFamilyRsvp(
        connection.db,
        token,
        {
          requestId: randomUUID(),
          members: [
            {
              memberId: target.id,
              state: "DECLINED",
              expectedRevision: target.revision,
            },
          ],
        },
        atDeadline,
      ),
    ).rejects.toMatchObject({ code: "RSVP_DEADLINE_PASSED" });

    const corrected = await writeAdminRsvp(
      connection.db,
      admin,
      siteId,
      {
        requestId: randomUUID(),
        members: [
          {
            memberId: target.id,
            state: "DECLINED",
            expectedRevision: target.revision,
          },
        ],
      },
      atDeadline,
    );
    expect(corrected.members[0]).toMatchObject({ state: "DECLINED" });
    const history = await listRsvpHistory(connection.db, admin, siteId, {
      memberId: target.id,
      limit: 10,
    });
    expect(history.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorType: "ADMIN",
          actorId: adminId,
          actorDisplayName: "Cerimonial RSVP",
          afterState: "DECLINED",
        }),
      ]),
    );
  });

  it("lists current RSVP totals and keeps inactive weddings read-only", async () => {
    const current = await readSiteRsvp(connection.db, admin, siteId, {});
    expect(
      current.totals.pending +
        current.totals.confirmed +
        current.totals.declined,
    ).toBe(3);
    expect(current.groups).toHaveLength(2);
    const confirmed = await readSiteRsvp(connection.db, admin, siteId, {
      state: "CONFIRMED",
    });
    expect(
      confirmed.groups
        .flatMap((group) => group.members)
        .every((member) => member.state === "CONFIRMED"),
    ).toBe(true);
    expect(
      await readSiteRsvp(connection.db, admin, siteId, {
        groupId: current.groups[0]?.id,
      }),
    ).toMatchObject({ groups: [{ id: current.groups[0]?.id }] });

    await deactivateSite(
      connection.db,
      siteId,
      new Date("2028-04-03T12:00:00.000Z"),
    );
    await expect(
      readSiteRsvp(connection.db, admin, siteId, {}),
    ).resolves.toMatchObject({
      lifecycle: "INACTIVE",
    });
    await expect(
      readFamilyRsvp(
        connection.db,
        token,
        new Date("2028-04-03T12:00:00.000Z"),
      ),
    ).rejects.toMatchObject({ status: 401, code: "SESSION_INVALID" });
    const member = await connection.db
      .select()
      .from(guestMember)
      .where(eq(guestMember.siteId, siteId))
      .limit(1)
      .then((rows) => rows[0]);
    if (!member) throw new Error("Expected RSVP member");
    await expect(
      writeAdminRsvp(
        connection.db,
        admin,
        siteId,
        {
          requestId: randomUUID(),
          members: [
            {
              memberId: member.id,
              state: "PENDING",
              expectedRevision: member.rsvpRevision,
            },
          ],
        },
        new Date("2028-04-03T12:00:00.000Z"),
      ),
    ).rejects.toMatchObject({ code: "SITE_INACTIVE" });
  });
});
