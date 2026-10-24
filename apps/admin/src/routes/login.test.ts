import type { MeResponse } from "@entrelacos/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createPanelAuthenticationActions,
  panelActorOwner,
} from "../components/panelActor";
import { apiRequest } from "../lib/apiClient";
import { signInPanel, submitPanelSignIn } from "./login";

vi.mock("../lib/apiClient", async (original) => ({
  ...(await original<typeof import("../lib/apiClient")>()),
  apiRequest: vi.fn(),
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
it.each([true, false])(
  "does not navigate, toast or reset pending after sign-in unmount %s",
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
    const work = submitPanelSignIn(
      actions,
      { email: "admin@example.test", password: "fictional-password" },
      navigate,
      failure,
    );
    actions.dispose();
    if (success) resolve();
    else reject(new Error("denied"));
    await work;
    expect(navigate).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
  },
);
it.each([true, false])(
  "invalidates before sign-in and requires a new lookup after settlement %s",
  async (success) => {
    vi.mocked(apiRequest).mockResolvedValueOnce(actor);
    await panelActorOwner.load();
    vi.mocked(apiRequest).mockImplementationOnce(async () => {
      expect(panelActorOwner.getSnapshot().sessionEpoch).toBeNull();
      await expect(panelActorOwner.load()).rejects.toThrow(
        "Session ownership changed",
      );
      if (!success) throw new Error("denied");
    });
    const work = signInPanel({
      email: "admin@example.test",
      password: "fictional-password",
    });
    if (success) await work;
    else await expect(work).rejects.toThrow("denied");
    expect(panelActorOwner.getSnapshot().actor).toBeNull();
    expect(apiRequest).toHaveBeenLastCalledWith("/v1/auth/sign-in/email", {
      method: "POST",
      body: { email: "admin@example.test", password: "fictional-password" },
    });
  },
);
