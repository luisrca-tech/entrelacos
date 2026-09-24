import { randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import { muralMessage, site, siteOrigin } from "@entrelacos/database/schema";
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMessagesHttpRouter } from "./messagesHttp";

const fixturePrefix = `public-mural-http-${process.pid}-${randomUUID().slice(0, 8)}`;
const publicOrigin = `https://${fixturePrefix}.example.test`;
const requestId = randomUUID();
let connection: DatabaseConnection;
let siteId = "";

function request(path: string, init: RequestInit = {}, origin = publicOrigin) {
  return new Request(`https://api.example.test${path}`, {
    ...init,
    headers: { Origin: origin, ...(init.headers ?? {}) },
  });
}

function router() {
  return createMessagesHttpRouter({
    auth: {} as never,
    db: connection.db,
    adminOrigin: "https://admin.example.test",
    guestFingerprintSecret: "m".repeat(64),
    guestResolveClientIp: () => "203.0.113.80",
    now: () => new Date("2029-02-10T12:00:00.000Z"),
  });
}

describe("public mural HTTP PostgreSQL boundary", () => {
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
      publicUrl: `${publicOrigin}/`,
      createdAt: now,
      updatedAt: now,
    });
    siteId = id;
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

  it("creates an independent post without a bearer and reads its public DTO", async () => {
    const app = router();
    const created = await app.request(
      request(`/v1/public/sites/${siteId}/mural`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId,
          authorName: " Ana HTTP ",
          text: "Mensagem pública",
        }),
      }),
    );
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    expect(created.headers.get("access-control-allow-origin")).toBe(
      publicOrigin,
    );
    const createdBody = await created.json();
    expect(createdBody).toMatchObject({
      requestId,
      replayed: false,
      message: {
        authorName: "Ana HTTP",
        text: "Mensagem pública",
      },
    });

    const replayed = await app.request(
      request(`/v1/public/sites/${siteId}/mural`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId,
          authorName: "Ana HTTP",
          text: "Mensagem pública",
        }),
      }),
    );
    expect(replayed.status).toBe(201);
    expect(await replayed.json()).toMatchObject({
      requestId,
      replayed: true,
      message: createdBody.message,
    });

    const publicRead = await app.request(
      request(`/v1/public/sites/${siteId}/mural`),
    );
    expect(publicRead.status).toBe(200);
    expect(await publicRead.json()).toEqual({
      enabled: true,
      messages: [createdBody.message],
      nextCursor: null,
    });
  });

  it("rejects an unregistered origin and malformed cursor", async () => {
    const app = router();
    const foreign = await app.request(
      request(
        `/v1/public/sites/${siteId}/mural`,
        {},
        "https://evil.example.test",
      ),
    );
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();

    const invalidCursor = await app.request(
      request(`/v1/public/sites/${siteId}/mural?cursor=bad`),
    );
    expect(invalidCursor.status).toBe(400);
    expect(await invalidCursor.json()).toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("returns stored messages from the disabled mural", async () => {
    await connection.db
      .update(site)
      .set({ muralEnabled: false })
      .where(eq(site.id, siteId));
    const storedMessages = await connection.db
      .select()
      .from(muralMessage)
      .where(
        and(
          eq(muralMessage.siteId, siteId),
          eq(muralMessage.text, "Mensagem pública"),
        ),
      );
    expect(storedMessages).toHaveLength(1);

    const response = await router().request(
      request(`/v1/public/sites/${siteId}/mural`),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      enabled: false,
      messages: storedMessages.map((message) => ({
        id: message.id,
        authorName: message.authorName,
        text: message.text,
        createdAt: message.createdAt.toISOString(),
      })),
      nextCursor: null,
    });
    await connection.db
      .update(site)
      .set({ muralEnabled: true })
      .where(eq(site.id, siteId));
  });
});
