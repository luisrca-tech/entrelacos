import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  verify: vi.fn(),
  register: vi.fn(),
  close: vi.fn(),
}));
vi.mock("@entrelacos/database", () => ({
  createDatabaseConnection: mocks.create,
  verifyDatabaseConnection: mocks.verify,
}));
vi.mock("../src/giftPaymentConfig", () => ({
  readGiftPaymentConfig: (env: NodeJS.ProcessEnv, target: string) => ({
    mode: env.ASAAS_MODE,
    applicationEnvironment: target,
  }),
}));
vi.mock("../src/sandboxWebhookRegistration", () => ({
  registerAsaasWebhook: mocks.register,
}));

import { runAsaasWebhookRegistration } from "./registerAsaasWebhook";

const production = {
  APP_ENV: "production",
  ASAAS_MODE: "live",
  ENTRELACOS_WEBHOOK_SITE_ID: "site-one",
  ENTRELACOS_WEBHOOK_ACCOUNT_ID: "account-one",
  ASAAS_WEBHOOK_NOTIFICATION_EMAIL: "alerts@example.test",
  ENTRELACOS_WEBHOOK_CONFIRM:
    "REGISTER production webhook site-one account-one",
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.create.mockReturnValue({ db: {}, close: mocks.close });
  mocks.verify.mockResolvedValue(undefined);
  mocks.register.mockResolvedValue({
    state: "REGISTERED",
    providerWebhookId: "webhook-one",
  });
});

describe("explicit Asaas webhook operator", () => {
  it("verifies the selected production identity before one explicit registration and closes its connection", async () => {
    await expect(runAsaasWebhookRegistration(production)).resolves.toEqual({
      state: "REGISTERED",
      providerWebhookId: "webhook-one",
    });
    expect(mocks.create).toHaveBeenCalledWith({
      target: "production",
      env: production,
    });
    expect(mocks.verify.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.register.mock.invocationCallOrder[0],
    );
    expect(mocks.register).toHaveBeenCalledWith(
      {},
      { mode: "live", applicationEnvironment: "production" },
      {
        siteId: "site-one",
        accountId: "account-one",
        notificationEmail: "alerts@example.test",
      },
    );
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it.each([
    { ENTRELACOS_WEBHOOK_CONFIRM: undefined },
    { ENTRELACOS_WEBHOOK_CONFIRM: "REGISTER production webhook other other" },
    { APP_ENV: "test" },
    { ASAAS_MODE: "sandbox" },
    { RAILWAY_ENVIRONMENT_NAME: "development" },
    { ENTRELACOS_WEBHOOK_ACCOUNT_ID: undefined },
  ])(
    "rejects mismatched operator scope before database access (%#)",
    async (override) => {
      await expect(
        runAsaasWebhookRegistration({ ...production, ...override }),
      ).rejects.toThrow();
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.register).not.toHaveBeenCalled();
    },
  );

  it("closes the connection without registering when identity verification fails", async () => {
    mocks.verify.mockRejectedValue(new Error("Synthetic identity failure"));
    await expect(runAsaasWebhookRegistration(production)).rejects.toThrow();
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("returns an unknown registration without retrying or clearing its durable state", async () => {
    mocks.register.mockResolvedValue({
      state: "UNKNOWN",
      providerWebhookId: null,
    });
    await expect(runAsaasWebhookRegistration(production)).resolves.toEqual({
      state: "UNKNOWN",
      providerWebhookId: null,
    });
    expect(mocks.register).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
