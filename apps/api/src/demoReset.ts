import {
  type DemoResetResponse,
  demoResetInputSchema,
  demoResetResponseSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import {
  invitation,
  invitationAccessChallenge,
  invitationGuest,
  invitationRateLimitEvent,
  invitationSession,
  muralMessage,
  muralMessageRateLimitEvent,
  muralMessageRequestReceipt,
  rsvpHistory,
  rsvpRequestReceipt,
  rsvpRequestReceiptInvitation,
  site,
} from "@entrelacos/database/schema";
import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { normalizeInvitationName } from "./invitations";

export const DEMO_RESET_DATASET_VERSION = "block7-demo-v2" as const;
export type DemoResetDatabase = NodePgDatabase<Record<string, never>>;
export type DemoResetActor = { userId: string; role: "OWNER" | "SITE_ADMIN" };
export interface DemoResetClock {
  now(): Date;
}

export class DemoResetServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
  ) {
    super(title);
    this.name = "DemoResetServiceError";
  }
}

function reject(status: number, code: string, title: string): never {
  throw new DemoResetServiceError(status, code, title);
}

function currentTime(value: Date): Date {
  const now = new Date(value.getTime());
  if (!Number.isFinite(now.getTime())) {
    reject(400, "VALIDATION_ERROR", "Invalid demo reset time");
  }
  return now;
}

function syntheticBrazilianPhone(sequence: number): string {
  return `+55119${sequence.toString().padStart(8, "0")}`;
}

const invitations = [
  {
    id: "b7-invitation-pending",
    name: "Convite Pendente",
    phone: syntheticBrazilianPhone(1),
    guests: [
      {
        id: "b7-guest-pending-1",
        name: "Paula Pending",
        type: "ADULT",
        state: "PENDING",
      },
      {
        id: "b7-guest-pending-2",
        name: "Pedro Pending",
        type: "CHILD",
        state: "PENDING",
      },
    ],
  },
  {
    id: "b7-invitation-partial",
    name: "Convite Parcial",
    phone: syntheticBrazilianPhone(2),
    guests: [
      {
        id: "b7-guest-partial-1",
        name: "Clara Partial",
        type: "ADULT",
        state: "PENDING",
      },
      {
        id: "b7-guest-partial-2",
        name: "Carlos Partial",
        type: "CHILD",
        state: "CONFIRMED",
      },
    ],
  },
  {
    id: "b7-invitation-confirmed",
    name: "Convite Confirmado",
    phone: syntheticBrazilianPhone(3),
    guests: [
      {
        id: "b7-guest-confirmed-1",
        name: "Beatriz Confirmed",
        type: "ADULT",
        state: "CONFIRMED",
      },
      {
        id: "b7-guest-confirmed-2",
        name: "Bruno Confirmed",
        type: "CHILD",
        state: "CONFIRMED",
      },
    ],
  },
  {
    id: "b7-invitation-declined",
    name: "Convite Ausente",
    phone: syntheticBrazilianPhone(4),
    guests: [
      {
        id: "b7-guest-declined-1",
        name: "Daniel Declined",
        type: "ADULT",
        state: "DECLINED",
      },
      {
        id: "b7-guest-declined-2",
        name: "Dora Declined",
        type: "CHILD",
        state: "DECLINED",
      },
    ],
  },
  {
    id: "b7-invitation-international",
    name: "Convite Internacional",
    phone: "+12125550123",
    guests: [
      {
        id: "b7-guest-international-1",
        name: "Elliot International",
        type: "ADULT",
        state: "PENDING",
      },
      {
        id: "b7-guest-international-2",
        name: "Emma International",
        type: "CHILD",
        state: "CONFIRMED",
      },
    ],
  },
] as const;

export const DEMO_RESET_DATASET_IDS = {
  invitationIds: invitations.map((item) => item.id),
  guestIds: invitations.flatMap((item) => item.guests.map((guest) => guest.id)),
} as const;

const pinSeeds = ["1", "2", "3", "4", "5"].map((value) => value.repeat(64));

async function deleteOperationalRows(
  tx: Parameters<Parameters<DemoResetDatabase["transaction"]>[0]>[0],
  siteId: string,
): Promise<void> {
  // Explicit site predicates keep a demo reset confined to its tenant.
  await tx
    .delete(muralMessageRequestReceipt)
    .where(eq(muralMessageRequestReceipt.siteId, siteId));
  await tx
    .delete(muralMessageRateLimitEvent)
    .where(eq(muralMessageRateLimitEvent.siteId, siteId));
  await tx
    .delete(rsvpRequestReceiptInvitation)
    .where(eq(rsvpRequestReceiptInvitation.siteId, siteId));
  await tx
    .delete(rsvpRequestReceipt)
    .where(eq(rsvpRequestReceipt.siteId, siteId));
  await tx.delete(rsvpHistory).where(eq(rsvpHistory.siteId, siteId));
  await tx
    .delete(invitationSession)
    .where(eq(invitationSession.siteId, siteId));
  await tx.delete(muralMessage).where(eq(muralMessage.siteId, siteId));
  await tx
    .delete(invitationAccessChallenge)
    .where(eq(invitationAccessChallenge.siteId, siteId));
  await tx
    .delete(invitationRateLimitEvent)
    .where(eq(invitationRateLimitEvent.siteId, siteId));
  await tx.delete(invitationGuest).where(eq(invitationGuest.siteId, siteId));
  await tx.delete(invitation).where(eq(invitation.siteId, siteId));
}

async function seedOperationalRows(
  tx: Parameters<Parameters<DemoResetDatabase["transaction"]>[0]>[0],
  siteId: string,
  now: Date,
): Promise<{ invitations: number; guests: number; messages: number }> {
  await tx.insert(invitation).values(
    invitations.map((item, index) => ({
      id: item.id,
      siteId,
      name: item.name,
      normalizedName: normalizeInvitationName(item.name),
      phoneE164: item.phone,
      email: null,
      manualPinSeed: pinSeeds[index] ?? "0".repeat(64),
      createdAt: now,
      updatedAt: now,
    })),
  );
  await tx.insert(invitationGuest).values(
    invitations.flatMap((item) =>
      item.guests.map((guest) => ({
        id: guest.id,
        siteId,
        invitationId: item.id,
        fullName: guest.name,
        normalizedName: normalizeInvitationName(guest.name),
        guestType: guest.type,
        rsvpState: guest.state,
        rsvpRevision: 0,
        createdAt: now,
        updatedAt: now,
      })),
    ),
  );
  return {
    invitations: invitations.length,
    guests: invitations.reduce((total, item) => total + item.guests.length, 0),
    messages: 0,
  };
}

export async function resetDemoSite(
  db: DemoResetDatabase,
  actor: DemoResetActor,
  siteIdInput: string,
  options: { clock?: DemoResetClock } = {},
): Promise<DemoResetResponse> {
  if (actor.role !== "OWNER") {
    reject(403, "FORBIDDEN", "Only the owner can reset the demo site");
  }
  const siteId = siteIdSchema.parse(siteIdInput);
  const input = demoResetInputSchema.parse({
    datasetVersion: DEMO_RESET_DATASET_VERSION,
  });

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(
      hashtextextended('entrelacos:block7:demo-reset:' || ${siteId}, 0)
    )`);
    const lockedSite = await tx.execute(sql`
      SELECT id, is_demo
      FROM "site"
      WHERE id = ${siteId}
      FOR UPDATE
    `);
    const target = lockedSite.rows[0] as
      | { id: string; is_demo: boolean }
      | undefined;
    if (!target?.is_demo) {
      reject(404, "DEMO_SITE_NOT_FOUND", "Demo site was not found");
    }

    const now = currentTime(options.clock?.now() ?? new Date());
    await deleteOperationalRows(tx, siteId);
    await tx
      .update(site)
      .set({
        isDemo: true,
        lifecycle: "ACTIVE",
        previousLifecycle: null,
        publicationState: "PUBLISHED",
        rsvpDeadlineAt: null,
        rsvpDeadlineTimezone: null,
        muralEnabled: false,
        updatedAt: now,
      })
      .where(and(eq(site.id, siteId), eq(site.isDemo, true)));
    const counts = await seedOperationalRows(tx, siteId, now);
    return demoResetResponseSchema.parse({
      siteId,
      datasetVersion: input.datasetVersion,
      result: "RESET",
      resetAt: now.toISOString(),
      counts,
    });
  });
}
