import { randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  familySession,
  guestGroup,
  guestVerificationChallenge,
  site,
  siteMembership,
  user,
} from "@entrelacos/database/schema";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createGuestGroup,
  deleteGuestGroup,
  getGuestGroupAccessPin,
  listGuestGroups,
  rotateGuestGroupAccessPin,
  updateGuestGroup,
} from "./guestGroups";
import {
  approveReview,
  createSite,
  deactivateSite,
  startReview,
} from "./sites";

const fixturePrefix = `t3-groups-${process.pid}-${randomUUID().slice(0, 8)}`;
const fixedNow = new Date("2028-02-29T12:00:00.000Z");
const fingerprintSecret = "guest-groups-pin-secret-with-at-least-32-characters";
let connection: DatabaseConnection;
const siteIds: string[] = [];
const userIds: string[] = [];

function siteInput(suffix: string) {
  return {
    repositorySlug: `${fixturePrefix}-${suffix}`,
    provisioningKey: `${fixturePrefix}:key-${suffix}`,
    displayName: `Wedding ${suffix}`,
    coupleNames: ["Ana", "João"] as [string, string],
    eventDate: "2029-06-10",
  };
}

async function createFixture(suffix: string) {
  const created = await createSite(connection.db, siteInput(suffix), fixedNow);
  siteIds.push(created.id);
  return created;
}

function groupInput(phone = "+5511999999999") {
  return {
    name: "  Família  Silva ",
    isForeign: false,
    phone,
    members: [
      { fullName: "Ana Silva", isRepresentative: true },
      { fullName: "Bia Silva", isRepresentative: false },
    ],
  };
}

async function addAdmin(siteId: string, suffix: string) {
  const userId = `${fixturePrefix}-${suffix}-user`;
  userIds.push(userId);
  await connection.db.insert(user).values({
    id: userId,
    name: `Admin ${suffix}`,
    email: `${userId}@example.test`,
    role: "SITE_ADMIN",
    state: "ACTIVE",
  });
  await connection.db.insert(siteMembership).values({
    id: `${fixturePrefix}-${suffix}-membership`,
    siteId,
    userId,
  });
  return { userId, role: "SITE_ADMIN" as const };
}

async function addIdentityFixtures(siteId: string, groupId: string) {
  const createdAt = new Date("2028-02-29T12:00:00.000Z");
  await connection.db.insert(familySession).values({
    id: `${fixturePrefix}-${randomUUID()}-session`,
    siteId,
    groupId,
    tokenHash: randomUUID().replaceAll("-", "").padEnd(64, "a").slice(0, 64),
    expiresAt: new Date("2028-03-01T12:00:00.000Z"),
    createdAt,
  });
  const challengeId = `${fixturePrefix}-${randomUUID()}-challenge`;
  await connection.db.insert(guestVerificationChallenge).values({
    id: challengeId,
    siteId,
    groupId,
    phoneE164: "+5511999999999",
    createdAt,
    expiresAt: new Date("2028-02-29T12:10:00.000Z"),
    resendAvailableAt: new Date("2028-02-29T12:01:00.000Z"),
  });
  return { challengeId };
}

describe("guest groups PostgreSQL integration", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    await connection.db
      .delete(site)
      .where(like(site.repositorySlug, `${fixturePrefix}%`));
  });

  afterAll(async () => {
    for (const siteId of siteIds) {
      await connection.db.delete(site).where(eq(site.id, siteId));
    }
    for (const userId of userIds) {
      await connection.db.delete(user).where(eq(user.id, userId));
    }
    await connection.close();
  });

  it("creates, lists, and updates groups with one representative", async () => {
    const wedding = await createFixture("crud");
    const created = await createGuestGroup(
      connection.db,
      { userId: "owner", role: "OWNER" },
      wedding.id,
      groupInput("+5511999999999"),
      fixedNow,
    );
    expect(created).toMatchObject({
      siteId: wedding.id,
      name: "Família Silva",
      phone: "+5511999999999",
    });
    expect(
      created.members.filter((member) => member.isRepresentative),
    ).toHaveLength(1);
    expect(
      await listGuestGroups(
        connection.db,
        { userId: "owner", role: "OWNER" },
        wedding.id,
      ),
    ).toEqual([created]);

    const corrected = await updateGuestGroup(
      connection.db,
      { userId: "owner", role: "OWNER" },
      wedding.id,
      created.id,
      {
        name: "Família Silva Corrigida",
        members: created.members.map((member) => ({
          id: member.id,
          fullName: `${member.fullName} corrigido`,
          isRepresentative: member.isRepresentative,
        })),
      },
      new Date("2028-03-01T12:00:00.000Z"),
    );
    expect(corrected.name).toBe("Família Silva Corrigida");
    expect(corrected.members[0]?.fullName).toContain("corrigido");
  });

  it("enforces phone uniqueness per site but allows reuse across sites", async () => {
    const first = await createFixture("phone-a");
    const second = await createFixture("phone-b");
    await createGuestGroup(
      connection.db,
      { userId: "owner", role: "OWNER" },
      first.id,
      groupInput(),
      fixedNow,
    );
    await expect(
      createGuestGroup(
        connection.db,
        { userId: "owner", role: "OWNER" },
        first.id,
        groupInput(),
        fixedNow,
      ),
    ).rejects.toMatchObject({ status: 409, code: "PHONE_CONFLICT" });
    await expect(
      createGuestGroup(
        connection.db,
        { userId: "owner", role: "OWNER" },
        second.id,
        groupInput(),
        fixedNow,
      ),
    ).resolves.toMatchObject({ siteId: second.id, phone: "+5511999999999" });
  });

  it("supports administrative foreign groups without phone", async () => {
    const wedding = await createFixture("foreign");
    const foreign = await createGuestGroup(
      connection.db,
      { userId: "owner", role: "OWNER" },
      wedding.id,
      {
        name: "Alex Smith",
        isForeign: true,
        phone: null,
        members: [{ fullName: "Alex Smith", isRepresentative: true }],
      },
      fixedNow,
    );
    expect(foreign).toMatchObject({ isForeign: true, phone: null });
  });

  it("allows inactive reads but denies all group mutations", async () => {
    const wedding = await createFixture("inactive");
    const group = await createGuestGroup(
      connection.db,
      { userId: "owner", role: "OWNER" },
      wedding.id,
      groupInput(),
      fixedNow,
    );
    await startReview(connection.db, wedding.id, {}, fixedNow);
    await approveReview(connection.db, wedding.id, {}, fixedNow);
    await deactivateSite(
      connection.db,
      wedding.id,
      new Date("2028-03-01T12:00:00.000Z"),
    );
    await expect(
      listGuestGroups(
        connection.db,
        { userId: "owner", role: "OWNER" },
        wedding.id,
      ),
    ).resolves.toHaveLength(1);
    await expect(
      createGuestGroup(
        connection.db,
        { userId: "owner", role: "OWNER" },
        wedding.id,
        groupInput("+5511988888888"),
        fixedNow,
      ),
    ).rejects.toMatchObject({ code: "SITE_INACTIVE" });
    await expect(
      updateGuestGroup(
        connection.db,
        { userId: "owner", role: "OWNER" },
        wedding.id,
        group.id,
        { name: "blocked" },
        fixedNow,
      ),
    ).rejects.toMatchObject({ code: "SITE_INACTIVE" });
    await expect(
      deleteGuestGroup(
        connection.db,
        { userId: "owner", role: "OWNER" },
        wedding.id,
        group.id,
      ),
    ).rejects.toMatchObject({ code: "SITE_INACTIVE" });
  });

  it("keeps site admins tenant-bound and rejects adulterated group IDs", async () => {
    const first = await createFixture("scope-a");
    const second = await createFixture("scope-b");
    const firstAdmin = await addAdmin(first.id, "scope");
    const firstGroup = await createGuestGroup(
      connection.db,
      firstAdmin,
      first.id,
      groupInput("+5511977777777"),
      fixedNow,
    );
    const secondGroup = await createGuestGroup(
      connection.db,
      { userId: "owner", role: "OWNER" },
      second.id,
      groupInput("+5511966666666"),
      fixedNow,
    );
    await expect(
      listGuestGroups(connection.db, firstAdmin, second.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      updateGuestGroup(
        connection.db,
        firstAdmin,
        first.id,
        secondGroup.id,
        { name: "stolen" },
        fixedNow,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      deleteGuestGroup(connection.db, firstAdmin, first.id, secondGroup.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      listGuestGroups(connection.db, firstAdmin, first.id),
    ).resolves.toEqual([firstGroup]);
  });

  it("revokes sessions and pending challenges only when representative or phone changes", async () => {
    const wedding = await createFixture("revocation");
    const group = await createGuestGroup(
      connection.db,
      { userId: "owner", role: "OWNER" },
      wedding.id,
      groupInput(),
      fixedNow,
    );
    const identity = await addIdentityFixtures(wedding.id, group.id);
    const swapped = await updateGuestGroup(
      connection.db,
      { userId: "owner", role: "OWNER" },
      wedding.id,
      group.id,
      {
        phone: "+5511988888888",
        members: group.members.map((member) => ({
          id: member.id,
          fullName: member.fullName,
          isRepresentative: !member.isRepresentative,
        })),
      },
      new Date("2028-03-01T12:00:00.000Z"),
    );
    expect(swapped.phone).toBe("+5511988888888");
    const [revokedSession] = await connection.db
      .select()
      .from(familySession)
      .where(eq(familySession.groupId, group.id));
    const [revokedChallenge] = await connection.db
      .select()
      .from(guestVerificationChallenge)
      .where(eq(guestVerificationChallenge.id, identity.challengeId));
    expect(revokedSession?.revokedAt).toEqual(
      new Date("2028-03-01T12:00:00.000Z"),
    );
    expect(revokedChallenge).toMatchObject({
      status: "REVOKED",
      revocationReason: "GROUP_IDENTITY_CHANGED",
    });

    const preservedGroup = await createGuestGroup(
      connection.db,
      { userId: "owner", role: "OWNER" },
      wedding.id,
      groupInput("+5511977777777"),
      fixedNow,
    );
    await addIdentityFixtures(wedding.id, preservedGroup.id);
    await updateGuestGroup(
      connection.db,
      { userId: "owner", role: "OWNER" },
      wedding.id,
      preservedGroup.id,
      {
        members: preservedGroup.members.map((member) => ({
          id: member.id,
          fullName: `${member.fullName} ortográfico`,
          isRepresentative: member.isRepresentative,
        })),
      },
      new Date("2028-03-02T12:00:00.000Z"),
    );
    const [preservedSession] = await connection.db
      .select()
      .from(familySession)
      .where(eq(familySession.groupId, preservedGroup.id));
    const [preservedChallenge] = await connection.db
      .select()
      .from(guestVerificationChallenge)
      .where(eq(guestVerificationChallenge.groupId, preservedGroup.id));
    expect(preservedSession?.revokedAt).toBeNull();
    expect(preservedChallenge?.status).toBe("PENDING");
  });

  it("reveals a stable PIN and revokes active access when rotating it", async () => {
    const wedding = await createFixture("manual-pin");
    const actor = { userId: "owner", role: "OWNER" as const };
    const group = await createGuestGroup(
      connection.db,
      actor,
      wedding.id,
      groupInput(),
      fixedNow,
    );
    const identity = await addIdentityFixtures(wedding.id, group.id);
    const first = await getGuestGroupAccessPin(
      connection.db,
      actor,
      wedding.id,
      group.id,
      fingerprintSecret,
    );
    expect(first.accessPin).toMatch(/^\d{6}$/);
    await expect(
      getGuestGroupAccessPin(
        connection.db,
        actor,
        wedding.id,
        group.id,
        fingerprintSecret,
      ),
    ).resolves.toEqual(first);

    const rotated = await rotateGuestGroupAccessPin(
      connection.db,
      actor,
      wedding.id,
      group.id,
      fingerprintSecret,
      new Date("2028-03-03T12:00:00.000Z"),
    );
    expect(rotated.accessPin).toMatch(/^\d{6}$/);
    expect(rotated).not.toEqual(first);
    const [storedGroup] = await connection.db
      .select({ manualPinSeed: guestGroup.manualPinSeed })
      .from(guestGroup)
      .where(eq(guestGroup.id, group.id));
    expect(storedGroup?.manualPinSeed).toMatch(/^[a-f0-9]{64}$/);
    expect(storedGroup?.manualPinSeed).not.toContain(rotated.accessPin);
    const [revokedSession] = await connection.db
      .select()
      .from(familySession)
      .where(eq(familySession.groupId, group.id));
    const [revokedChallenge] = await connection.db
      .select()
      .from(guestVerificationChallenge)
      .where(eq(guestVerificationChallenge.id, identity.challengeId));
    expect(revokedSession?.revocationReason).toBe("MANUAL_PIN_ROTATED");
    expect(revokedChallenge).toMatchObject({
      status: "REVOKED",
      revocationReason: "MANUAL_PIN_ROTATED",
    });
  });

  it("deletes group-owned members, sessions, and challenges", async () => {
    const wedding = await createFixture("delete");
    const group = await createGuestGroup(
      connection.db,
      { userId: "owner", role: "OWNER" },
      wedding.id,
      groupInput(),
      fixedNow,
    );
    await addIdentityFixtures(wedding.id, group.id);
    await expect(
      deleteGuestGroup(
        connection.db,
        { userId: "owner", role: "OWNER" },
        wedding.id,
        group.id,
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      listGuestGroups(
        connection.db,
        { userId: "owner", role: "OWNER" },
        wedding.id,
      ),
    ).resolves.toEqual([]);
    expect(
      await connection.db
        .select()
        .from(guestGroup)
        .where(eq(guestGroup.id, group.id)),
    ).toHaveLength(0);
    expect(
      await connection.db
        .select()
        .from(familySession)
        .where(eq(familySession.groupId, group.id)),
    ).toHaveLength(0);
    expect(
      await connection.db
        .select()
        .from(guestVerificationChallenge)
        .where(eq(guestVerificationChallenge.groupId, group.id)),
    ).toHaveLength(0);
  });
});
