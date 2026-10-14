import type { MeResponse } from "@entrelacos/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiRequest } from "../lib/apiClient";
import {
  Panel,
  PanelSessionView,
  signOutPanel,
  submitPanelSignOut,
} from "./Panel";
import {
  createPanelAuthenticationActions,
  panelActorOwner,
} from "./panelActor";

vi.mock("../lib/apiClient", async (original) => ({
  ...(await original<typeof import("../lib/apiClient")>()),
  apiRequest: vi.fn(),
}));
vi.mock("./AdminShell", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => children,
  ShellLoading: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("./SiteWorkspace", () => ({
  SiteWorkspace: ({
    sessionEpoch,
    access,
  }: {
    sessionEpoch: number;
    access: unknown;
  }) =>
    createElement(
      "div",
      { "data-epoch": sessionEpoch, "data-access": !!access },
      "workspace",
    ),
}));
const actor: MeResponse = {
  user: {
    id: "admin-1",
    name: "Admin",
    email: "admin@example.test",
    role: "OWNER",
  },
  session: { id: "session-1", expiresAt: "2026-10-19T00:00:00.000Z" },
  siteId: null,
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-12T18:00:00.000Z"));
});
afterEach(() => {
  panelActorOwner.invalidate(false);
  vi.resetAllMocks();
  vi.useRealTimers();
});
function render(
  status: "verified" | "loading" | "unverified" | "denied" | "unavailable",
  sessionEpoch: number | null = 7,
) {
  return renderToStaticMarkup(
    createElement(PanelSessionView, {
      siteId: "wedding-1",
      snapshot: { status, actor, sessionEpoch },
      onVerify: vi.fn(),
      onLogout: vi.fn(),
    }),
  );
}
describe("panel session boundary", () => {
  it("does not dispatch workspace actions before a verified session", async () => {
    const { mutateWorkspaceSession, issueWorkspaceAccess } =
      await vi.importActual<typeof import("./SiteWorkspace")>(
        "./SiteWorkspace",
      );
    const callbacks = {
      isActive: () => true,
      pending: vi.fn(),
      failed: vi.fn(),
    };
    expect(
      await mutateWorkspaceSession(
        null,
        "/v1/owner/sites/wedding-1",
        {},
        { ...callbacks, load: vi.fn(), success: vi.fn() },
      ),
    ).toBe(false);
    await issueWorkspaceAccess(null, {
      ...callbacks,
      userId: "admin-1",
      purpose: "RECOVERY",
      origin: "https://panel.example.test",
      clipboard: { writeText: vi.fn() },
      copied: vi.fn(),
    });
    expect(apiRequest).not.toHaveBeenCalled();
    expect(callbacks.pending).not.toHaveBeenCalled();
  });
  it("preserves current workspace mutation reload and success behavior", async () => {
    const { mutateWorkspaceSession } =
      await vi.importActual<typeof import("./SiteWorkspace")>(
        "./SiteWorkspace",
      );
    vi.mocked(apiRequest).mockResolvedValueOnce(actor);
    await panelActorOwner.load();
    vi.mocked(apiRequest).mockResolvedValueOnce({});
    const load = vi.fn().mockResolvedValue(undefined);
    const success = vi.fn();
    const pending = vi.fn();
    expect(
      await mutateWorkspaceSession(
        panelActorOwner.getSnapshot().sessionEpoch,
        "/v1/owner/sites/wedding-1",
        { displayName: "Wedding" },
        {
          method: "PATCH",
          load,
          success,
          pending,
          failed: vi.fn(),
          isActive: () => true,
        },
      ),
    ).toBe(true);
    expect(apiRequest).toHaveBeenLastCalledWith("/v1/owner/sites/wedding-1", {
      method: "PATCH",
      body: { displayName: "Wedding" },
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(success).toHaveBeenCalledTimes(1);
    expect(pending.mock.calls).toEqual([[true], [false]]);
  });
  it("does not report mutation success after its reload loses authority", async () => {
    const { mutateWorkspaceSession } =
      await vi.importActual<typeof import("./SiteWorkspace")>(
        "./SiteWorkspace",
      );
    vi.mocked(apiRequest).mockResolvedValueOnce(actor);
    await panelActorOwner.load();
    vi.mocked(apiRequest).mockResolvedValueOnce({});
    const success = vi.fn();
    const load = vi.fn(async () => {
      panelActorOwner.invalidate(false);
    });
    expect(
      await mutateWorkspaceSession(
        panelActorOwner.getSnapshot().sessionEpoch,
        "/v1/owner/sites/wedding-1",
        {},
        {
          load,
          success,
          pending: vi.fn(),
          failed: vi.fn(),
          isActive: () => true,
        },
      ),
    ).toBe(false);
    expect(success).not.toHaveBeenCalled();
  });
  it("copies only the current access link and reports the clipboard outcome", async () => {
    const { issueWorkspaceAccess } =
      await vi.importActual<typeof import("./SiteWorkspace")>(
        "./SiteWorkspace",
      );
    vi.mocked(apiRequest).mockResolvedValueOnce(actor);
    await panelActorOwner.load();
    vi.mocked(apiRequest).mockResolvedValueOnce({
      token: "fictional-credential",
    });
    const copied = vi.fn();
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    await issueWorkspaceAccess(panelActorOwner.getSnapshot().sessionEpoch, {
      userId: "admin-1",
      purpose: "RECOVERY",
      origin: "https://panel.example.test",
      clipboard,
      copied,
      failed: vi.fn(),
      pending: vi.fn(),
      isActive: () => true,
    });
    expect(clipboard.writeText).toHaveBeenCalledWith(
      "https://panel.example.test/recover#token=fictional-credential",
    );
    expect(copied).toHaveBeenCalledWith(true);
  });
  it("suppresses a clipboard completion after authority is lost", async () => {
    const { issueWorkspaceAccess } =
      await vi.importActual<typeof import("./SiteWorkspace")>(
        "./SiteWorkspace",
      );
    vi.mocked(apiRequest).mockResolvedValueOnce(actor);
    await panelActorOwner.load();
    vi.mocked(apiRequest).mockResolvedValueOnce({
      token: "fictional-credential",
    });
    const copied = vi.fn();
    let resolve!: () => void;
    const clipboard = {
      writeText: vi.fn(
        () =>
          new Promise<void>((yes) => {
            resolve = yes;
          }),
      ),
    };
    const work = issueWorkspaceAccess(
      panelActorOwner.getSnapshot().sessionEpoch,
      {
        userId: "admin-1",
        purpose: "RECOVERY",
        origin: "https://panel.example.test",
        clipboard,
        copied,
        failed: vi.fn(),
        pending: vi.fn(),
        isActive: () => true,
      },
    );
    await Promise.resolve();
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    panelActorOwner.invalidate(false);
    resolve();
    await work;
    expect(copied).not.toHaveBeenCalled();
  });
  it.each([401, 403])(
    "revokes current workspace authority on mutation denial %s",
    async (status) => {
      const { mutateWorkspaceSession } =
        await vi.importActual<typeof import("./SiteWorkspace")>(
          "./SiteWorkspace",
        );
      vi.mocked(apiRequest).mockResolvedValueOnce(actor);
      await panelActorOwner.load();
      const epoch = panelActorOwner.getSnapshot().sessionEpoch;
      vi.mocked(apiRequest).mockRejectedValueOnce(
        new ApiError(status, "ACCESS_DENIED"),
      );
      const load = vi.fn();
      const success = vi.fn();
      const failed = vi.fn();
      const saved = await mutateWorkspaceSession(
        epoch,
        "/v1/owner/sites/wedding-1",
        {},
        { load, success, failed, pending: vi.fn(), isActive: () => true },
      );
      expect(saved).toBe(false);
      expect(panelActorOwner.getSnapshot().sessionEpoch).toBeNull();
      expect(load).not.toHaveBeenCalled();
      expect(success).not.toHaveBeenCalled();
    },
  );
  it.each(["session", "mount"])(
    "does not copy an access credential arriving after %s loss",
    async (loss) => {
      const { issueWorkspaceAccess } =
        await vi.importActual<typeof import("./SiteWorkspace")>(
          "./SiteWorkspace",
        );
      vi.mocked(apiRequest).mockResolvedValueOnce(actor);
      await panelActorOwner.load();
      const epoch = panelActorOwner.getSnapshot().sessionEpoch;
      let resolve!: (value: { token: string }) => void;
      let active = true;
      vi.mocked(apiRequest).mockReturnValueOnce(
        new Promise((yes) => {
          resolve = yes;
        }),
      );
      const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
      const copied = vi.fn();
      const failed = vi.fn();
      const work = issueWorkspaceAccess(epoch, {
        userId: "admin-1",
        purpose: "RECOVERY",
        origin: "https://panel.example.test",
        clipboard,
        isActive: () => active,
        copied,
        failed,
        pending: vi.fn(),
      });
      if (loss === "session") panelActorOwner.invalidate(false);
      else active = false;
      resolve({ token: "fictional-credential" });
      await work;
      expect(clipboard.writeText).not.toHaveBeenCalled();
      expect(copied).not.toHaveBeenCalled();
      expect(failed).not.toHaveBeenCalled();
    },
  );
  it.each([true, false])(
    "does not navigate or toast after sign-out unmount %s",
    async (success) => {
      const actions = createPanelAuthenticationActions();
      let resolve!: () => void;
      let reject!: (cause: Error) => void;
      vi.mocked(apiRequest).mockReturnValueOnce(
        new Promise<void>((yes, no) => {
          resolve = yes;
          reject = no;
        }),
      );
      const navigate = vi.fn();
      const failure = vi.fn();
      const work = submitPanelSignOut(actions, navigate, failure);
      actions.dispose();
      if (success) resolve();
      else reject(new Error("offline"));
      await work;
      expect(navigate).not.toHaveBeenCalled();
      expect(failure).not.toHaveBeenCalled();
    },
  );
  it("passes the verified generation into the selected workspace", () => {
    expect(render("verified")).toContain('data-epoch="7"');
  });
  it.each(["loading", "unverified", "denied", "unavailable"] as const)(
    "does not expose a workspace for %s even if a stale actor is supplied",
    (status) => {
      expect(render(status)).not.toContain("workspace");
    },
  );
  it("rejects verified without an epoch", () => {
    expect(render("verified", null)).not.toContain("workspace");
  });
  it("renders SSR without authority or a request despite a browser cache", async () => {
    vi.mocked(apiRequest).mockResolvedValue(actor);
    await panelActorOwner.load();
    vi.mocked(apiRequest).mockClear();
    const html = renderToStaticMarkup(
      createElement(Panel, { siteId: "wedding-1" }),
    );
    expect(html).not.toContain("workspace");
    expect(apiRequest).not.toHaveBeenCalled();
  });
  it("invalidates before dispatching sign-out and never restores authority after failure", async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce(actor);
    await panelActorOwner.load();
    vi.mocked(apiRequest).mockImplementationOnce(async () => {
      expect(panelActorOwner.getSnapshot().sessionEpoch).toBeNull();
      throw new Error("offline");
    });
    await expect(signOutPanel()).rejects.toThrow("offline");
    expect(panelActorOwner.getSnapshot().actor).toBeNull();
    expect(apiRequest).toHaveBeenLastCalledWith("/v1/auth/sign-out", {
      method: "POST",
      body: {},
    });
  });
});
