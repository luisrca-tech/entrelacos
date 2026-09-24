import { randomUUID } from "node:crypto";
import { originSchema, publicUrlSchema } from "@entrelacos/contracts";
import {
  invitation,
  invitationGuest,
  site,
  siteOrigin,
} from "@entrelacos/database/schema";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { type BootstrapOwnerInput, bootstrapOwner } from "./bootstrapOwner";
import { DEMO_RESET_DATASET_IDS, resetDemoSite } from "./demoReset";

export const DEMO_SITE_ID = "demo-wedding" as const;
export const DEMO_REPOSITORY_SLUG = "demo-wedding" as const;
export const DEMO_PROVISIONING_KEY = "repo:demo-wedding" as const;
export const DEMO_EVENT_DATE = "2027-09-18" as const;

type ProvisionDatabase = NodePgDatabase<Record<string, never>>;

export interface EnvironmentProvisionInput {
  target: "development" | "production";
  runtimeEnvironment: string;
  productionAuthorized: boolean;
  resetAuthorized: boolean;
  owner: BootstrapOwnerInput;
  publicUrl: string;
}

export interface EnvironmentProvisionResult {
  owner: Awaited<ReturnType<typeof bootstrapOwner>>;
  siteId: typeof DEMO_SITE_ID;
  site: "created" | "preserved";
  reset: Awaited<ReturnType<typeof resetDemoSite>> | null;
}

function expectedPublicUrl(
  target: EnvironmentProvisionInput["target"],
): string {
  return target === "production"
    ? "https://demo.entrelacos.workers.dev/"
    : "https://demo-dev.entrelacos.workers.dev/";
}

function validatePublicUrl(
  target: EnvironmentProvisionInput["target"],
  value: string,
): { publicUrl: string; origin: string } {
  const publicUrl = publicUrlSchema.parse(value);
  if (publicUrl !== expectedPublicUrl(target)) {
    throw new Error("Demo public URL does not match database target");
  }
  const origin = originSchema.parse(new URL(publicUrl).origin);
  return { publicUrl, origin };
}

async function ensureDemoSite(
  db: ProvisionDatabase,
  input: EnvironmentProvisionInput,
): Promise<{
  created: boolean;
  datasetComplete: boolean;
  muralEnabled: boolean;
}> {
  const { publicUrl, origin } = validatePublicUrl(
    input.target,
    input.publicUrl,
  );
  const now = new Date();

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('entrelacos:environment:provision:demo-wedding', 0))`,
    );

    const [existing] = await tx
      .select()
      .from(site)
      .where(eq(site.id, DEMO_SITE_ID))
      .limit(1);

    const conflicting = await tx
      .select({
        id: site.id,
        repositorySlug: site.repositorySlug,
        provisioningKey: site.provisioningKey,
        publicUrl: site.publicUrl,
      })
      .from(site)
      .where(
        or(
          eq(site.repositorySlug, DEMO_REPOSITORY_SLUG),
          eq(site.provisioningKey, DEMO_PROVISIONING_KEY),
          eq(site.publicUrl, publicUrl),
        ),
      );

    if (existing) {
      if (
        !existing.isDemo ||
        existing.repositorySlug !== DEMO_REPOSITORY_SLUG ||
        existing.provisioningKey !== DEMO_PROVISIONING_KEY ||
        existing.displayName !== "Marina & Caio" ||
        existing.partnerOneName !== "Marina" ||
        existing.partnerTwoName !== "Caio" ||
        existing.eventDate !== DEMO_EVENT_DATE ||
        existing.publicUrl !== publicUrl ||
        existing.lifecycle !== "ACTIVE" ||
        existing.publicationState !== "PUBLISHED"
      ) {
        throw new Error("Demo site conflicts with existing data");
      }

      const origins = await tx
        .select({ origin: siteOrigin.origin })
        .from(siteOrigin)
        .where(eq(siteOrigin.siteId, DEMO_SITE_ID));
      if (origins.length !== 1 || origins[0]?.origin !== origin) {
        throw new Error("Demo site origin conflicts with existing data");
      }

      const invitationRows = await tx
        .select({ id: invitation.id })
        .from(invitation)
        .where(
          and(
            eq(invitation.siteId, DEMO_SITE_ID),
            inArray(invitation.id, DEMO_RESET_DATASET_IDS.invitationIds),
          ),
        );
      const guestRows = await tx
        .select({ id: invitationGuest.id })
        .from(invitationGuest)
        .where(
          and(
            eq(invitationGuest.siteId, DEMO_SITE_ID),
            inArray(invitationGuest.id, DEMO_RESET_DATASET_IDS.guestIds),
          ),
        );
      return {
        created: false,
        datasetComplete:
          invitationRows.length ===
            DEMO_RESET_DATASET_IDS.invitationIds.length &&
          guestRows.length === DEMO_RESET_DATASET_IDS.guestIds.length,
        muralEnabled: existing.muralEnabled,
      };
    }

    if (conflicting.length > 0) {
      throw new Error("Demo site conflicts with existing data");
    }

    const [originConflict] = await tx
      .select({ siteId: siteOrigin.siteId })
      .from(siteOrigin)
      .where(eq(siteOrigin.origin, origin))
      .limit(1);
    if (originConflict) {
      throw new Error("Demo site origin conflicts with existing data");
    }

    await tx.insert(site).values({
      id: DEMO_SITE_ID,
      repositorySlug: DEMO_REPOSITORY_SLUG,
      provisioningKey: DEMO_PROVISIONING_KEY,
      displayName: "Marina & Caio",
      partnerOneName: "Marina",
      partnerTwoName: "Caio",
      eventDate: DEMO_EVENT_DATE,
      lifecycle: "ACTIVE",
      publicationState: "PUBLISHED",
      isDemo: true,
      publicUrl,
      muralEnabled: true,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(siteOrigin).values({
      id: randomUUID(),
      siteId: DEMO_SITE_ID,
      origin,
      createdAt: now,
    });
    return { created: true, datasetComplete: false, muralEnabled: true };
  });
}

export async function provisionDemoEnvironment(
  db: ProvisionDatabase,
  input: EnvironmentProvisionInput,
): Promise<EnvironmentProvisionResult> {
  if (input.runtimeEnvironment !== input.target) {
    throw new Error("Railway environment does not match database target");
  }
  if (typeof input.productionAuthorized !== "boolean") {
    throw new Error("Production provisioning authorization must be boolean");
  }
  if (typeof input.resetAuthorized !== "boolean") {
    throw new Error("Demo reset authorization must be boolean");
  }
  if ((input.target === "production") !== input.productionAuthorized) {
    throw new Error(
      "Explicit production provisioning authorization is required",
    );
  }
  validatePublicUrl(input.target, input.publicUrl);
  const ensured = await ensureDemoSite(db, input);

  if (!ensured.created && !ensured.datasetComplete && !input.resetAuthorized) {
    throw new Error(
      "Demo dataset is incomplete; explicit reset confirmation is required",
    );
  }

  const owner = await bootstrapOwner(db, input.owner);
  const shouldReset = ensured.created || input.resetAuthorized;
  const reset = shouldReset
    ? await resetDemoSite(
        db,
        { userId: owner.userId, role: "OWNER" },
        DEMO_SITE_ID,
      )
    : null;
  if (reset) {
    await db
      .update(site)
      .set({ muralEnabled: true, updatedAt: new Date(reset.resetAt) })
      .where(eq(site.id, DEMO_SITE_ID));
  } else if (!ensured.muralEnabled) {
    await db
      .update(site)
      .set({ muralEnabled: true, updatedAt: new Date() })
      .where(eq(site.id, DEMO_SITE_ID));
  }

  return {
    owner,
    siteId: DEMO_SITE_ID,
    site: ensured.created ? "created" : "preserved",
    reset,
  };
}
