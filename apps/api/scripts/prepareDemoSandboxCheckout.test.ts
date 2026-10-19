import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDatabaseConnection: vi.fn(),
  verifyDatabaseConnection: vi.fn(),
  readGiftPaymentConfig: vi.fn(),
  prepareDemoSandboxCheckout: vi.fn(),
}));
vi.mock("@entrelacos/database", () => ({
  createDatabaseConnection: mocks.createDatabaseConnection,
  verifyDatabaseConnection: mocks.verifyDatabaseConnection,
}));
vi.mock("../src/giftPaymentConfig", () => ({
  readGiftPaymentConfig: mocks.readGiftPaymentConfig,
}));
vi.mock("../src/demoSandboxCheckoutSetup", () => ({
  demoSandboxCheckoutConfirmation:
    "PREPARE development demo-wedding Sandbox checkout simulation",
  prepareDemoSandboxCheckout: mocks.prepareDemoSandboxCheckout,
}));

import { runDemoSandboxCheckoutPreparation } from "./prepareDemoSandboxCheckout";

const env = {
  ENTRELACOS_DATABASE_TARGET: "development",
  ENTRELACOS_DEMO_CHECKOUT_CONFIRM:
    "PREPARE development demo-wedding Sandbox checkout simulation",
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.readGiftPaymentConfig.mockReturnValue({ mode: "sandbox" });
});
describe("explicit demo fixture command", () => {
  it.each([
    { ...env, ENTRELACOS_DATABASE_TARGET: "production" },
    { ...env, NODE_ENV: "production" },
    { ...env, RAILWAY_ENVIRONMENT_NAME: "production" },
    { ...env, ENTRELACOS_DEMO_CHECKOUT_CONFIRM: "yes" },
  ])("rejects incompatible invocation before any connection", async (input) => {
    await expect(runDemoSandboxCheckoutPreparation(input)).rejects.toThrow();
    expect(mocks.createDatabaseConnection).not.toHaveBeenCalled();
  });
  it("closes its connection when database identity verification fails before fixture writes", async () => {
    const close = vi.fn();
    mocks.createDatabaseConnection.mockReturnValue({ db: {}, close });
    mocks.verifyDatabaseConnection.mockRejectedValue(
      new Error("identity mismatch"),
    );
    await expect(runDemoSandboxCheckoutPreparation(env)).rejects.toThrow();
    expect(mocks.prepareDemoSandboxCheckout).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
