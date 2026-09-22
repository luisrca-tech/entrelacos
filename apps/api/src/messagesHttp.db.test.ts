import { randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  invitation,
  invitationGuest,
  invitationMessage,
  site,
  siteOrigin,
} from "@entrelacos/database/schema";
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMessagesHttpRouter } from "./messagesHttp";

const fixturePrefix = `b5-messages-http-${process.pid}-${randomUUID().slice(0, 8)}`;
const publicOrigin = `https://${fixturePrefix}.example.test`;
let connection: DatabaseConnection;
let siteId = "";

function request(path: string, init: RequestInit = {}, origin = publicOrigin) {
  return new Request(`https://api.example.test${path}`, {
    ...init,
    headers: {
      Origin: origin,
      ...(init.headers ?? {}),
    },
  });
}

describe("messages HTTP PostgreSQL boundary", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    await connection.db
      .delete(site)
      .where(like(site.repositorySlug, `${fixturePrefix}%`));
    const now = new Date("2029-02-10T12:00:00.000Z");
    const id = randomUUID();
    await connection.db.insert(site).values({
      id,
      repositorySlug: fixturePrefix,
      provisioningKey: `${fixturePrefix}:key`,
      displayName: "HTTP Message Wedding",
      partnerOneName: "Ana",
      partnerTwoName: "João",
      eventDate: "2030-06-10",
      lifecycle: "ACTIVE",
      previousLifecycle: null,
      muralEnabled: true,
      createdAt: now,
      updatedAt: now,
    });
    siteId = id;
    const invitationId = `${fixturePrefix}-invitation`;
    const guestId = `${fixturePrefix}-guest`;
    await connection.db.transaction(async (tx) => {
      await tx.insert(invitation).values({
        id: invitationId,
        siteId,
        name: "Família HTTP",
        normalizedName: "familia http",
        phoneE164: "+5511999999999",
        messageRevision: 1,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(invitationGuest).values({
        id: guestId,
        siteId,
        invitationId,
        fullName: "Ana HTTP",
        normalizedName: "ana http",
        guestType: "ADULT",
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(invitationMessage).values({
        id: `${fixturePrefix}-message`,
        siteId,
        invitationId,
        authorName: "Família HTTP",
        invitationName: "Família HTTP",
        text: "Mensagem pública",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
    });
    await connection.db.insert(siteOrigin).values({
      id: `${fixturePrefix}-origin`,
      siteId,
      origin: publicOrigin,
    });
  });

  afterAll(async () => {
    if (siteId) await connection.db.delete(site).where(eq(site.id, siteId));
    await connection.close();
  });

  it("returns only public DTO fields with no-store exact-origin CORS", async () => {
    const response = await createMessagesHttpRouter({
      auth: {} as never,
      db: connection.db,
      adminOrigin: "https://admin.example.test",
    }).request(request(`/v1/public/sites/${siteId}/mural`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      publicOrigin,
    );
    expect(await response.json()).toEqual({
      enabled: true,
      messages: [
        {
          id: `${fixturePrefix}-message`,
          authorName: "Família HTTP",
          invitationName: "Família HTTP",
          text: "Mensagem pública",
          createdAt: "2029-02-10T12:00:00.000Z",
          updatedAt: "2029-02-10T12:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
  });

  it("rejects a foreign origin and malformed cursor", async () => {
    const router = createMessagesHttpRouter({
      auth: {} as never,
      db: connection.db,
      adminOrigin: "https://admin.example.test",
    });
    const foreign = await router.request(
      request(
        `/v1/public/sites/${siteId}/mural`,
        {},
        "https://evil.example.test",
      ),
    );
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();

    const invalidCursor = await router.request(
      request(`/v1/public/sites/${siteId}/mural?cursor=bad`),
    );
    expect(invalidCursor.status).toBe(400);
    expect(await invalidCursor.json()).toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("returns disabled mural as empty while retaining stored rows", async () => {
    await connection.db
      .update(site)
      .set({ muralEnabled: false })
      .where(eq(site.id, siteId));
    const response = await createMessagesHttpRouter({
      auth: {} as never,
      db: connection.db,
      adminOrigin: "https://admin.example.test",
    }).request(request(`/v1/public/sites/${siteId}/mural`));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      enabled: false,
      messages: [],
      nextCursor: null,
    });
    await expect(
      connection.db
        .select({ id: invitationMessage.id })
        .from(invitationMessage)
        .where(
          and(
            eq(invitationMessage.siteId, siteId),
            eq(invitationMessage.id, `${fixturePrefix}-message`),
          ),
        ),
    ).resolves.toHaveLength(1);
  });
});
