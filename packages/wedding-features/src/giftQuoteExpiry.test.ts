import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleGiftQuoteExpiry } from "./giftQuoteExpiry";

const start = Date.parse("2026-10-12T12:00:00.000Z");
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
});
afterEach(() => vi.useRealTimers());

describe("idle quote expiry notification", () => {
  it("notifies exactly at expiry without interaction and only once", () => {
    const expired = vi.fn();
    scheduleGiftQuoteExpiry(new Date(start + 3000).toISOString(), expired);
    vi.advanceTimersByTime(2999);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expired).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels an obsolete quote when replacing it or disposing the view", () => {
    const oldExpiry = vi.fn();
    const currentExpiry = vi.fn();
    const cancel = scheduleGiftQuoteExpiry(
      new Date(start + 3000).toISOString(),
      oldExpiry,
    );
    vi.advanceTimersByTime(1000);
    cancel();
    scheduleGiftQuoteExpiry(
      new Date(start + 5000).toISOString(),
      currentExpiry,
    );
    vi.advanceTimersByTime(2000);
    expect(oldExpiry).not.toHaveBeenCalled();
    expect(currentExpiry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(currentExpiry).toHaveBeenCalledTimes(1);
  });
  it.each([
    new Date(start).toISOString(),
    new Date(start - 1).toISOString(),
    "invalid",
  ])("settles already expired or invalid deadlines safely: %s", (deadline) => {
    const expired = vi.fn();
    const cancel = scheduleGiftQuoteExpiry(deadline, expired);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    cancel();
    vi.advanceTimersByTime(3000);
    expect(expired).toHaveBeenCalledTimes(1);
  });
  it("rechecks the actual deadline after a backwards clock change", () => {
    const expired = vi.fn();
    scheduleGiftQuoteExpiry(new Date(start + 3000).toISOString(), expired);
    vi.advanceTimersByTime(2000);
    vi.setSystemTime(start - 2000);
    vi.advanceTimersByTime(1000);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4000);
    expect(expired).toHaveBeenCalledTimes(1);
  });
  it("bounds long timer delays without marking a future quote expired early", () => {
    const maximumDelay = 2_147_483_647;
    const expired = vi.fn();
    scheduleGiftQuoteExpiry(
      new Date(start + maximumDelay + 2000).toISOString(),
      expired,
    );
    vi.advanceTimersByTime(maximumDelay);
    expect(expired).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(expired).toHaveBeenCalledTimes(1);
  });
});
