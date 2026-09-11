import {
  ownerSiteResponseSchema,
  siteScopedReadResponseSchema,
} from "@entrelacos/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminSession: vi.fn(),
  createSite: vi.fn(),
  getSiteForActor: vi.fn(),
  createDomain: vi.fn(),
  SiteServiceError: class SiteServiceError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      readonly title: string,
    ) {
      super(title);
      this.name = "SiteServiceError";
    }
  },
}));

vi.mock("./authHttp", () => ({
  requireAdminSession: mocks.requireAdminSession,
}));
vi.mock("./sites", () => ({
  SiteServiceError: mocks.SiteServiceError,
  approveReview: vi.fn(),
  createDomain: mocks.createDomain,
  createSite: mocks.createSite,
  deactivateSite: vi.fn(),
  editSiteDates: vi.fn(),
  getSite: vi.fn(),
  getSiteForActor: mocks.getSiteForActor,
  listDomains: vi.fn(),
  listSites: vi.fn(),
  reactivateSite: vi.fn(),
  resumeSite: vi.fn(),
  startReview: vi.fn(),
  updateDomain: vi.fn(),
  updatePublication: vi.fn(),
  updateSite: vi.fn(),
}));

import { createSitesHttpRouter } from "./sitesHttp";

const adminOrigin = "https://admin.example.test";
const fixedSite = {
  id: "site-id",
  repositorySlug: "wedding-site",
  provisioningKey: "provisioning-key",
  displayName: "Ana and João",
  coupleNames: ["Ana", "João"] as [string, string],
  eventDate: "2029-06-10",
  lifecycle: "DRAFT" as const,
  previousLifecycle: null,
  publicationState: "UNPUBLISHED" as const,
  publicUrl: null,
  trustedOrigins: [],
  reviewApprovedAt: null,
  termStartsOn: null,
  termEndsOn: null,
  createdAt: "2028-02-29T12:00:00.000Z",
  updatedAt: "2028-02-29T12:00:00.000Z",
};
const fixedScopedSite = {
  id: fixedSite.id,
  displayName: fixedSite.displayName,
  coupleNames: fixedSite.coupleNames,
  eventDate: fixedSite.eventDate,
  lifecycle: fixedSite.lifecycle,
  previousLifecycle: fixedSite.previousLifecycle,
  publicationState: fixedSite.publicationState,
  publicUrl: fixedSite.publicUrl,
  termStartsOn: fixedSite.termStartsOn,
  termEndsOn: fixedSite.termEndsOn,
};

function router() {
  return createSitesHttpRouter({
    auth: {} as never,
    db: {} as never,
    adminOrigin,
    now: () => new Date("2028-02-29T12:00:00.000Z"),
  });
}

function request(path: string, init: RequestInit = {}) {
  return new Request(`https://api.example.test${path}`, {
    ...init,
    headers: {
      Origin: adminOrigin,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

describe("site HTTP boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireAdminSession.mockResolvedValue({
      user: {
        id: "owner-id",
        name: "Owner",
        email: "owner@example.test",
        role: "OWNER",
      },
      session: {
        id: "session-id",
        expiresAt: new Date("2028-03-01T12:00:00.000Z"),
      },
    });
  });

  it("returns exact owner envelope without nested site data", async () => {
    mocks.createSite.mockResolvedValue(fixedSite);
    const response = await router().request(
      request("/v1/owner/sites", {
        method: "POST",
        body: JSON.stringify({
          repositorySlug: "wedding-site",
          provisioningKey: "provisioning-key",
          displayName: "Ana and João",
          coupleNames: ["Ana", "João"],
          eventDate: "2029-06-10",
        }),
      }),
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(ownerSiteResponseSchema.parse(body)).toEqual({ site: fixedSite });
    expect(body.site.site).toBeUndefined();
  });

  it("returns exact tenant-scoped envelope without internal fields", async () => {
    mocks.requireAdminSession.mockResolvedValue({
      user: {
        id: "admin-id",
        name: "Admin",
        email: "admin@example.test",
        role: "SITE_ADMIN",
      },
      session: {
        id: "session-id",
        expiresAt: new Date("2028-03-01T12:00:00.000Z"),
      },
    });
    mocks.getSiteForActor.mockResolvedValue(fixedScopedSite);
    const response = await router().request(
      request("/v1/sites/site-id", { method: "GET" }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(siteScopedReadResponseSchema.parse(body)).toEqual({
      site: fixedScopedSite,
    });
    expect(body.site.provisioningKey).toBeUndefined();
    expect(body.site.repositorySlug).toBeUndefined();
    expect(body.site.trustedOrigins).toBeUndefined();
  });

  it("requires exact admin origin and owner role for owner routes", async () => {
    const wrongOrigin = await router().request(
      request("/v1/owner/sites", {
        method: "GET",
        headers: { Origin: "https://evil.example.test" },
      }),
    );
    expect(wrongOrigin.status).toBe(403);
    expect(mocks.requireAdminSession).not.toHaveBeenCalled();

    mocks.requireAdminSession.mockResolvedValue({
      user: {
        id: "admin-id",
        name: "Admin",
        email: "admin@example.test",
        role: "SITE_ADMIN",
      },
      session: {
        id: "session-id",
        expiresAt: new Date("2028-03-01T12:00:00.000Z"),
      },
    });
    const forbidden = await router().request(
      request("/v1/owner/sites", { method: "GET" }),
    );
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).code).toBe("FORBIDDEN");
  });

  it("rejects extra input keys and redacts service conflict details", async () => {
    const invalid = await router().request(
      request("/v1/owner/sites", {
        method: "POST",
        body: JSON.stringify({
          repositorySlug: "wedding-site",
          provisioningKey: "provisioning-key",
          displayName: "Ana and João",
          coupleNames: ["Ana", "João"],
          eventDate: "2029-06-10",
          role: "OWNER",
        }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(mocks.createSite).not.toHaveBeenCalled();

    mocks.createSite.mockRejectedValue(
      new mocks.SiteServiceError(
        409,
        "CONFLICT",
        "Site request conflicts with existing data",
      ),
    );
    const conflict = await router().request(
      request("/v1/owner/sites", {
        method: "POST",
        body: JSON.stringify({
          repositorySlug: "wedding-site",
          provisioningKey: "provisioning-key",
          displayName: "Ana and João",
          coupleNames: ["Ana", "João"],
          eventDate: "2029-06-10",
        }),
      }),
    );
    expect(conflict.status).toBe(409);
    const text = await conflict.text();
    expect(text).not.toContain("database");
    expect(text).not.toContain("SQL");
  });

  it("returns direct domain schema and creation status", async () => {
    mocks.createDomain.mockResolvedValue({
      id: "domain-id",
      siteId: "site-id",
      hostname: "example.test",
      state: "NONE",
      isPrimary: true,
      verifiedAt: null,
      expiresOn: null,
      createdAt: fixedSite.createdAt,
      updatedAt: fixedSite.updatedAt,
    });
    const response = await router().request(
      request("/v1/owner/sites/site-id/domains", {
        method: "POST",
        body: JSON.stringify({ hostname: "example.test", isPrimary: true }),
      }),
    );
    expect(response.status).toBe(201);
    expect((await response.json()).site).toBeUndefined();
  });
});
