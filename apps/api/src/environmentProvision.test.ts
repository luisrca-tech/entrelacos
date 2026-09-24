import { beforeEach, describe, expect, it, vi } from "vitest";
import { provisionDemoEnvironment } from "./environmentProvision";

const mocks = vi.hoisted(() => ({
  bootstrapOwner: vi.fn(),
  resetDemoSite: vi.fn(),
  datasetIds: {
    invitationIds: [
      "b7-invitation-pending",
      "b7-invitation-partial",
      "b7-invitation-confirmed",
      "b7-invitation-declined",
      "b7-invitation-foreign",
    ],
    guestIds: [
      "b7-guest-pending-1",
      "b7-guest-pending-2",
      "b7-guest-partial-1",
      "b7-guest-partial-2",
      "b7-guest-confirmed-1",
      "b7-guest-confirmed-2",
      "b7-guest-declined-1",
      "b7-guest-declined-2",
      "b7-guest-foreign-1",
      "b7-guest-foreign-2",
    ],
  },
}));

vi.mock("./bootstrapOwner", () => ({
  bootstrapOwner: mocks.bootstrapOwner,
}));

vi.mock("./demoReset", () => ({
  DEMO_RESET_DATASET_IDS: mocks.datasetIds,
  resetDemoSite: mocks.resetDemoSite,
}));

function fakeDatabase(selectResults: unknown[][] = []) {
  const inserted: unknown[] = [];
  const updates: unknown[] = [];
  const transaction = async (callback: (tx: unknown) => unknown) =>
    callback({
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            const rows = selectResults.shift() ?? [];
            return Object.assign(Promise.resolve(rows), {
              limit: async () => rows,
            });
          }),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(async (value: unknown) => {
          inserted.push(value);
        }),
      })),
    });
  const update = vi.fn(() => ({
    set: vi.fn((value: unknown) => {
      updates.push(value);
      return { where: vi.fn().mockResolvedValue(undefined) };
    }),
  }));
  return {
    db: { transaction, update },
    inserted,
    updates,
  };
}

function completeDatasetResults(): unknown[][] {
  return [
    mocks.datasetIds.invitationIds.map((id) => ({ id })),
    mocks.datasetIds.guestIds.map((id) => ({ id })),
  ];
}

describe("demo environment provisioning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates the deterministic site, resets it, and re-enables the mural", async () => {
    const fixture = fakeDatabase();
    mocks.bootstrapOwner.mockResolvedValue({ created: true, userId: "owner" });
    mocks.resetDemoSite.mockResolvedValue({
      siteId: "demo-wedding",
      resetAt: "2026-09-18T12:00:00.000Z",
    });

    const result = await provisionDemoEnvironment(fixture.db as never, {
      target: "development",
      runtimeEnvironment: "development",
      productionAuthorized: false,
      resetAuthorized: false,
      publicUrl: "https://demo-dev.entrelacos.workers.dev/",
      owner: {
        email: "owner@example.test",
        name: "Owner",
        password: "fixture-password",
      },
    });

    expect(result.siteId).toBe("demo-wedding");
    expect(fixture.inserted).toEqual([
      expect.objectContaining({
        id: "demo-wedding",
        repositorySlug: "demo-wedding",
        provisioningKey: "repo:demo-wedding",
        displayName: "Marina & Caio",
        partnerOneName: "Marina",
        partnerTwoName: "Caio",
        eventDate: "2027-09-18",
        isDemo: true,
        lifecycle: "ACTIVE",
        publicationState: "PUBLISHED",
        publicUrl: "https://demo-dev.entrelacos.workers.dev/",
        muralEnabled: true,
      }),
      expect.objectContaining({
        siteId: "demo-wedding",
        origin: "https://demo-dev.entrelacos.workers.dev",
      }),
    ]);
    expect(mocks.resetDemoSite).toHaveBeenCalledWith(
      fixture.db,
      { userId: "owner", role: "OWNER" },
      "demo-wedding",
    );
    expect(fixture.updates).toEqual([
      { muralEnabled: true, updatedAt: new Date("2026-09-18T12:00:00.000Z") },
    ]);
  });

  it("rejects a public URL from another environment before touching the database", async () => {
    const fixture = fakeDatabase();

    await expect(
      provisionDemoEnvironment(fixture.db as never, {
        target: "production",
        runtimeEnvironment: "production",
        productionAuthorized: true,
        resetAuthorized: false,
        publicUrl: "https://demo-dev.entrelacos.workers.dev/",
        owner: {
          email: "owner@example.test",
          name: "Owner",
          password: "fixture-password",
        },
      }),
    ).rejects.toThrow("Demo public URL does not match database target");
    expect(mocks.bootstrapOwner).not.toHaveBeenCalled();
  });

  it("revalidates the Railway runtime environment inside the service", async () => {
    const fixture = fakeDatabase();

    await expect(
      provisionDemoEnvironment(fixture.db as never, {
        target: "development",
        runtimeEnvironment: "production",
        productionAuthorized: false,
        resetAuthorized: false,
        publicUrl: "https://demo-dev.entrelacos.workers.dev/",
        owner: {
          email: "owner@example.test",
          name: "Owner",
          password: "fixture-password",
        },
      }),
    ).rejects.toThrow("Railway environment does not match database target");
    expect(mocks.bootstrapOwner).not.toHaveBeenCalled();
  });

  it("revalidates production authorization inside the service", async () => {
    const fixture = fakeDatabase();

    await expect(
      provisionDemoEnvironment(fixture.db as never, {
        target: "production",
        runtimeEnvironment: "production",
        productionAuthorized: false,
        resetAuthorized: false,
        publicUrl: "https://demo.entrelacos.workers.dev/",
        owner: {
          email: "owner@example.test",
          name: "Owner",
          password: "fixture-password",
        },
      }),
    ).rejects.toThrow(
      "Explicit production provisioning authorization is required",
    );
    expect(mocks.bootstrapOwner).not.toHaveBeenCalled();
  });

  it("refuses to reuse a non-demo site occupying the deterministic identity", async () => {
    const fixture = fakeDatabase([
      [
        {
          isDemo: false,
          repositorySlug: "demo-wedding",
          provisioningKey: "repo:demo-wedding",
          displayName: "Customer Site",
          partnerOneName: "A",
          partnerTwoName: "B",
          eventDate: "2027-09-18",
          publicUrl: "https://demo-dev.entrelacos.workers.dev/",
          lifecycle: "ACTIVE",
          publicationState: "PUBLISHED",
        },
      ],
    ]);
    mocks.bootstrapOwner.mockResolvedValue({ created: true, userId: "owner" });

    await expect(
      provisionDemoEnvironment(fixture.db as never, {
        target: "development",
        runtimeEnvironment: "development",
        productionAuthorized: false,
        resetAuthorized: false,
        publicUrl: "https://demo-dev.entrelacos.workers.dev/",
        owner: {
          email: "owner@example.test",
          name: "Owner",
          password: "fixture-password",
        },
      }),
    ).rejects.toThrow("Demo site conflicts with existing data");
    expect(mocks.resetDemoSite).not.toHaveBeenCalled();
    expect(fixture.inserted).toHaveLength(0);
  });

  it("preserves a complete existing demo without resetting or updating operational rows", async () => {
    const fixture = fakeDatabase([
      [
        {
          isDemo: true,
          repositorySlug: "demo-wedding",
          provisioningKey: "repo:demo-wedding",
          displayName: "Marina & Caio",
          partnerOneName: "Marina",
          partnerTwoName: "Caio",
          eventDate: "2027-09-18",
          publicUrl: "https://demo-dev.entrelacos.workers.dev/",
          lifecycle: "ACTIVE",
          publicationState: "PUBLISHED",
          muralEnabled: true,
        },
      ],
      [],
      [{ origin: "https://demo-dev.entrelacos.workers.dev" }],
      ...completeDatasetResults(),
    ]);
    mocks.bootstrapOwner.mockResolvedValue({
      created: false,
      userId: "owner",
    });

    const result = await provisionDemoEnvironment(fixture.db as never, {
      target: "development",
      runtimeEnvironment: "development",
      productionAuthorized: false,
      resetAuthorized: false,
      publicUrl: "https://demo-dev.entrelacos.workers.dev/",
      owner: {
        email: "owner@example.test",
        name: "Owner",
        password: "fixture-password",
      },
    });

    expect(result).toMatchObject({ site: "preserved", reset: null });
    expect(mocks.resetDemoSite).not.toHaveBeenCalled();
    expect(fixture.updates).toHaveLength(0);
  });

  it("resets a complete existing demo only when explicitly requested", async () => {
    const fixture = fakeDatabase([
      [
        {
          isDemo: true,
          repositorySlug: "demo-wedding",
          provisioningKey: "repo:demo-wedding",
          displayName: "Marina & Caio",
          partnerOneName: "Marina",
          partnerTwoName: "Caio",
          eventDate: "2027-09-18",
          publicUrl: "https://demo-dev.entrelacos.workers.dev/",
          lifecycle: "ACTIVE",
          publicationState: "PUBLISHED",
          muralEnabled: true,
        },
      ],
      [],
      [{ origin: "https://demo-dev.entrelacos.workers.dev" }],
      ...completeDatasetResults(),
    ]);
    mocks.bootstrapOwner.mockResolvedValue({
      created: false,
      userId: "owner",
    });
    mocks.resetDemoSite.mockResolvedValue({
      siteId: "demo-wedding",
      resetAt: "2026-09-18T12:00:00.000Z",
    });

    const result = await provisionDemoEnvironment(fixture.db as never, {
      target: "development",
      runtimeEnvironment: "development",
      productionAuthorized: false,
      resetAuthorized: true,
      publicUrl: "https://demo-dev.entrelacos.workers.dev/",
      owner: {
        email: "owner@example.test",
        name: "Owner",
        password: "fixture-password",
      },
    });

    expect(result.site).toBe("preserved");
    expect(result.reset).toMatchObject({ siteId: "demo-wedding" });
    expect(mocks.resetDemoSite).toHaveBeenCalledOnce();
  });

  it("reactivates a disabled mural without resetting a complete dataset", async () => {
    const fixture = fakeDatabase([
      [
        {
          isDemo: true,
          repositorySlug: "demo-wedding",
          provisioningKey: "repo:demo-wedding",
          displayName: "Marina & Caio",
          partnerOneName: "Marina",
          partnerTwoName: "Caio",
          eventDate: "2027-09-18",
          publicUrl: "https://demo-dev.entrelacos.workers.dev/",
          lifecycle: "ACTIVE",
          publicationState: "PUBLISHED",
          muralEnabled: false,
        },
      ],
      [],
      [{ origin: "https://demo-dev.entrelacos.workers.dev" }],
      ...completeDatasetResults(),
    ]);
    mocks.bootstrapOwner.mockResolvedValue({
      created: false,
      userId: "owner",
    });

    const result = await provisionDemoEnvironment(fixture.db as never, {
      target: "development",
      runtimeEnvironment: "development",
      productionAuthorized: false,
      resetAuthorized: false,
      publicUrl: "https://demo-dev.entrelacos.workers.dev/",
      owner: {
        email: "owner@example.test",
        name: "Owner",
        password: "fixture-password",
      },
    });

    expect(result).toMatchObject({ site: "preserved", reset: null });
    expect(mocks.resetDemoSite).not.toHaveBeenCalled();
    expect(fixture.updates).toEqual([
      expect.objectContaining({
        muralEnabled: true,
        updatedAt: expect.any(Date),
      }),
    ]);
  });

  it("fails closed when an existing demo dataset is incomplete", async () => {
    const fixture = fakeDatabase([
      [
        {
          isDemo: true,
          repositorySlug: "demo-wedding",
          provisioningKey: "repo:demo-wedding",
          displayName: "Marina & Caio",
          partnerOneName: "Marina",
          partnerTwoName: "Caio",
          eventDate: "2027-09-18",
          publicUrl: "https://demo-dev.entrelacos.workers.dev/",
          lifecycle: "ACTIVE",
          publicationState: "PUBLISHED",
          muralEnabled: false,
        },
      ],
      [],
      [{ origin: "https://demo-dev.entrelacos.workers.dev" }],
      mocks.datasetIds.invitationIds.map((id) => ({ id })),
      mocks.datasetIds.guestIds.slice(0, -1).map((id) => ({ id })),
    ]);

    await expect(
      provisionDemoEnvironment(fixture.db as never, {
        target: "development",
        runtimeEnvironment: "development",
        productionAuthorized: false,
        resetAuthorized: false,
        publicUrl: "https://demo-dev.entrelacos.workers.dev/",
        owner: {
          email: "owner@example.test",
          name: "Owner",
          password: "fixture-password",
        },
      }),
    ).rejects.toThrow("explicit reset confirmation is required");
    expect(mocks.bootstrapOwner).not.toHaveBeenCalled();
    expect(mocks.resetDemoSite).not.toHaveBeenCalled();
  });

  it("recovers an incomplete existing demo only with explicit reset authorization", async () => {
    const fixture = fakeDatabase([
      [
        {
          isDemo: true,
          repositorySlug: "demo-wedding",
          provisioningKey: "repo:demo-wedding",
          displayName: "Marina & Caio",
          partnerOneName: "Marina",
          partnerTwoName: "Caio",
          eventDate: "2027-09-18",
          publicUrl: "https://demo-dev.entrelacos.workers.dev/",
          lifecycle: "ACTIVE",
          publicationState: "PUBLISHED",
          muralEnabled: false,
        },
      ],
      [],
      [{ origin: "https://demo-dev.entrelacos.workers.dev" }],
      [],
      [],
    ]);
    mocks.bootstrapOwner.mockResolvedValue({
      created: false,
      userId: "owner",
    });
    mocks.resetDemoSite.mockResolvedValue({
      siteId: "demo-wedding",
      resetAt: "2026-09-18T12:00:00.000Z",
    });

    const result = await provisionDemoEnvironment(fixture.db as never, {
      target: "development",
      runtimeEnvironment: "development",
      productionAuthorized: false,
      resetAuthorized: true,
      publicUrl: "https://demo-dev.entrelacos.workers.dev/",
      owner: {
        email: "owner@example.test",
        name: "Owner",
        password: "fixture-password",
      },
    });

    expect(result.site).toBe("preserved");
    expect(result.reset).toMatchObject({
      siteId: "demo-wedding",
      resetAt: "2026-09-18T12:00:00.000Z",
    });
    expect(mocks.resetDemoSite).toHaveBeenCalledOnce();
    expect(fixture.updates).toEqual([
      { muralEnabled: true, updatedAt: new Date("2026-09-18T12:00:00.000Z") },
    ]);
  });
});
