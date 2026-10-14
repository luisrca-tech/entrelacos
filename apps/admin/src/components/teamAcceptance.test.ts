import { describe, expect, it, vi } from "vitest";
import { acceptTeamInvitation } from "./teamAcceptance";

const token = "a".repeat(43);
describe("team invitation acceptance client", () => {
  it("signs into existing credentials but sends no password for membership acceptance", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ siteId: "wedding-a" });
    await expect(
      acceptTeamInvitation(
        token,
        {
          mode: "existing",
          email: "helper@example.test",
          password: "existing-password",
        },
        request,
      ),
    ).resolves.toEqual({ siteId: "wedding-a" });
    expect(request.mock.calls).toEqual([
      [
        "/v1/auth/sign-in/email",
        {
          method: "POST",
          body: { email: "helper@example.test", password: "existing-password" },
        },
      ],
      ["/v1/team-invitations/accept", { method: "POST", body: { token } }],
    ]);
  });
  it("passes only a new password for a new-account token, or token for an existing session", async () => {
    const request = vi.fn().mockResolvedValue({ siteId: "wedding-a" });
    await acceptTeamInvitation(
      token,
      { mode: "new", password: "secret12" },
      request,
    );
    expect(request).toHaveBeenLastCalledWith("/v1/team-invitations/accept", {
      method: "POST",
      body: { token, password: "secret12" },
    });
    await acceptTeamInvitation(token, { mode: "signedIn" }, request);
    expect(request).toHaveBeenLastCalledWith("/v1/team-invitations/accept", {
      method: "POST",
      body: { token },
    });
  });
  it("does not authenticate malformed capabilities or accept after failed login", async () => {
    const request = vi.fn().mockRejectedValue(new Error("login rejected"));
    await expect(
      acceptTeamInvitation(
        "short",
        {
          mode: "existing",
          email: "helper@example.test",
          password: "secret12",
        },
        request,
      ),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    await expect(
      acceptTeamInvitation(
        token,
        {
          mode: "existing",
          email: "helper@example.test",
          password: "secret12",
        },
        request,
      ),
    ).rejects.toThrow("login rejected");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
