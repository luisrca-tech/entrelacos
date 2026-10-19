import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  payment: vi.fn(),
  receiving: vi.fn(),
  history: vi.fn(),
}));
vi.mock("./giftPaymentComposition", () => ({
  createGiftPaymentComposition: mocks.payment,
}));
vi.mock("./receivingSetupComposition", () => ({
  createReceivingSetupComposition: mocks.receiving,
}));
vi.mock("./giftPaymentHistoryComposition", () => ({
  createGiftPaymentHistoryApplication: mocks.history,
}));

import { createGiftApplication } from "./giftApplication";

describe("gift application integration", () => {
  it("forwards operational ports, starts processing only after app creation and drains all compositions once", async () => {
    const events: string[] = [];
    const receiving = { receivingSetup: { fixture: "setup" } };
    const payment = { giftPayments: { fixture: "payments" } };
    const start = vi.fn(() => events.push("start"));
    const closePayments = vi.fn(async () => {
      events.push("payment-close");
    });
    const closeReceiving = vi.fn(async () => {
      events.push("receiving-close");
    });
    const closeHistory = vi.fn(async () => {
      events.push("history-close");
    });
    const app = { fetch: vi.fn(), close: closeHistory };
    mocks.payment.mockReturnValue({
      ports: payment,
      start,
      close: closePayments,
    });
    mocks.receiving.mockReturnValue({
      ports: receiving,
      close: closeReceiving,
    });
    mocks.history.mockImplementation(async (...args: unknown[]) => {
      expect(start).not.toHaveBeenCalled();
      expect(args[2]).toMatchObject({
        ...receiving,
        ...payment,
        auth: { fixture: "auth" },
      });
      events.push("app-created");
      return app;
    });
    const config = {
      giftPayment: { mode: "sandbox" },
      giftPublicOrigin: "http://localhost:4321",
      giftPaymentHistory: { mode: "sandbox" },
    } as never;
    const application = await createGiftApplication(
      config,
      { db: {} } as never,
      { fixture: "auth" } as never,
      {},
    );
    expect(events).toEqual(["app-created", "start"]);
    expect(application.fetch).toBe(app.fetch);
    const closing = application.close();
    expect(application.close()).toBe(closing);
    await closing;
    expect(closePayments).toHaveBeenCalledOnce();
    expect(closeReceiving).toHaveBeenCalledOnce();
    expect(closeHistory).toHaveBeenCalledOnce();
  });
});
