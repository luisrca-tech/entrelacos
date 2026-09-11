import { describe, expect, it, vi } from "vitest";
import {
  clearGuestSession,
  GuestAccessApi,
  GuestAccessApiError,
  getGuestDeliveryMessage,
  getGuestLeaveNotice,
  getGuestSessionStorageKey,
  getResendCountdownSeconds,
  guestAccessErrorMessage,
  readGuestSession,
  shouldDiscardGuestChallenge,
  writeGuestSession,
} from "./guestAccess";

function response(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("guest access client", () => {
  it("invokes the browser fetch function without rebinding its receiver", async () => {
    const fetcher = vi.fn(function (this: unknown) {
      expect(this).toBeUndefined();
      return Promise.resolve(
        response({
          challengeId: "a".repeat(43),
          expiresAt: "2026-09-11T12:10:00.000Z",
          resendAvailableAt: "2026-09-11T12:01:00.000Z",
          sendStatus: "PROVIDER_ACCEPTED",
          deliveryMode: "REAL_SMS",
        }),
      );
    });
    const api = new GuestAccessApi({
      apiOrigin: "https://api.example.test",
      siteId: "casamento-a",
      fetcher,
    });

    await expect(
      api.start({ fullName: "Ana Silva", phone: "62999999999" }),
    ).resolves.toMatchObject({ sendStatus: "PROVIDER_ACCEPTED" });
  });

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
    writeGuestSession(storage, "casamento-a", "a".repeat(43));
    expect(readGuestSession(storage, "casamento-a")).toBe("a".repeat(43));
    expect(readGuestSession(storage, "casamento-b")).toBeNull();
    clearGuestSession(storage, "casamento-a");
    expect(readGuestSession(storage, "casamento-a")).toBeNull();
  });

  it("counts down from the server-provided resend instant", () => {
    const now = Date.parse("2026-09-11T12:00:00.000Z");
    expect(getResendCountdownSeconds("2026-09-11T12:01:00.000Z", now)).toBe(60);
    expect(getResendCountdownSeconds("2026-09-11T12:00:00.500Z", now)).toBe(1);
    expect(getResendCountdownSeconds("2026-09-11T11:59:59.000Z", now)).toBe(0);
  });

  it("uses direct API requests and bearer auth only for session calls", async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push([String(input), init ?? {}]);
        if (calls.length === 1)
          return response({
            challengeId: "a".repeat(43),
            expiresAt: "2026-09-11T12:10:00.000Z",
            resendAvailableAt: "2026-09-11T12:01:00.000Z",
            sendStatus: "PROVIDER_ACCEPTED",
            deliveryMode: "REAL_SMS",
          });
        return response({
          siteId: "casamento-a",
          groupId: "grupo-a",
          members: [
            { id: "membro-a", fullName: "Ana", isRepresentative: true },
          ],
          expiresAt: "2026-09-18T12:00:00.000Z",
        });
      },
    );
    const api = new GuestAccessApi({
      apiOrigin: "https://api.example.test",
      siteId: "casamento-a",
      fetcher,
    });

    const challenge = await api.start({
      fullName: "Ana",
      phone: "62999999999",
    });
    await api.getSession("b".repeat(43));

    expect(challenge.deliveryMode).toBe("REAL_SMS");
    expect(calls[0]?.[0]).toBe(
      "https://api.example.test/v1/public/sites/casamento-a/guest/challenge",
    );
    expect(calls[0]?.[1].credentials).toBe("omit");
    expect(calls[0]?.[1].body).toContain('"phone":"+5562999999999"');
    expect(calls[0]?.[1].headers).not.toHaveProperty("Authorization");
    expect(calls[1]?.[1].headers).toMatchObject({
      Authorization: `Bearer ${"b".repeat(43)}`,
    });
    expect(calls[1]?.[1].credentials).toBe("omit");
  });

  it("sends an owner-issued demo grant only in the dedicated header", async () => {
    const grant = `${"g".repeat(24)}.${"s".repeat(43)}`;
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        response({
          challengeId: "a".repeat(43),
          expiresAt: "2026-09-11T12:10:00.000Z",
          resendAvailableAt: "2026-09-11T12:01:00.000Z",
          sendStatus: "PROVIDER_ACCEPTED",
          deliveryMode: "SIMULATED",
          simulationCode: "123456",
        }),
    );
    const api = new GuestAccessApi({
      apiOrigin: "https://api.example.test",
      siteId: "casamento-demo",
      fetcher,
    });

    await api.start({ fullName: "Ana", phone: "62999999999" }, grant);

    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).not.toContain(grant);
    expect(init?.headers).toMatchObject({
      "X-EntreLacos-Demo-Grant": grant,
    });
    expect(init?.credentials).toBe("omit");
  });

  it("rejects unsafe public API origins", () => {
    expect(
      () =>
        new GuestAccessApi({
          apiOrigin: "https://api.example.test/private?token=secret",
          siteId: "casamento-a",
        }),
    ).toThrow("Invalid public API origin");
  });

  it("preserves contextual rate-limit information", async () => {
    const fetcher = vi.fn(async () =>
      response(
        {
          code: "OTP_COOLDOWN",
          retryAfterSeconds: 43,
        },
        { status: 429 },
      ),
    );
    const api = new GuestAccessApi({
      apiOrigin: "http://localhost:8080",
      siteId: "casamento-a",
      fetcher,
    });

    await expect(
      api.start({ fullName: "Ana", phone: "+5562999999999" }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GuestAccessApiError>>({
        status: 429,
        code: "OTP_COOLDOWN",
        retryAfterSeconds: 43,
      }),
    );
  });

  it("reads the backend Retry-After header for cooldown messages", async () => {
    const fetcher = vi.fn(async () =>
      response(
        { code: "RESEND_TOO_SOON" },
        { status: 429, headers: { "Retry-After": "17" } },
      ),
    );
    const api = new GuestAccessApi({
      apiOrigin: "http://localhost:8080",
      siteId: "casamento-a",
      fetcher,
    });

    await expect(api.resend("a".repeat(43))).rejects.toEqual(
      expect.objectContaining({
        status: 429,
        code: "RESEND_TOO_SOON",
        retryAfterSeconds: 17,
      }),
    );
  });

  it("maps backend verification outcomes to non-disclosing Portuguese messages", () => {
    expect(
      guestAccessErrorMessage(new GuestAccessApiError(404, "GUEST_NOT_FOUND")),
    ).toContain("Não encontramos um convite");
    expect(
      guestAccessErrorMessage(
        new GuestAccessApiError(422, "FOREIGN_GUEST_CONTACT_ADMIN"),
      ),
    ).toContain("atendimento administrativo");
    expect(
      guestAccessErrorMessage(new GuestAccessApiError(401, "INVALID_CODE")),
    ).toContain("código não confere");
    expect(
      guestAccessErrorMessage(
        new GuestAccessApiError(429, "CHALLENGE_COOLDOWN", 15),
      ),
    ).toContain("15 segundos");
  });

  it("does not claim that an unconfirmed real delivery was sent", () => {
    expect(getGuestDeliveryMessage("REAL_SMS", "PROVIDER_ACCEPTED")).toContain(
      "Enviamos",
    );
    expect(getGuestDeliveryMessage("REAL_SMS", "UNKNOWN")).not.toContain(
      "Enviamos",
    );
    expect(getGuestDeliveryMessage("SIMULATED", "UNKNOWN")).toContain(
      "não envia SMS real",
    );
  });

  it("discards a challenge only after a final delivery failure", () => {
    expect(shouldDiscardGuestChallenge("FAILED_FINAL")).toBe(true);
    expect(shouldDiscardGuestChallenge("PROVIDER_ACCEPTED")).toBe(false);
    expect(shouldDiscardGuestChallenge("UNKNOWN")).toBe(false);
  });

  it("distinguishes confirmed server leave from local-only cleanup", () => {
    expect(getGuestLeaveNotice(true)).toContain("Você saiu");
    expect(getGuestLeaveNotice(false)).toContain("neste navegador");
    expect(getGuestLeaveNotice(false)).toContain("servidor");
  });
});
