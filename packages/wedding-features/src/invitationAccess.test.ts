import { describe, expect, it, vi } from "vitest";
import { GuestAccessApi } from "./guestAccess";

const token = "s".repeat(43);

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

describe("public invitation access client", () => {
  it("submits site-scoped phone and PIN without a name or challenge", async () => {
    const fetcher = vi.fn(async () =>
      json({
        sessionToken: token,
        siteId: "casamento-a",
        invitationId: "invitation-a",
        invitationName: "Família Silva",
        guests: [
          {
            id: "guest-a",
            fullName: "Ana",
            guestType: "ADULT",
            rsvpState: "PENDING",
          },
        ],
        expiresAt: "2028-01-01T00:00:00.000Z",
      }),
    );
    const api = new GuestAccessApi({
      apiOrigin: "https://api.example.test",
      siteId: "casamento-a",
      fetcher,
    });

    const session = await api.access({
      phone: "62999999999",
      accessPin: "123456",
    });

    expect(session.invitationName).toBe("Família Silva");
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.example.test/v1/public/sites/casamento-a/invitation/access",
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        body: JSON.stringify({ phone: "+5562999999999", accessPin: "123456" }),
      }),
    );
  });

  it("reads and writes invitation-scoped RSVP with guest IDs", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        json(
          init?.method === "POST"
            ? {
                requestId: "f4217d1d-bcae-4ac1-a67b-fabc195b7b86",
                acceptedAt: "2028-04-01T12:00:00.000Z",
                result: "APPLIED",
                replayed: false,
                guests: [
                  {
                    id: "guest-a",
                    fullName: "Ana",
                    guestType: "ADULT",
                    state: "CONFIRMED",
                    revision: 1,
                  },
                ],
              }
            : {
                siteId: "casamento-a",
                invitationId: "invitation-a",
                invitationName: "Família Silva",
                deadlineAt: null,
                deadlineTimezone: null,
                serverNow: "2028-04-01T12:00:00.000Z",
                canEdit: true,
                readOnlyReason: null,
                guests: [
                  {
                    id: "guest-a",
                    fullName: "Ana",
                    guestType: "ADULT",
                    state: "PENDING",
                    revision: 0,
                  },
                ],
              },
        ),
    );
    const api = new GuestAccessApi({
      apiOrigin: "https://api.example.test",
      siteId: "casamento-a",
      fetcher,
    });

    await api.getRsvp(token);
    await api.saveRsvp(token, {
      requestId: "f4217d1d-bcae-4ac1-a67b-fabc195b7b86",
      guests: [{ guestId: "guest-a", state: "CONFIRMED", expectedRevision: 0 }],
    });

    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "https://api.example.test/v1/public/invitation/rsvp",
      "https://api.example.test/v1/public/invitation/rsvp",
    ]);
    expect(fetcher.mock.calls[1]?.[1]?.body).toContain('"guestId":"guest-a"');
  });
});
