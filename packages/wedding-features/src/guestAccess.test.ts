import { describe, expect, it, vi } from "vitest";
import {
  clearGuestSession,
  GuestAccessApi,
  GuestAccessApiError,
  getGuestLeaveNotice,
  getGuestSessionStorageKey,
  guestAccessErrorMessage,
  guestSessionEventName,
  isValidVerificationCode,
  readGuestSession,
  writeGuestSession,
} from "./guestAccess";

function response(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("invitation access client safety", () => {
  it("namespaces and clears the session token per site", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    };

    expect(getGuestSessionStorageKey("casamento-a")).not.toBe(
      getGuestSessionStorageKey("casamento-b"),
    );
    expect(guestSessionEventName("casamento-a")).not.toBe(
      guestSessionEventName("casamento-b"),
    );
    writeGuestSession(storage, "casamento-a", "a".repeat(43));
    expect(readGuestSession(storage, "casamento-a")).toBe("a".repeat(43));
    expect(readGuestSession(storage, "casamento-b")).toBeNull();
    clearGuestSession(storage, "casamento-a");
    expect(readGuestSession(storage, "casamento-a")).toBeNull();
  });

  it("rejects unsafe public API origins and invalid PINs", () => {
    expect(
      () =>
        new GuestAccessApi({
          apiOrigin: "https://api.example.test/private?token=secret",
          siteId: "casamento-a",
        }),
    ).toThrow("Invalid public API origin");
    expect(isValidVerificationCode("123456")).toBe(true);
    expect(isValidVerificationCode("1234")).toBe(false);
  });

  it("retains the backend Retry-After header", async () => {
    const api = new GuestAccessApi({
      apiOrigin: "http://localhost:8080",
      siteId: "casamento-a",
      fetcher: vi.fn(async () =>
        response(
          { code: "INVITATION_ACCESS_RATE_LIMITED" },
          { status: 429, headers: { "Retry-After": "17" } },
        ),
      ),
    });

    await expect(
      api.access({ phone: "62999999999", accessPin: "123456" }),
    ).rejects.toMatchObject({
      status: 429,
      code: "INVITATION_ACCESS_RATE_LIMITED",
      retryAfterSeconds: 17,
    });
  });

  it("does not reveal whether a phone or PIN was wrong", () => {
    expect(
      guestAccessErrorMessage(
        new GuestAccessApiError(401, "INVITATION_ACCESS_INVALID"),
      ),
    ).toContain("telefone e PIN");
    expect(
      guestAccessErrorMessage(
        new GuestAccessApiError(429, "INVITATION_ACCESS_RATE_LIMITED", 15),
      ),
    ).toContain("15 segundos");
    expect(
      guestAccessErrorMessage(new GuestAccessApiError(409, "RSVP_CONFLICT")),
    ).toContain("dados foram alterados");
  });

  it("distinguishes confirmed server leave from local-only cleanup", () => {
    expect(getGuestLeaveNotice(true)).toContain("Você saiu");
    expect(getGuestLeaveNotice(false)).toContain("neste navegador");
  });
});
