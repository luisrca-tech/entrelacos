// @vitest-environment jsdom
import type {
  MeResponse,
  SiteAccess,
  SiteTeamResponse,
} from "@entrelacos/contracts";
import { act, createElement, StrictMode, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/apiClient";
import { createPanelActorOwner } from "./panelActor";
import { createSiteTeamController, SiteTeamSection } from "./SiteTeamSection";

const instant = Date.parse("2026-10-13T03:00:00.000Z");
const access: SiteAccess = {
  siteId: "site-1",
  userId: "admin-1",
  membershipId: "membership-1",
  membershipRole: "SITE_ADMIN",
  capabilities: {
    manageInvitations: true,
    manageMessages: true,
    manageCatalog: true,
    manageTeam: true,
    readFinance: true,
    configureReceiving: true,
    requestWithdrawal: false,
  },
};
const actor: MeResponse = {
  user: {
    id: "admin-1",
    name: "Admin",
    email: "admin@example.test",
    role: "SITE_ADMIN",
  },
  session: { id: "session-1", expiresAt: "2026-10-14T03:00:00.000Z" },
  siteId: "site-1",
  memberships: [access],
};
const team: SiteTeamResponse = {
  members: [
    {
      userId: "assessor-1",
      siteId: "site-1",
      name: "Ana Assistente",
      email: "ana@example.test",
      membershipRole: "SITE_ASSISTANT",
      revokedAt: null,
    },
  ],
  invitations: [
    {
      id: "invitation-1",
      siteId: "site-1",
      inviteeName: "Clara",
      email: "clara@example.test",
      expiresAt: "2026-10-14T03:00:00.000Z",
      consumedAt: null,
      revokedAt: null,
    },
  ],
};
const issued = { invitation: team.invitations[0], token: "A".repeat(43) };
const input = { name: "Clara", email: "clara@example.test" };
type Request = (
  path: string,
  options?: { method?: string; body?: unknown },
) => Promise<unknown>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const cleanups: Array<() => void> = [];
const mounts: Array<{
  root: Root;
  container: HTMLDivElement;
  active: boolean;
}> = [];
const environment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(instant);
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Real fetch forbidden");
    }),
  );
});
afterEach(async () => {
  await act(async () => {
    for (const entry of mounts) {
      if (entry.active) entry.root.unmount();
      entry.container.remove();
    }
  });
  mounts.length = 0;
  for (const cleanup of cleanups.splice(0)) cleanup();
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  environment.IS_REACT_ACT_ENVIRONMENT = false;
});
async function fixture(
  identity: MeResponse = actor,
  canManage = true,
  siteId = "site-1",
  verified = true,
) {
  const ownerRequest = vi.fn().mockResolvedValue(identity);
  const owner = createPanelActorOwner({
    request: ownerRequest,
    now: () => Date.now(),
  });
  if (verified) await owner.load();
  const request = vi.fn<Request>(async (path, options) => {
    if (path === "/v1/me") return identity;
    if (options?.method === "POST")
      return path.endsWith("/revoke") ? { ok: true } : issued;
    return team;
  });
  const clipboard = { writeText: vi.fn(async (_value: string) => {}) };
  const changed = vi.fn();
  const ports = {
    owner,
    request,
    now: () => Date.now(),
    isCurrent: () => true,
    origin: () => "https://admin.example.test",
    clipboard: () => clipboard,
    success: vi.fn(),
    error: vi.fn(),
  };
  const scope = { siteId, canManage };
  const controller = createSiteTeamController(scope, changed, ports);
  cleanups.push(() => {
    controller.dispose();
    owner.dispose();
  });
  return {
    controller,
    owner,
    ownerRequest,
    request,
    clipboard,
    changed,
    ports,
    scope,
  };
}
async function flush() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}
async function mount(f: Awaited<ReturnType<typeof fixture>>, strict = false) {
  const container = document.createElement("div");
  document.body.append(container);
  const entry = { root: createRoot(container), container, active: true };
  mounts.push(entry);
  await act(async () => {
    const element = createElement(SiteTeamSection, {
      ...f.scope,
      ports: f.ports,
    });
    entry.root.render(
      strict ? createElement(StrictMode, {}, element) : element,
    );
    await flush();
  });
  return entry;
}
function fill(container: HTMLElement) {
  const form = container.querySelector<HTMLFormElement>("form");
  if (!form) throw new Error("Expected real team invitation form");
  const name = form.querySelector<HTMLInputElement>('[name="name"]');
  const email = form.querySelector<HTMLInputElement>('[name="email"]');
  if (!name || !email) throw new Error("Expected real invite inputs");
  name.value = input.name;
  email.value = input.email;
  return form;
}
async function submit(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await flush();
  });
}

it("exports the current-owner team controller", () => {
  expect(createSiteTeamController).toBeTypeOf("function");
});

describe("team manager current owner and attempts", () => {
  it("rechecks actual owner replacement by the final scope callback before dispatch", async () => {
    const f = await fixture();
    const next = await fixture();
    await f.controller.start();
    const identity = deferred<unknown>();
    f.request.mockReturnValueOnce(identity.promise);
    const operation = f.controller.invite(input);
    await flush();
    let calls = 0;
    let replaced = false;
    f.ports.isCurrent = () => {
      if (++calls === 6) {
        replaced = true;
        f.ports.owner = next.owner;
      }
      return true;
    };
    identity.resolve(actor);
    await operation;
    expect(replaced).toBe(true);
    expect(
      f.request.mock.calls.filter(([, options]) => options?.method === "POST"),
    ).toHaveLength(0);
  });
  it("does not report failure through a callable retrieved after disposal", async () => {
    const f = await fixture();
    await f.controller.start();
    const original = f.owner.reportFailure;
    const report = vi.fn(original);
    Object.defineProperty(f.owner, "reportFailure", {
      get() {
        f.controller.dispose();
        return report;
      },
    });
    f.request.mockRejectedValueOnce(new ApiError(401, "UNAUTHORIZED"));
    await f.controller.invite(input);
    expect(report).not.toHaveBeenCalled();
  });
  it.each(["success", "error"] as const)(
    "rechecks a reentrant %s callback getter before feedback",
    async (kind) => {
      const f = await fixture();
      await f.controller.start();
      const callback = vi.fn();
      Object.defineProperty(f.ports, kind, {
        get() {
          f.owner.invalidate(false);
          return callback;
        },
      });
      if (kind === "error")
        f.request.mockRejectedValueOnce(new Error("Synthetic failure"));
      await f.controller.invite(input);
      expect(callback).not.toHaveBeenCalled();
    },
  );
  it("rechecks cancellation after the final owner getter before invite dispatch", async () => {
    const f = await fixture();
    await f.controller.start();
    const identity = deferred<unknown>();
    f.request.mockReturnValueOnce(identity.promise);
    const operation = f.controller.invite(input);
    await flush();
    const original = f.owner.getSnapshot;
    let reads = 0;
    let invalidated = false;
    f.owner.getSnapshot = () => {
      const snapshot = original();
      if (++reads === 6) {
        invalidated = true;
        f.owner.invalidate(false);
      }
      return snapshot;
    };
    identity.resolve(actor);
    await operation;
    expect(invalidated).toBe(true);
    expect(
      f.request.mock.calls.filter(([, options]) => options?.method === "POST"),
    ).toHaveLength(0);
    expect(f.clipboard.writeText).not.toHaveBeenCalled();
  });
  it.each(["me", "revoke", "reload"])(
    "obsolete revocation at deferred %s cannot reload or publish feedback",
    async (stage) => {
      const f = await fixture();
      await f.controller.start();
      f.request.mockClear();
      f.controller.selectTarget({ kind: "members", id: "assessor-1" });
      const wait = deferred<unknown>();
      f.request.mockImplementation(async (path, options) =>
        path === "/v1/me"
          ? stage === "me"
            ? wait.promise
            : actor
          : options?.method === "POST"
            ? stage === "revoke"
              ? wait.promise
              : { ok: true }
            : wait.promise,
      );
      const operation = f.controller.revoke();
      await flush();
      const count = f.request.mock.calls.length;
      f.controller.dispose();
      wait.resolve(
        stage === "me" ? actor : stage === "revoke" ? { ok: true } : team,
      );
      await operation;
      expect(f.request).toHaveBeenCalledTimes(count);
      expect(f.ports.success).not.toHaveBeenCalled();
      expect(f.ports.error).not.toHaveBeenCalled();
      expect(f.controller.getState()).toMatchObject({
        team: null,
        link: "",
        target: null,
        pending: false,
      });
    },
  );
  it("ignores obsolete manual discovery success and does not adopt replacement owner", async () => {
    const f = await fixture();
    const wait = deferred<unknown>();
    f.request.mockReturnValue(wait.promise);
    const operation = f.controller.start();
    await flush();
    f.owner.invalidate(false);
    await f.owner.load();
    const current = f.owner.getSnapshot();
    wait.resolve(team);
    await operation;
    expect(f.controller.getState()).toMatchObject({
      authorized: false,
      team: null,
    });
    expect(f.owner.getSnapshot()).toBe(current);
  });
  it("rechecks clipboard method access before invoking a method returned by a reentrant getter", async () => {
    const f = await fixture();
    await f.controller.start();
    const write = vi.fn(async (_value: string) => {});
    f.ports.clipboard = () =>
      Object.defineProperty({}, "writeText", {
        get() {
          f.controller.dispose();
          return write;
        },
      }) as typeof f.clipboard;
    await f.controller.invite(input);
    expect(write).not.toHaveBeenCalled();
    expect(f.ports.success).not.toHaveBeenCalled();
  });
  it("keeps the captured scope immutable if the caller's original scope object changes", async () => {
    const f = await fixture();
    await f.controller.start();
    f.scope.siteId = "foreign";
    await f.controller.invite(input);
    expect(
      f.request.mock.calls.some(([path]) => path.includes("/foreign/")),
    ).toBe(false);
  });
  it("loads only strict scoped team discovery and preserves the verified epoch", async () => {
    const f = await fixture();
    const epoch = f.owner.getSnapshot().sessionEpoch;
    await f.controller.start();
    expect(f.request).toHaveBeenCalledExactlyOnceWith(
      "/v1/sites/site-1/team",
      undefined,
    );
    expect(f.controller.getState()).toMatchObject({
      authorized: true,
      team,
      pending: false,
      link: "",
      target: null,
    });
    expect(f.owner.getSnapshot().sessionEpoch).toBe(epoch);
  });
  it.each(["unknown", "capability", "foreign", "assessor", "membership"])(
    "blocks %s manager before GET or mutation",
    async (reason) => {
      const identity = structuredClone(actor);
      if (reason === "foreign")
        identity.memberships = [{ ...access, siteId: "other" }];
      if (reason === "assessor") {
        identity.user.role = "SITE_ASSISTANT";
        identity.memberships = [
          { ...access, membershipRole: "SITE_ASSISTANT" },
        ];
      }
      if (reason === "membership")
        identity.memberships = [
          {
            ...access,
            capabilities: { ...access.capabilities, manageTeam: false },
          },
        ];
      const f = await fixture(
        identity,
        reason !== "capability",
        "site-1",
        reason !== "unknown",
      );
      await f.controller.start();
      await f.controller.invite(input);
      f.controller.selectTarget({ kind: "members", id: "assessor-1" });
      await f.controller.revoke();
      expect(f.request).not.toHaveBeenCalled();
      expect(f.controller.getState().authorized).toBe(false);
    },
  );
  it("permits verified native OWNER only with the current operational canManage prop", async () => {
    const native: MeResponse = {
      ...actor,
      user: { ...actor.user, role: "OWNER" },
      memberships: [],
      siteId: null,
    };
    const permitted = await fixture(native);
    await permitted.controller.start();
    expect(permitted.controller.getState().authorized).toBe(true);
    const denied = await fixture(native, false);
    await denied.controller.invite(input);
    expect(denied.request).not.toHaveBeenCalled();
  });
  it("fresh-checks Me before invite, copies current fragment, reloads team and invokes current callbacks once", async () => {
    const f = await fixture();
    await f.controller.start();
    f.request.mockClear();
    const created = vi.fn();
    await f.controller.invite(input, created);
    expect(f.request.mock.calls.map(([path]) => path)).toEqual([
      "/v1/me",
      "/v1/sites/site-1/team/invitations",
      "/v1/sites/site-1/team",
    ]);
    expect(f.request.mock.calls[1][1]).toEqual({ method: "POST", body: input });
    expect(f.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(
      `https://admin.example.test/join-team#token=${issued.token}`,
    );
    expect(created).toHaveBeenCalledTimes(1);
    expect(f.ports.success).toHaveBeenCalledTimes(1);
    expect(f.controller.getState()).toMatchObject({
      pending: false,
      link: `https://admin.example.test/join-team#token=${issued.token}`,
      team,
    });
    f.controller.hideLink();
    expect(f.controller.getState().link).toBe("");
  });
  it.each(["members", "invitations"] as const)(
    "fresh-checks Me before current %s revocation",
    async (kind) => {
      const f = await fixture();
      await f.controller.start();
      f.request.mockClear();
      const id = kind === "members" ? "assessor-1" : "invitation-1";
      f.controller.selectTarget({ kind, id });
      await f.controller.revoke();
      expect(f.request.mock.calls.map(([path]) => path)).toEqual([
        "/v1/me",
        `/v1/sites/site-1/team/${kind}/${id}/revoke`,
        "/v1/sites/site-1/team",
      ]);
      expect(f.controller.getState()).toMatchObject({
        target: null,
        pending: false,
      });
      expect(f.ports.success).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["subject", "session", "membership", "private", "expired"])(
    "rejects changed fresh Me %s before mutation",
    async (change) => {
      const f = await fixture();
      await f.controller.start();
      const next = structuredClone(actor) as MeResponse & { private?: string };
      if (change === "subject") next.user.email = "other@example.test";
      if (change === "session") next.session.id = "new-session";
      if (change === "membership")
        next.memberships = [
          {
            ...access,
            capabilities: { ...access.capabilities, manageTeam: false },
          },
        ];
      if (change === "private") next.private = "secret";
      if (change === "expired")
        next.session.expiresAt = new Date(instant).toISOString();
      f.request.mockImplementation(async (path) =>
        path === "/v1/me" ? next : team,
      );
      await f.controller.invite(input);
      expect(
        f.request.mock.calls.filter(
          ([, options]) => options?.method === "POST",
        ),
      ).toHaveLength(0);
      expect(f.clipboard.writeText).not.toHaveBeenCalled();
      expect(f.ports.success).not.toHaveBeenCalled();
    },
  );
  it.each([NaN, -1, instant - 1, Date.parse(actor.session.expiresAt)])(
    "blocks invalid, regressive or expired clock %s",
    async (now) => {
      const f = await fixture();
      await f.controller.start();
      f.request.mockClear();
      vi.setSystemTime(now);
      await f.controller.invite(input);
      expect(
        f.request.mock.calls.filter(
          ([, options]) => options?.method === "POST",
        ),
      ).toHaveLength(0);
      expect(f.clipboard.writeText).not.toHaveBeenCalled();
    },
  );
  it("reserves invite synchronously before reentrant pending publication", async () => {
    const f = await fixture();
    await f.controller.start();
    f.changed.mockImplementation(() => {
      if (f.controller.getState().pending) void f.controller.invite(input);
    });
    await f.controller.invite(input);
    expect(
      f.request.mock.calls.filter(([path]) => path.endsWith("/invitations")),
    ).toHaveLength(1);
  });
  it("rechecks pending publication disposal before its first transport", async () => {
    const f = await fixture();
    await f.controller.start();
    f.request.mockClear();
    f.changed.mockImplementation(() => {
      if (f.controller.getState().pending) f.controller.dispose();
    });
    await f.controller.invite(input);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.clipboard.writeText).not.toHaveBeenCalled();
  });
  it.each(["me", "invite", "clipboard", "reload"])(
    "disposal at deferred %s boundary cancels all later work",
    async (stage) => {
      const f = await fixture();
      await f.controller.start();
      f.request.mockClear();
      const wait = deferred<unknown>();
      const copied = deferred<void>();
      f.request.mockImplementation(async (path, options) => {
        if (path === "/v1/me") return stage === "me" ? wait.promise : actor;
        if (options?.method === "POST")
          return stage === "invite" ? wait.promise : issued;
        return stage === "reload" ? wait.promise : team;
      });
      if (stage === "clipboard")
        f.clipboard.writeText.mockImplementation(() => copied.promise);
      const created = vi.fn();
      const operation = f.controller.invite(input, created);
      await flush();
      const before = f.request.mock.calls.length;
      f.controller.dispose();
      wait.resolve(stage === "me" ? actor : stage === "invite" ? issued : team);
      copied.resolve();
      await operation;
      expect(f.request).toHaveBeenCalledTimes(before);
      expect(f.controller.getState().link).toBe("");
      expect(created).not.toHaveBeenCalled();
      expect(f.ports.success).not.toHaveBeenCalled();
      expect(f.ports.error).not.toHaveBeenCalled();
      if (stage === "me" || stage === "invite")
        expect(f.clipboard.writeText).not.toHaveBeenCalled();
    },
  );
  it("owner replacement retracts link/target/team synchronously", async () => {
    const f = await fixture();
    await f.controller.start();
    await f.controller.invite(input);
    f.controller.selectTarget({ kind: "members", id: "assessor-1" });
    f.owner.invalidate(false);
    expect(f.controller.getState()).toMatchObject({
      authorized: false,
      team: null,
      link: "",
      target: null,
    });
    await f.owner.load();
    f.request.mockClear();
    await f.controller.invite(input);
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each([401, 403])(
    "only current %s reports against captured native epoch",
    async (status) => {
      const f = await fixture();
      await f.controller.start();
      f.request.mockRejectedValue(new ApiError(status, "AUTH_FAILED"));
      await f.controller.invite(input);
      expect(f.owner.getSnapshot().status).toBe(
        status === 401 ? "unauthenticated" : "denied",
      );
    },
  );
  it.each([401, 403])(
    "stale %s cannot invalidate replacement owner or emit feedback",
    async (status) => {
      const f = await fixture();
      await f.controller.start();
      const wait = deferred<unknown>();
      f.request.mockImplementation(async (path) =>
        path === "/v1/me" ? actor : wait.promise,
      );
      const operation = f.controller.invite(input);
      await flush();
      f.owner.invalidate(false);
      await f.owner.load();
      const replacement = f.owner.getSnapshot();
      wait.reject(new ApiError(status, "AUTH_FAILED"));
      await operation;
      expect(f.owner.getSnapshot()).toBe(replacement);
      expect(f.ports.error).not.toHaveBeenCalled();
      expect(f.clipboard.writeText).not.toHaveBeenCalled();
    },
  );
  it("clipboard getter reentrancy is guarded before write dispatch", async () => {
    const f = await fixture();
    await f.controller.start();
    f.ports.clipboard = () => {
      f.controller.dispose();
      return f.clipboard;
    };
    await f.controller.invite(input);
    expect(f.clipboard.writeText).not.toHaveBeenCalled();
    expect(
      f.request.mock.calls.filter(([path]) => path.endsWith("/team")),
    ).toHaveLength(1);
  });
  it("origin getter reentrancy prevents clipboard and follow-up discovery", async () => {
    const f = await fixture();
    await f.controller.start();
    f.ports.origin = () => {
      f.controller.dispose();
      return "https://admin.example.test";
    };
    await f.controller.invite(input);
    expect(f.clipboard.writeText).not.toHaveBeenCalled();
    expect(f.ports.success).not.toHaveBeenCalled();
  });
  it("onCreated reentrancy prevents later success feedback", async () => {
    const f = await fixture();
    await f.controller.start();
    await f.controller.invite(input, () => f.controller.dispose());
    expect(f.ports.success).not.toHaveBeenCalled();
    expect(f.controller.getState().link).toBe("");
  });
  it.each([
    null,
    { ...team, privateToken: issued.token },
    { ...team, members: [{ ...team.members[0], siteId: "foreign" }] },
  ])(
    "rejects malformed/private/foreign team without secret error disclosure %j",
    async (response) => {
      const f = await fixture();
      f.request.mockResolvedValue(response);
      await f.controller.start();
      expect(f.controller.getState().team).toBeNull();
      expect(JSON.stringify(f.controller.getState())).not.toContain(
        issued.token,
      );
    },
  );
  it("sanitizes raw transport errors and prevents foreign invitation copying", async () => {
    const f = await fixture();
    await f.controller.start();
    f.request.mockImplementation(async (path) =>
      path === "/v1/me"
        ? actor
        : {
            ...issued,
            invitation: { ...issued.invitation, siteId: "foreign" },
          },
    );
    await f.controller.invite(input);
    expect(f.clipboard.writeText).not.toHaveBeenCalled();
    expect(f.controller.getState().link).toBe("");
    f.request.mockRejectedValue(new Error(`private ${issued.token}`));
    await f.controller.refresh();
    expect(JSON.stringify(f.controller.getState())).not.toContain(issued.token);
    expect(JSON.stringify(f.ports.error.mock.calls)).not.toContain(
      issued.token,
    );
  });
});

describe("team manager actual React DOM lifetime", () => {
  it("rechecks a real form reset getter before invoking its returned method", async () => {
    const f = await fixture();
    const entry = await mount(f);
    const form = fill(entry.container);
    const reset = vi.fn();
    Object.defineProperty(form, "reset", {
      get() {
        f.owner.invalidate(false);
        return reset;
      },
    });
    await submit(form);
    expect(reset).not.toHaveBeenCalled();
    expect(f.ports.success).not.toHaveBeenCalled();
  });
  it.each(["new ports", "same ports"])(
    "owner replacement using %s hides old private link before layout callbacks",
    async (replacement) => {
      const f = await fixture();
      const next = await fixture();
      expect(f.owner.getSnapshot().sessionEpoch).toBe(
        next.owner.getSnapshot().sessionEpoch,
      );
      const container = document.createElement("div");
      document.body.append(container);
      const entry = { root: createRoot(container), container, active: true };
      mounts.push(entry);
      const observations: string[] = [];
      function Host({
        ports,
        observe,
      }: {
        ports: typeof f.ports;
        observe: boolean;
      }) {
        useLayoutEffect(() => {
          if (observe)
            observations.push(
              container.querySelector<HTMLInputElement>("#team-invite-link")
                ?.value ?? "",
            );
        }, [observe]);
        return createElement(SiteTeamSection, { ...f.scope, ports });
      }
      await act(async () => {
        entry.root.render(
          createElement(Host, { ports: f.ports, observe: false }),
        );
        await flush();
      });
      await submit(fill(container));
      expect(container.querySelector("#team-invite-link")).not.toBeNull();
      if (replacement === "same ports") f.ports.owner = next.owner;
      await act(async () => {
        entry.root.render(
          createElement(Host, {
            ports: replacement === "same ports" ? f.ports : next.ports,
            observe: true,
          }),
        );
        await flush();
      });
      expect(observations).toEqual([""]);
      expect(container.querySelector("#team-invite-link")).toBeNull();
    },
  );
  it("SSR never exposes team, link or enabled forms even with a verified injected owner", async () => {
    const f = await fixture();
    const html = renderToStaticMarkup(
      createElement(SiteTeamSection, { ...f.scope, ports: f.ports }),
    );
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Ana Assistente");
    expect(html).not.toContain(issued.token);
    expect(f.request).not.toHaveBeenCalled();
  });
  it("StrictMode performs GET-only entry with a current real invite form", async () => {
    const f = await fixture();
    const entry = await mount(f, true);
    expect(entry.container.querySelector("form")).not.toBeNull();
    expect(entry.container.textContent).toContain("Ana Assistente");
    expect(
      f.request.mock.calls.every(
        ([path, options]) =>
          path === "/v1/sites/site-1/team" && options === undefined,
      ),
    ).toBe(true);
    expect(f.clipboard.writeText).not.toHaveBeenCalled();
  });
  it("submits the real invitation form, copies a fragment link and resets only its current form", async () => {
    const f = await fixture();
    const entry = await mount(f);
    const form = fill(entry.container);
    const reset = vi.spyOn(form, "reset");
    await submit(form);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(form.querySelector<HTMLInputElement>('[name="name"]')?.value).toBe(
      "",
    );
    expect(
      entry.container.querySelector<HTMLInputElement>("#team-invite-link")
        ?.value,
    ).toBe(`https://admin.example.test/join-team#token=${issued.token}`);
    expect(f.ports.success).toHaveBeenCalledTimes(1);
    expect(
      f.request.mock.calls.filter(([path]) => path.endsWith("/invitations")),
    ).toHaveLength(1);
  });
  it.each(["site", "capability", "owner"])(
    "prop/owner %s replacement retracts private data and prevents old delayed issuance callbacks",
    async (change) => {
      const f = await fixture();
      const entry = await mount(f);
      const wait = deferred<unknown>();
      f.request.mockImplementation(async (path, options) =>
        path === "/v1/me"
          ? actor
          : options?.method === "POST"
            ? wait.promise
            : team,
      );
      const form = fill(entry.container);
      const reset = vi.spyOn(form, "reset");
      await submit(form);
      await act(async () => {
        if (change === "owner") f.owner.invalidate(false);
        else
          entry.root.render(
            createElement(SiteTeamSection, {
              ...f.scope,
              ...(change === "site"
                ? { siteId: "other" }
                : { canManage: false }),
              ports: f.ports,
            }),
          );
        await flush();
      });
      await act(async () => {
        wait.resolve(issued);
        await flush();
      });
      expect(entry.container.textContent).not.toContain("Ana Assistente");
      expect(entry.container.querySelector("#team-invite-link")).toBeNull();
      expect(reset).not.toHaveBeenCalled();
      expect(f.clipboard.writeText).not.toHaveBeenCalled();
      expect(f.ports.success).not.toHaveBeenCalled();
    },
  );
  it("clears already published private link synchronously on owner scope loss", async () => {
    const f = await fixture();
    const entry = await mount(f);
    await submit(fill(entry.container));
    expect(entry.container.querySelector("#team-invite-link")).not.toBeNull();
    await act(async () => {
      f.owner.invalidate(false);
    });
    expect(entry.container.querySelector("#team-invite-link")).toBeNull();
    expect(entry.container.querySelector("form")).toBeNull();
  });
  it("true unmount/remount during clipboard settlement cannot reset or notify the replacement form", async () => {
    const f = await fixture();
    const old = await mount(f);
    const copied = deferred<void>();
    f.clipboard.writeText.mockImplementationOnce(() => copied.promise);
    const form = fill(old.container);
    const reset = vi.spyOn(form, "reset");
    await submit(form);
    await act(async () => {
      old.root.unmount();
      old.active = false;
    });
    const fresh = await mount(f);
    const freshForm = fill(fresh.container);
    const freshReset = vi.spyOn(freshForm, "reset");
    const before = f.request.mock.calls.length;
    await act(async () => {
      copied.resolve();
      await flush();
    });
    expect(f.request).toHaveBeenCalledTimes(before);
    expect(reset).not.toHaveBeenCalled();
    expect(freshReset).not.toHaveBeenCalled();
    expect(f.ports.success).not.toHaveBeenCalled();
    expect(
      freshForm.querySelector<HTMLInputElement>('[name="name"]')?.value,
    ).toBe(input.name);
  });
  it("uses actual revocation selection and confirmation controls for the current member", async () => {
    const f = await fixture();
    const entry = await mount(f);
    const select = entry.container.querySelector<HTMLButtonElement>(
      '[aria-label="Revogar acesso de Ana Assistente"]',
    );
    expect(select).not.toBeNull();
    await act(async () => {
      select?.click();
      await flush();
    });
    const confirm = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Revogar");
    expect(confirm).toBeDefined();
    await act(async () => {
      confirm?.click();
      await flush();
    });
    expect(
      f.request.mock.calls.filter(
        ([path]) => path === "/v1/sites/site-1/team/members/assessor-1/revoke",
      ),
    ).toHaveLength(1);
    expect(f.ports.success).toHaveBeenCalledTimes(1);
  });
});
