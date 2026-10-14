import { describe, expect, it } from "vitest";
import { isLocalGiftPreview } from "./localGiftPreview";

describe("local gift preview eligibility", () => {
  it.each([
    "http://127.0.0.1:4325/gift-preview",
    "http://localhost:4325/gift-preview",
    "http://[::1]:4325/gift-preview",
  ])("allows development on explicit loopback %s", (url) => {
    expect(isLocalGiftPreview(true, new URL(url))).toBe(true);
    expect(isLocalGiftPreview(false, new URL(url))).toBe(false);
  });
  it.each([
    "https://demo.entrelacos.workers.dev/gift-preview",
    "http://192.168.1.2:4325/gift-preview",
    "http://localhost.evil.test/gift-preview",
    "http://127.0.0.1.evil.test/gift-preview",
  ])("refuses non-loopback hosts %s", (url) => {
    expect(isLocalGiftPreview(true, new URL(url))).toBe(false);
  });
});
