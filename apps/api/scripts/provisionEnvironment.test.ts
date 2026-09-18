import { beforeEach, describe, expect, it, vi } from "vitest";
import { runEnvironmentProvision } from "./provisionEnvironment";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  verify: vi.fn(),
  provision: vi.fn(),
}));

vi.mock("@entrelacos/database", () => ({
  createDatabaseConnection: mocks.create,
  verifyDatabaseConnection: mocks.verify,
}));

vi.mock("../src/environmentProvision", () => ({
  provisionDemoEnvironment: mocks.provision,
}));

const completeEnvironment = (overrides: NodeJS.ProcessEnv = {}) => ({
  ENTRELACOS_DATABASE_TARGET: "development",
  RAILWAY_ENVIRONMENT_NAME: "development",
  ENTRELACOS_PROVISION_CONFIRM: "PROVISION development demo-wedding",
  ENTRELACOS_OWNER_EMAIL: "owner@example.test",
  ENTRELACOS_OWNER_NAME: "Owner",
  ENTRELACOS_OWNER_PASSWORD: "fixture-password",
  ENTRELACOS_DEMO_PUBLIC_URL: "https://demo-dev.entrelacos.workers.dev/",
  ...overrides,
});

describe("environment provisioning command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects before connecting without exact confirmation", async () => {
    await expect(
      runEnvironmentProvision(
        completeEnvironment({
          ENTRELACOS_PROVISION_CONFIRM: "PROVISION production demo-wedding",
        }),
      ),
    ).rejects.toThrow();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects production when target is not explicitly confirmed", async () => {
    await expect(
      runEnvironmentProvision(
        completeEnvironment({
          ENTRELACOS_DATABASE_TARGET: "production",
          ENTRELACOS_DEMO_PUBLIC_URL: "https://demo.entrelacos.workers.dev/",
        }),
      ),
    ).rejects.toThrow();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects when Railway environment does not match the selected target", async () => {
    await expect(
      runEnvironmentProvision(
        completeEnvironment({ RAILWAY_ENVIRONMENT_NAME: "production" }),
      ),
    ).rejects.toThrow();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("requires the explicit production authorization gate", async () => {
    await expect(
      runEnvironmentProvision(
        completeEnvironment({
          ENTRELACOS_DATABASE_TARGET: "production",
          RAILWAY_ENVIRONMENT_NAME: "production",
          ENTRELACOS_PROVISION_CONFIRM: "PROVISION production demo-wedding",
          ENTRELACOS_DEMO_PUBLIC_URL: "https://demo.entrelacos.workers.dev/",
        }),
      ),
    ).rejects.toThrow();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("verifies the selected database before provisioning", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const db = {};
    mocks.create.mockReturnValue({ db, close });
    mocks.verify.mockResolvedValue(undefined);
    mocks.provision.mockResolvedValue({
      owner: { created: true, userId: "owner-id" },
      siteId: "demo-wedding",
      reset: { result: "RESET" },
    });

    await runEnvironmentProvision(completeEnvironment());

    expect(mocks.create).toHaveBeenCalledWith({
      target: "development",
      env: expect.any(Object),
    });
    expect(mocks.verify).toHaveBeenCalledWith({ db, close });
    expect(mocks.provision).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
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
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves password whitespace when passing owner credentials", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.create.mockReturnValue({ db: {}, close });
    mocks.verify.mockResolvedValue(undefined);
    mocks.provision.mockResolvedValue({
      owner: { created: true, userId: "owner-id" },
      site: "created",
      reset: { result: "RESET" },
    });

    await runEnvironmentProvision(
      completeEnvironment({
        ENTRELACOS_OWNER_PASSWORD: "  fixture-password  ",
      }),
    );

    expect(mocks.provision).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        owner: expect.objectContaining({
          password: "  fixture-password  ",
        }),
        runtimeEnvironment: "development",
      }),
    );
  });

  it("passes explicit reset authorization only for the exact target confirmation", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.create.mockReturnValue({ db: {}, close });
    mocks.verify.mockResolvedValue(undefined);
    mocks.provision.mockResolvedValue({
      owner: { created: false, userId: "owner-id" },
      site: "preserved",
      reset: null,
    });

    await runEnvironmentProvision(
      completeEnvironment({
        ENTRELACOS_DEMO_RESET_CONFIRM: "RESET development demo-wedding",
      }),
    );

    expect(mocks.provision).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ resetAuthorized: true }),
    );
  });

  it("rejects a non-exact reset confirmation before connecting", async () => {
    await expect(
      runEnvironmentProvision(
        completeEnvironment({
          ENTRELACOS_DEMO_RESET_CONFIRM: "RESET production demo-wedding",
        }),
      ),
    ).rejects.toThrow();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
