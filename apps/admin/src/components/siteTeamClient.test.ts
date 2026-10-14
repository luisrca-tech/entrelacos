import { describe, expect, it, vi } from "vitest";
import {
  issueTeamInvitation,
  loadSiteTeam,
  teamInvitationUrl,
} from "./siteTeamClient";

const token = "a".repeat(43);
const invitation = {
  id: "invite-a",
  siteId: "wedding-a",
  email: "helper@example.test",
  inviteeName: "Helper",
  expiresAt: "2026-10-13T00:00:00.000Z",
  consumedAt: null,
  revokedAt: null,
};
describe("site team client boundary", () => {
  it("loads only the scoped team and refuses cross-site records", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ members: [], invitations: [invitation] });
    await expect(loadSiteTeam("wedding-a", request)).resolves.toEqual({
      members: [],
      invitations: [invitation],
    });
    expect(request).toHaveBeenCalledWith("/v1/sites/wedding-a/team");
    await expect(loadSiteTeam("wedding-b", request)).rejects.toThrow();
  });
  it("issues strict role-free invitations and checks the returned site", async () => {
    const request = vi.fn().mockResolvedValue({ invitation, token });
    await expect(
      issueTeamInvitation(
        "wedding-a",
        { name: "Helper", email: "helper@example.test" },
        request,
      ),
    ).resolves.toEqual({ invitation, token });
    expect(request).toHaveBeenCalledWith(
      "/v1/sites/wedding-a/team/invitations",
      {
        method: "POST",
        body: { name: "Helper", email: "helper@example.test" },
      },
    );
    await expect(
      issueTeamInvitation(
        "wedding-a",
        { name: "Helper", email: "helper@example.test", role: "OWNER" },
        request,
      ),
    ).rejects.toThrow();
    await expect(
      issueTeamInvitation(
        "wedding-b",
        { name: "Helper", email: "helper@example.test" },
        request,
      ),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("keeps capabilities in URL fragments and rejects non-origin or malformed links", () => {
    const link = new URL(
      teamInvitationUrl("https://panel.example.test", token),
    );
    expect(link.pathname).toBe("/join-team");
    expect(link.search).toBe("");
    expect(link.hash).toBe(`#token=${token}`);
    for (const origin of [
      "javascript:alert(1)",
      "https://panel.example.test/path",
      "https://user:pass@panel.example.test",
    ]) {
      expect(() => teamInvitationUrl(origin, token)).toThrow();
    }
    expect(() =>
      teamInvitationUrl("https://panel.example.test", "short"),
    ).toThrow();
  });
});
