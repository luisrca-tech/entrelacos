import type { GiftQuote } from "@entrelacos/contracts";
import { describe, expect, it, vi } from "vitest";
import { submitGiftCheckout } from "./giftCheckoutSubmission";
import { WeddingGiftsApiError } from "./gifts";

const pending = {
  quoteId: "quote-a",
  requestId: "request-a",
  recoveryToken: "A".repeat(43),
  method: "PIX",
  mode: "sandbox",
} as const;
const quote = {
  id: pending.quoteId,
  siteId: "wedding-a",
  method: pending.method,
  mode: pending.mode,
} as GiftQuote;
function storage(value: unknown = pending) {
  return {
    getItem: vi.fn().mockReturnValue(JSON.stringify(value)),
    removeItem: vi.fn(),
  };
}
describe("checkout submission ownership", () => {
  it("ignores a late successful response after disposal or API replacement", async () => {
    let finish: (value: never) => void = () => {};
    let current = true;
    const target = storage();
    const api = {
      createCheckout: vi.fn(
        () =>
          new Promise<never>((resolve) => {
            finish = resolve;
          }),
      ),
    };
    const result = submitGiftCheckout(
      api,
      quote,
      pending,
      () => target,
      () => current,
    );
    current = false;
    finish({ hostedUrl: "https://checkout.example.test" } as never);
    expect(await result).toBeNull();
    expect(target.removeItem).not.toHaveBeenCalled();
  });
  it("ignores a late known rejection before touching the marker", async () => {
    let fail: (error: Error) => void = () => {};
    let current = true;
    const target = storage();
    const api = {
      createCheckout: vi.fn(
        () =>
          new Promise<never>((_, reject) => {
            fail = reject;
          }),
      ),
    };
    const result = submitGiftCheckout(
      api,
      quote,
      pending,
      () => target,
      () => current,
    );
    current = false;
    fail(new WeddingGiftsApiError(409, "QUOTE_EXPIRED"));
    expect(await result).toBeNull();
    expect(target.getItem).not.toHaveBeenCalled();
    expect(target.removeItem).not.toHaveBeenCalled();
  });
  it("releases a known refusal only after clearing the identical operation", async () => {
    const target = storage();
    const result = await submitGiftCheckout(
      {
        createCheckout: vi
          .fn()
          .mockRejectedValue(new WeddingGiftsApiError(409, "QUOTE_EXPIRED")),
      },
      quote,
      pending,
      () => target,
    );
    expect(target.removeItem).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      type: "CHECKOUT_FAILED",
      unknown: false,
      invalidateQuote: true,
    });
  });
  it.each(["replaced", "corrupt", "missing", "denied"])(
    "keeps a known refusal locked when recovery storage is %s",
    async (scenario) => {
      const target = storage(
        scenario === "replaced"
          ? { ...pending, requestId: "new-request" }
          : pending,
      );
      if (scenario === "corrupt") target.getItem.mockReturnValue("broken");
      if (scenario === "missing") target.getItem.mockReturnValue(null);
      if (scenario === "denied")
        target.removeItem.mockImplementation(() => {
          throw new Error("private failure");
        });
      const event = await submitGiftCheckout(
        {
          createCheckout: vi
            .fn()
            .mockRejectedValue(new WeddingGiftsApiError(409, "QUOTE_EXPIRED")),
        },
        quote,
        pending,
        () => target,
      );
      expect(event).toMatchObject({
        type: "CHECKOUT_FAILED",
        unknown: true,
        invalidateQuote: false,
      });
      expect(JSON.stringify(event)).not.toContain("private failure");
      if (scenario !== "denied")
        expect(target.removeItem).not.toHaveBeenCalled();
    },
  );
  it("preserves unknown outcomes without removing recovery", async () => {
    const target = storage();
    const event = await submitGiftCheckout(
      {
        createCheckout: vi
          .fn()
          .mockRejectedValue(new Error("private provider error")),
      },
      quote,
      pending,
      () => target,
    );
    expect(event).toMatchObject({ type: "CHECKOUT_FAILED", unknown: true });
    expect(target.removeItem).not.toHaveBeenCalled();
    expect(JSON.stringify(event)).not.toContain("private provider error");
  });
});
