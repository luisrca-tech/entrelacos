import { randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import { account, session, site, user } from "@entrelacos/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { bootstrapOwner } from "./bootstrapOwner";
import { createSite } from "./sites";

const adminOrigin = "https://admin.example.test";
const fixturePrefix = `t3-groups-http-${process.pid}-${randomUUID().slice(0, 8)}`;
const password = "guest-groups-http-password";
let connection: DatabaseConnection;
let app: ReturnType<typeof createApp>;
let siteId: string;
let ownerId: string;
let cookie: string;

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://api.example.test${path}`, {
    ...init,
    headers: { Origin: adminOrigin, ...(init.headers ?? {}) },
  });
}

async function jsonRequest(
  path: string,
  body: Record<string, unknown>,
  method = "POST",
): Promise<Response> {
  return app.request(
    request(path, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    }),
  );
}

describe("guest groups HTTP routes", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    const owner = await bootstrapOwner(connection.db, {
      email: `${fixturePrefix}@example.test`,
      name: "Guest Groups HTTP Owner",
      password,
    });
    ownerId = owner.userId;
    const createdSite = await createSite(
      connection.db,
      {
        repositorySlug: fixturePrefix,
        provisioningKey: `${fixturePrefix}:key`,
        displayName: "Guest Groups HTTP",
        coupleNames: ["Ana", "João"],
        eventDate: "2029-06-10",
      },
      new Date("2028-02-29T12:00:00.000Z"),
    );
    siteId = createdSite.id;
    const auth = createAuth({
      db: connection.db,
      secret: "guest-groups-http-auth-secret-that-is-long-enough",
      baseURL: "https://api.example.test",
      adminOrigin,
    });
    app = createApp({
      auth,
      authForDatabase: (db) =>
        createAuth({
          db,
          secret: "guest-groups-http-auth-secret-that-is-long-enough",
          baseURL: "https://api.example.test",
          adminOrigin,
        }),
      db: connection.db,
      adminOrigin,
    });
    const login = await app.request(
      request("/v1/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: `${fixturePrefix}@example.test`,
          password,
        }),
      }),
    );
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie");
    if (!setCookie) throw new Error("Expected auth session cookie");
    cookie = setCookie.split(";", 1)[0] ?? "";
  });

  afterAll(async () => {
    await connection.db.delete(session).where(eq(session.userId, ownerId));
    await connection.db.delete(account).where(eq(account.userId, ownerId));
    await connection.db.delete(site).where(eq(site.id, siteId));
    await connection.db.delete(user).where(eq(user.id, ownerId));
    await connection.close();
  });

  it("wires authenticated group CRUD and maps validation to problem+json", async () => {
    const listBefore = await app.request(
      request(`/v1/sites/${siteId}/groups`, { headers: { Cookie: cookie } }),
    );
    expect(listBefore.status).toBe(200);
    expect(await listBefore.json()).toEqual({ groups: [] });

    const invalid = await jsonRequest(`/v1/sites/${siteId}/groups`, {
      name: "Invalid",
      isForeign: false,
      phone: "+5511999999999",
      members: [],
    });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(await invalid.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      status: 400,
    });

    const created = await jsonRequest(`/v1/sites/${siteId}/groups`, {
      name: "Família HTTP",
      isForeign: false,
      phone: "+5511999999999",
      members: [{ fullName: "Ana HTTP", isRepresentative: true }],
    });
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.group).toMatchObject({ siteId, phone: "+5511999999999" });
    const groupId = body.group.id as string;

    const updated = await jsonRequest(
      `/v1/sites/${siteId}/groups/${groupId}`,
      { name: "Família HTTP Corrigida" },
      "PATCH",
    );
    expect(updated.status).toBe(200);
    expect((await updated.json()).group.name).toBe("Família HTTP Corrigida");

    const deleted = await jsonRequest(
      `/v1/sites/${siteId}/groups/${groupId}`,
      {},
      "DELETE",
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });
  });

  it("does not authorize requests without the configured admin origin", async () => {
    const response = await app.request(
      request(`/v1/sites/${siteId}/groups`, {
        headers: { Origin: "https://evil.example.test", Cookie: cookie },
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
  });
});
