// @vitest-environment jsdom
import type { MeResponse, SiteAccess } from "@entrelacos/contracts";
import {
  act,
  createElement,
  type ReactNode,
  StrictMode,
  useLayoutEffect,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/apiClient";
import { createPanelActorOwner } from "./panelActor";
import * as acceptance from "./TeamInvitationAcceptance";
import type { TeamAcceptance } from "./teamAcceptance";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
    className,
  }: {
    to: string;
    params?: { siteId?: string };
    children: ReactNode;
    className?: string;
  }) =>
    createElement(
      "a",
      {
        href: to.replace("$siteId", encodeURIComponent(params?.siteId ?? "")),
        className,
      },
      children,
    ),
}));

const initialTime = Date.parse("2026-10-13T03:00:00.000Z");
const token = "a".repeat(43);
const invitationPath = "/v1/team-invitations/accept";
const signInPath = "/v1/auth/sign-in/email";
const signOutPath = "/v1/auth/sign-out";
const mePath = "/v1/me";
const member: SiteAccess = {
  siteId: "wedding-a",
  userId: "helper-a",
  membershipId: "membership-a",
  membershipRole: "SITE_ASSISTANT",
  capabilities: {
    manageInvitations: true,
    manageMessages: true,
    manageCatalog: true,
    manageTeam: false,
    readFinance: false,
    configureReceiving: false,
    requestWithdrawal: false,
  },
};
const actor: MeResponse = {
  user: {
    id: "helper-a",
    name: "Helper",
    email: "helper@example.test",
    role: "SITE_ASSISTANT",
  },
  session: {
    id: "session-a",
    expiresAt: "2026-10-14T03:00:00.000Z",
  },
  siteId: null,
  memberships: [],
};
type RequestOptions = { method?: string; body?: unknown };
type Controller = ReturnType<typeof acceptance.createTeamAcceptanceController>;
type Owner = ReturnType<typeof createPanelActorOwner>;
const controllers: Controller[] = [];
const owners: Owner[] = [];
const mounts: Array<{
  root: Root;
  container: HTMLDivElement;
  active: boolean;
}> = [];
const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function settle() {
  for (let index = 0; index < 16; index++) await Promise.resolve();
}
function fixture(initialActor: MeResponse | null = null) {
  let native: MeResponse | null = initialActor
    ? structuredClone(initialActor)
    : null;
  const respond = async (
    path: string,
    options?: RequestOptions,
  ): Promise<unknown> => {
    if (path === mePath) {
      if (!native) throw new ApiError(401, "UNAUTHORIZED");
      return structuredClone(native);
    }
    if (path === signInPath) {
      native = structuredClone(actor);
      return { ok: true };
    }
    if (path === signOutPath) {
      native = null;
      return { ok: true };
    }
    if (path === invitationPath && options?.method === "POST") {
      if (native)
        native = {
          ...native,
          siteId: "wedding-a",
          memberships: [structuredClone(member)],
        };
      return { siteId: "wedding-a" };
    }
    throw new Error("Unexpected synthetic request");
  };
  const request =
    vi.fn<(path: string, options?: RequestOptions) => Promise<unknown>>(
      respond,
    );
  const broadcast = vi.fn();
  const owner = createPanelActorOwner({
    request: () => request(mePath),
    now: () => Date.now(),
    broadcast,
  });
  owners.push(owner);
  let authenticationDepth = 0;
  const originalLoad = owner.load.bind(owner);
  const originalAuthentication = owner.runAuthentication.bind(owner);
  const loadsDuringAuthentication = vi.fn();
  const unverifiedNotifications = vi.fn();
  owner.subscribe(() => {
    if (owner.getSnapshot().status === "unverified") unverifiedNotifications();
  });
  const load = vi.spyOn(owner, "load").mockImplementation((refresh) => {
    if (authenticationDepth) loadsDuringAuthentication();
    return originalLoad(refresh);
  });
  const invalidate = vi.spyOn(owner, "invalidate");
  const runAuthentication = vi
    .spyOn(owner, "runAuthentication")
    .mockImplementation(async <T>(operation: () => Promise<T>): Promise<T> => {
      authenticationDepth++;
      try {
        return await originalAuthentication(operation);
      } finally {
        authenticationDepth--;
      }
    });
  const onInvalidate = vi.fn();
  const ports = {
    owner,
    request,
    now: () => Date.now(),
    isCurrent: () => true,
    onInvalidate,
  };
  return {
    owner,
    ports,
    request,
    respond,
    broadcast,
    load,
    invalidate,
    runAuthentication,
    loadsDuringAuthentication,
    unverifiedNotifications,
    onInvalidate,
    setNative(value: MeResponse | null) {
      native = value ? structuredClone(value) : null;
    },
  };
}
function makeController(
  f: ReturnType<typeof fixture>,
  capability = token,
  onChange = vi.fn(),
) {
  const controller = acceptance.createTeamAcceptanceController(
    capability,
    onChange,
    f.ports,
  );
  controllers.push(controller);
  return { controller, onChange };
}
async function started(initialActor: MeResponse | null = null) {
  const f = fixture(initialActor);
  const c = makeController(f);
  await c.controller.start();
  return { ...f, ...c };
}
function posts(
  request: ReturnType<typeof fixture>["request"],
  path = invitationPath,
) {
  return request.mock.calls.filter(
    ([url, options]) => url === path && options?.method === "POST",
  );
}
function assertPrivate(value: unknown) {
  const text = JSON.stringify(value);
  expect(text).not.toContain(token);
  expect(text).not.toContain("secret12");
  expect(text).not.toContain("current-password");
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(initialTime);
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected real network request");
    }),
  );
  window.history.replaceState(null, "", "/team-invitation");
});
afterEach(async () => {
  await act(async () => {
    for (const entry of mounts) {
      if (entry.active) entry.root.unmount();
      entry.container.remove();
    }
  });
  mounts.length = 0;
  for (const controller of controllers) controller.dispose();
  controllers.length = 0;
  for (const owner of owners) owner.dispose();
  owners.length = 0;
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  window.history.replaceState(null, "", "/");
});

it("exports the current-owner invitation acceptance controller", () => {
  expect(acceptance.createTeamAcceptanceController).toBeTypeOf("function");
});

describe("team invitation acceptance entry and strict native identity", () => {
  it("does not start native entry after its snapshot getter disposes the controller", async () => {
    const f = fixture();
    const { controller } = makeController(f);
    const original = f.owner.getSnapshot;
    let triggered = false;
    f.owner.getSnapshot = () => {
      const snapshot = original();
      triggered = true;
      controller.dispose();
      return snapshot;
    };
    await controller.start();
    expect(triggered).toBe(true);
    expect(f.request).not.toHaveBeenCalled();
  });
  it("starts unverified and accepts only a strict current owner entry", async () => {
    const f = fixture(actor);
    const c = makeController(f);
    expect(c.controller.getState()).toMatchObject({
      ready: false,
      completed: null,
      pending: false,
      validToken: true,
    });
    await c.controller.accept({ mode: "signedIn" });
    expect(posts(f.request)).toHaveLength(0);
    await c.controller.start();
    expect(c.controller.getState()).toMatchObject({
      ready: true,
      sessionUnavailable: false,
      actor,
    });
    expect(f.owner.getSnapshot().status).toBe("verified");
    expect(posts(f.request)).toHaveLength(0);
    assertPrivate(c.controller.getState());
  });

  it("establishes anonymous entry only from a native 401", async () => {
    const f = await started();
    expect(f.controller.getState()).toMatchObject({
      ready: true,
      sessionUnavailable: false,
      actor: null,
      mode: null,
    });
    expect(f.owner.getSnapshot().status).toBe("unauthenticated");
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it.each([403, 409, 503])(
    "does not establish anonymous entry after native identity status %s",
    async (status) => {
      const f = fixture();
      f.request.mockRejectedValue(new ApiError(status, "DENIED"));
      const c = makeController(f);
      await c.controller.start();
      expect(c.controller.getState().sessionUnavailable).toBe(true);
      c.controller.setMode("new");
      await c.controller.accept({ mode: "new", password: "secret12" });
      expect(posts(f.request)).toHaveLength(0);
    },
  );

  it.each([
    { ...actor, secret: token },
    {
      ...actor,
      session: { ...actor.session, expiresAt: "2026-10-12T03:00:00.000Z" },
    },
    { ...actor, memberships: [{ ...member, userId: "foreign-user" }] },
    {
      user: actor.user,
      session: { id: "", expiresAt: actor.session.expiresAt },
    },
  ])(
    "rejects malformed, expired or foreign membership entry %j",
    async (value) => {
      const f = fixture();
      f.request.mockResolvedValue(value);
      const c = makeController(f);
      await c.controller.start();
      expect(c.controller.getState().sessionUnavailable).toBe(true);
      await c.controller.accept({ mode: "signedIn" });
      expect(posts(f.request)).toHaveLength(0);
    },
  );

  it.each(["short", "", "a".repeat(42), "a".repeat(44), "/".repeat(43)])(
    "never dispatches with invalid invitation capability %s",
    async (capability) => {
      const f = fixture(actor);
      const c = makeController(f, capability);
      await c.controller.start();
      expect(c.controller.getState().validToken).toBe(false);
      await c.controller.accept({ mode: "signedIn" });
      expect(posts(f.request)).toHaveLength(0);
    },
  );

  it("ignores a late entry after controller disposal", async () => {
    const f = fixture(actor);
    const identity = deferred<unknown>();
    f.request.mockReturnValue(identity.promise);
    const c = makeController(f);
    const work = c.controller.start();
    await settle();
    c.controller.dispose();
    const published = c.onChange.mock.calls.length;
    identity.resolve(actor);
    await work;
    expect(c.onChange).toHaveBeenCalledTimes(published);
    expect(posts(f.request)).toHaveLength(0);
  });

  it("does not adopt a replacement owner after an invalidated entry", async () => {
    const f = fixture(actor);
    const identity = deferred<unknown>();
    f.request.mockReturnValueOnce(identity.promise);
    const c = makeController(f);
    const old = c.controller.start();
    await settle();
    f.owner.invalidate(false);
    f.setNative({ ...actor, session: { ...actor.session, id: "replacement" } });
    await f.owner.load();
    const published = c.onChange.mock.calls.length;
    identity.resolve(actor);
    await old;
    expect(c.onChange).toHaveBeenCalledTimes(published);
    await c.controller.accept({ mode: "signedIn" });
    expect(posts(f.request)).toHaveLength(0);
  });
});

describe("signed-in invitation acceptance", () => {
  it("does not invalidate membership through a callable retrieved after disposal", async () => {
    const f = await started(actor);
    const invalidation = vi.fn();
    Object.defineProperty(f.owner, "invalidate", {
      get() {
        f.controller.dispose();
        return invalidation;
      },
    });
    await f.controller.accept({ mode: "signedIn" });
    expect(invalidation).not.toHaveBeenCalled();
  });
  it("does not report native failure through a callable retrieved after disposal", async () => {
    const f = await started(actor);
    const original = f.owner.reportFailure;
    const report = vi.fn(original);
    Object.defineProperty(f.owner, "reportFailure", {
      get() {
        f.controller.dispose();
        return report;
      },
    });
    f.request.mockRejectedValueOnce(new ApiError(401, "UNAUTHORIZED"));
    await f.controller.accept({ mode: "signedIn" });
    expect(report).not.toHaveBeenCalled();
  });
  it("does not invoke a cleanup returned after its accessor disposes the attempt", async () => {
    const f = await started(actor);
    const cleanup = vi.fn();
    Object.defineProperty(f.ports, "onInvalidate", {
      get() {
        f.controller.dispose();
        return cleanup;
      },
    });
    await f.controller.accept({ mode: "signedIn" });
    expect(cleanup).not.toHaveBeenCalled();
    expect(f.controller.getState().completed).toBeNull();
  });
  it("rechecks cancellation after the final owner getter before accept dispatch", async () => {
    const f = await started(actor);
    const identity = deferred<unknown>();
    f.request.mockReturnValueOnce(identity.promise);
    const operation = f.controller.accept({ mode: "signedIn" });
    await settle();
    const original = f.owner.getSnapshot;
    let reads = 0;
    let invalidated = false;
    f.owner.getSnapshot = () => {
      const snapshot = original();
      if (++reads === 8) {
        invalidated = true;
        f.owner.invalidate(false);
      }
      return snapshot;
    };
    identity.resolve(actor);
    await operation;
    expect(invalidated).toBe(true);
    expect(posts(f.request)).toHaveLength(0);
    expect(f.controller.getState().completed).toBeNull();
  });
  it("cannot rewrite the native owner binding through exposed entry state", async () => {
    const f = await started(actor);
    const exposed = f.controller.getState().actor;
    if (!exposed) throw new Error("Expected verified entry");
    Reflect.set(exposed.user, "id", "foreign-user");
    Reflect.set(exposed.session, "id", "foreign-session");
    f.setNative({
      ...actor,
      user: { ...actor.user, id: "foreign-user" },
      session: { ...actor.session, id: "foreign-session" },
    });
    await f.controller.accept({ mode: "signedIn" });
    expect(posts(f.request)).toHaveLength(0);
    expect(f.controller.getState().completed).toBeNull();
  });
  it("fresh-checks native identity, accepts once and invalidates membership once", async () => {
    const f = await started(actor);
    f.invalidate.mockClear();
    await f.controller.accept({ mode: "signedIn" });
    expect(posts(f.request)).toEqual([
      [invitationPath, { method: "POST", body: { token } }],
    ]);
    expect(posts(f.request, signInPath)).toHaveLength(0);
    expect(f.runAuthentication).not.toHaveBeenCalled();
    expect(f.invalidate).toHaveBeenCalledTimes(1);
    expect(f.controller.getState()).toMatchObject({
      completed: { siteId: "wedding-a", signedIn: true },
      pending: false,
      validToken: false,
    });
    expect(f.request.mock.calls.map(([path]) => path)).toEqual([
      mePath,
      mePath,
      invitationPath,
      mePath,
    ]);
    assertPrivate(f.controller.getState());
  });

  it.each([
    { ...actor, session: { ...actor.session, id: "session-b" } },
    { ...actor, user: { ...actor.user, id: "helper-b" } },
    { ...actor, memberships: [member] },
    { ...actor, privateCapability: token },
  ])("blocks pre-accept native identity/context drift %j", async (fresh) => {
    const f = await started(actor);
    f.request.mockResolvedValue(fresh);
    await f.controller.accept({ mode: "signedIn" });
    expect(posts(f.request)).toHaveLength(0);
    expect(f.controller.getState().completed).toBeNull();
  });

  it.each(["subject", "session"])(
    "does not acknowledge a different post-accept native %s",
    async (changed) => {
      const f = await started(actor);
      f.request.mockImplementation(async (path, options) => {
        if (path === invitationPath) {
          const result = await f.respond(path, options);
          f.setNative(
            changed === "subject"
              ? { ...actor, user: { ...actor.user, id: "other-subject" } }
              : {
                  ...actor,
                  session: { ...actor.session, id: "other-session" },
                },
          );
          return result;
        }
        return f.respond(path, options);
      });
      f.invalidate.mockClear();
      await f.controller.accept({ mode: "signedIn" });
      expect(posts(f.request)).toHaveLength(1);
      expect(f.controller.getState().completed).toBeNull();
      expect(f.invalidate).not.toHaveBeenCalled();
    },
  );

  it("reserves its attempt before a reentrant pending notification", async () => {
    const f = fixture(actor);
    let controller!: Controller;
    const onChange = vi.fn((state: { pending: boolean }) => {
      if (state.pending) void controller.accept({ mode: "signedIn" });
    });
    controller = makeController(f, token, onChange).controller;
    await controller.start();
    await controller.accept({ mode: "signedIn" });
    expect(posts(f.request)).toHaveLength(1);
  });

  it("rechecks a synchronous pending callback before the first protected request", async () => {
    const f = fixture(actor);
    let controller!: Controller;
    let accepting = false;
    controller = makeController(
      f,
      token,
      vi.fn((state: { pending: boolean }) => {
        if (accepting && state.pending) controller.dispose();
      }),
    ).controller;
    await controller.start();
    accepting = true;
    await controller.accept({ mode: "signedIn" });
    expect(posts(f.request)).toHaveLength(0);
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it.each(["dispose", "owner", "current"])(
    "cannot accept after %s loss during the fresh identity read",
    async (loss) => {
      const f = await started(actor);
      const me = deferred<unknown>();
      f.request.mockReturnValueOnce(me.promise);
      const work = f.controller.accept({ mode: "signedIn" });
      await settle();
      if (loss === "dispose") f.controller.dispose();
      else if (loss === "owner") f.owner.invalidate(false);
      else f.ports.isCurrent = () => false;
      me.resolve(actor);
      await work;
      expect(posts(f.request)).toHaveLength(0);
      expect(f.controller.getState().completed).toBeNull();
    },
  );

  it.each(["resolve", "reject"])(
    "late accept %s cannot invalidate or publish after disposal",
    async (result) => {
      const f = await started(actor);
      const reply = deferred<unknown>();
      f.request.mockImplementation((path, options) =>
        path === invitationPath ? reply.promise : f.respond(path, options),
      );
      const work = f.controller.accept({ mode: "signedIn" });
      await settle();
      expect(posts(f.request)).toHaveLength(1);
      f.controller.dispose();
      f.invalidate.mockClear();
      const published = f.onChange.mock.calls.length;
      if (result === "resolve") reply.resolve({ siteId: "wedding-a" });
      else reply.reject(new ApiError(401, "UNAUTHORIZED"));
      await work;
      expect(f.onChange).toHaveBeenCalledTimes(published);
      expect(f.invalidate).not.toHaveBeenCalled();
      expect(
        f.request.mock.calls.filter(([path]) => path === mePath),
      ).toHaveLength(2);
    },
  );

  it("cannot publish after a reentrant success-cleanup owner invalidation", async () => {
    const f = await started(actor);
    f.onInvalidate.mockImplementation(() => f.owner.invalidate(false));
    await f.controller.accept({ mode: "signedIn" });
    expect(posts(f.request)).toHaveLength(1);
    expect(f.controller.getState().completed).toBeNull();
  });

  it("rejects an extra notification inside the owned membership invalidation", async () => {
    const f = await started(actor);
    let extra = false;
    const unsubscribe = f.owner.subscribe(() => {
      if (!extra && f.owner.getSnapshot().status === "unverified") {
        extra = true;
        f.owner.invalidate(false);
      }
    });
    await f.controller.accept({ mode: "signedIn" });
    unsubscribe();
    expect(posts(f.request)).toHaveLength(1);
    expect(f.controller.getState().completed).toBeNull();
  });

  it("never exposes private failure causes in public state", async () => {
    const f = await started(actor);
    f.request.mockImplementation((path, options) => {
      if (path === invitationPath)
        throw new Error(`private password secret12 invitation ${token}`);
      return f.respond(path, options);
    });
    await f.controller.accept({ mode: "signedIn" });
    expect(f.controller.getState().error).toBeTruthy();
    expect(f.controller.getState().completed).toBeNull();
    assertPrivate(f.controller.getState());
  });
});

describe("anonymous first-access acceptance", () => {
  it("requires fresh 401 before and after new acceptance without login/invalidation", async () => {
    const f = await started();
    f.controller.setMode("new");
    await f.controller.accept({ mode: "new", password: "secret12" });
    expect(posts(f.request)).toEqual([
      [
        invitationPath,
        { method: "POST", body: { token, password: "secret12" } },
      ],
    ]);
    expect(f.request.mock.calls.map(([path]) => path)).toEqual([
      mePath,
      mePath,
      invitationPath,
      mePath,
    ]);
    expect(f.runAuthentication).not.toHaveBeenCalled();
    expect(f.invalidate).not.toHaveBeenCalled();
    expect(f.controller.getState().completed).toEqual({
      siteId: "wedding-a",
      signedIn: false,
    });
    assertPrivate(f.controller.getState());
  });

  it.each([actor, new ApiError(403, "DENIED"), new Error("unavailable")])(
    "requires anonymous confirmation before new dispatch %j",
    async (fresh) => {
      const f = await started();
      f.controller.setMode("new");
      f.request.mockImplementation(async () => {
        if (fresh instanceof Error) throw fresh;
        return fresh;
      });
      await f.controller.accept({ mode: "new", password: "secret12" });
      expect(posts(f.request)).toHaveLength(0);
      expect(f.controller.getState().completed).toBeNull();
    },
  );

  it("does not complete anonymous acceptance after a new native identity appears", async () => {
    const f = await started();
    f.controller.setMode("new");
    f.request.mockImplementation(async (path, options) => {
      if (path === invitationPath) {
        const result = await f.respond(path, options);
        f.setNative(actor);
        return result;
      }
      return f.respond(path, options);
    });
    await f.controller.accept({ mode: "new", password: "secret12" });
    expect(posts(f.request)).toHaveLength(1);
    expect(f.controller.getState().completed).toBeNull();
    expect(f.invalidate).not.toHaveBeenCalled();
    expect(f.runAuthentication).not.toHaveBeenCalled();
  });

  it("rejects a new password mode while an account is already connected", async () => {
    const f = await started(actor);
    f.controller.setMode("new");
    await f.controller.accept({ mode: "new", password: "secret12" });
    expect(posts(f.request)).toHaveLength(0);
    expect(posts(f.request, signInPath)).toHaveLength(0);
  });

  it("mode cancellation cannot clear a replacement controller's pending attempt", async () => {
    const f = await started();
    const oldAccept = deferred<unknown>();
    const login = deferred<unknown>();
    f.request.mockImplementation((path, options) => {
      if (path === invitationPath) return oldAccept.promise;
      if (path === signInPath) return login.promise;
      return f.respond(path, options);
    });
    f.controller.setMode("new");
    const old = f.controller.accept({ mode: "new", password: "secret12" });
    await settle();
    expect(posts(f.request)).toHaveLength(1);
    f.controller.setMode("existing");
    expect(f.controller.getState().validToken).toBe(false);
    const replacement = makeController(f, "b".repeat(43));
    await replacement.controller.start();
    replacement.controller.setMode("existing");
    const newer = replacement.controller.accept({
      mode: "existing",
      email: actor.user.email,
      password: "current-password",
    });
    await settle();
    expect(posts(f.request, signInPath)).toHaveLength(1);
    oldAccept.resolve({ siteId: "wedding-a" });
    await old;
    expect(replacement.controller.getState().pending).toBe(true);
    expect(f.controller.getState().completed).toBeNull();
    replacement.controller.dispose();
    login.resolve({ ok: true });
    await newer;
    expect(posts(f.request)).toHaveLength(1);
  });
});

describe("existing-account authentication transition", () => {
  it("does not start authentication through a callable retrieved after disposal", async () => {
    const f = await started();
    f.controller.setMode("existing");
    const original = f.owner.runAuthentication;
    const authentication = vi.fn(original);
    Object.defineProperty(f.owner, "runAuthentication", {
      get() {
        f.controller.dispose();
        return authentication;
      },
    });
    await f.controller.accept({
      mode: "existing",
      email: actor.user.email,
      password: "secret12",
    });
    expect(authentication).not.toHaveBeenCalled();
    expect(posts(f.request, signInPath)).toHaveLength(0);
  });
  async function existing() {
    const f = await started();
    f.controller.setMode("existing");
    return f;
  }
  const input: TeamAcceptance = {
    mode: "existing",
    email: " HELPER@EXAMPLE.TEST ",
    password: "current-password",
  };

  it("allows only its native INIT/final notifications and binds normalized email through strict Me", async () => {
    const f = await existing();
    f.load.mockClear();
    f.request.mockImplementation(async (path, options) => {
      if (path === signInPath) {
        expect(f.owner.getSnapshot()).toEqual({
          status: "unverified",
          actor: null,
          sessionEpoch: null,
        });
      }
      return f.respond(path, options);
    });
    await f.controller.accept(input);
    expect(f.runAuthentication).toHaveBeenCalledTimes(1);
    expect(f.unverifiedNotifications).toHaveBeenCalledTimes(2);
    expect(f.load).not.toHaveBeenCalled();
    expect(f.request.mock.calls.map(([path]) => path)).toEqual([
      mePath,
      mePath,
      signInPath,
      mePath,
      invitationPath,
      mePath,
    ]);
    expect(posts(f.request, signInPath)).toEqual([
      [
        signInPath,
        {
          method: "POST",
          body: { email: "helper@example.test", password: "current-password" },
        },
      ],
    ]);
    expect(posts(f.request)).toEqual([
      [invitationPath, { method: "POST", body: { token } }],
    ]);
    expect(f.controller.getState().completed).toEqual({
      siteId: "wedding-a",
      signedIn: true,
    });
    expect(f.owner.getSnapshot().status).toBe("unverified");
    assertPrivate(f.controller.getState());
  });

  it.each([{ ok: false }, { ok: true, token }, {}, null])(
    "does not trust a malformed native sign-in success %j",
    async (reply) => {
      const f = await existing();
      f.request.mockImplementation((path, options) =>
        path === signInPath ? Promise.resolve(reply) : f.respond(path, options),
      );
      await f.controller.accept(input);
      expect(posts(f.request, signInPath)).toHaveLength(1);
      expect(posts(f.request)).toHaveLength(0);
      expect(f.controller.getState().completed).toBeNull();
      assertPrivate(f.controller.getState());
    },
  );

  it.each([
    { ...actor, user: { ...actor.user, email: "other@example.test" } },
    {
      ...actor,
      session: { ...actor.session, expiresAt: "2026-10-12T00:00:00Z" },
    },
    { ...actor, unexpected: token },
    new ApiError(401, "UNAUTHORIZED"),
  ])(
    "blocks second helper POST after wrong/unavailable signed-in Me %j",
    async (fresh) => {
      const f = await existing();
      let signedIn = false;
      f.request.mockImplementation(async (path, options) => {
        if (path === signInPath) {
          signedIn = true;
          return { ok: true };
        }
        if (path === mePath && signedIn) {
          if (fresh instanceof Error) throw fresh;
          return fresh;
        }
        return f.respond(path, options);
      });
      await f.controller.accept(input);
      expect(posts(f.request)).toHaveLength(0);
      expect(f.controller.getState().completed).toBeNull();
      expect(f.controller.getState().sessionUnavailable).toBe(true);
    },
  );

  it.each(["dispose", "invalidate", "mode", "current"])(
    "cannot issue the helper's second POST after %s during sign-in",
    async (loss) => {
      const f = await existing();
      const login = deferred<unknown>();
      f.request.mockImplementation((path, options) =>
        path === signInPath ? login.promise : f.respond(path, options),
      );
      const work = f.controller.accept(input);
      await settle();
      expect(posts(f.request, signInPath)).toHaveLength(1);
      if (loss === "dispose") f.controller.dispose();
      else if (loss === "invalidate") f.owner.invalidate(false);
      else if (loss === "mode") f.controller.setMode("new");
      else f.ports.isCurrent = () => false;
      const published = f.onChange.mock.calls.length;
      f.setNative(actor);
      login.resolve({ ok: true });
      await work;
      expect(posts(f.request)).toHaveLength(0);
      expect(f.controller.getState().completed).toBeNull();
      if (loss === "dispose")
        expect(f.onChange).toHaveBeenCalledTimes(published);
    },
  );

  it.each(["INIT", "settlement"])(
    "rejects a reentrant extra owner notification during %s attribution",
    async (window) => {
      const f = await existing();
      let events = 0;
      let extra = false;
      const unsubscribe = f.owner.subscribe(() => {
        if (f.owner.getSnapshot().status !== "unverified") return;
        events++;
        if (!extra && events === (window === "INIT" ? 1 : 2)) {
          extra = true;
          f.owner.invalidate(false);
        }
      });
      await f.controller.accept(input);
      unsubscribe();
      expect(f.controller.getState().completed).toBeNull();
      if (window === "INIT") {
        expect(posts(f.request, signInPath)).toHaveLength(0);
        expect(posts(f.request)).toHaveLength(0);
      }
    },
  );

  it("rejects native session replacement after membership grant without stale completion", async () => {
    const f = await existing();
    f.request.mockImplementation(async (path, options) => {
      const result = await f.respond(path, options);
      if (path === invitationPath)
        f.setNative({
          ...actor,
          session: { ...actor.session, id: "session-b" },
        });
      return result;
    });
    await f.controller.accept(input);
    expect(posts(f.request)).toHaveLength(1);
    expect(f.controller.getState().completed).toBeNull();
    expect(f.unverifiedNotifications).toHaveBeenCalledTimes(2);
  });

  it("a failed explicit login requires explicit entry retry before another acceptance", async () => {
    const f = await existing();
    f.request.mockImplementation((path, options) => {
      if (path === signInPath)
        return Promise.reject(new ApiError(401, "INVALID_EMAIL_OR_PASSWORD"));
      return f.respond(path, options);
    });
    await f.controller.accept(input);
    expect(f.controller.getState().sessionUnavailable).toBe(true);
    await f.controller.accept(input);
    expect(posts(f.request, signInPath)).toHaveLength(1);
    f.request.mockImplementation(f.respond);
    await f.controller.start();
    f.controller.setMode("existing");
    await f.controller.accept(input);
    expect(posts(f.request)).toHaveLength(1);
  });
});

describe("explicit use-another-account sign-out", () => {
  it("fresh-checks identity, owns sign-out and confirms anonymous after its final notification", async () => {
    const f = await started(actor);
    f.load.mockClear();
    await f.controller.signOut();
    expect(f.request.mock.calls.map(([path]) => path)).toEqual([
      mePath,
      mePath,
      signOutPath,
      mePath,
      mePath,
    ]);
    expect(posts(f.request, signOutPath)).toEqual([
      [signOutPath, { method: "POST", body: {} }],
    ]);
    expect(f.runAuthentication).toHaveBeenCalledTimes(1);
    expect(f.unverifiedNotifications).toHaveBeenCalledTimes(2);
    expect(f.loadsDuringAuthentication).not.toHaveBeenCalled();
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.controller.getState()).toMatchObject({
      actor: null,
      mode: "existing",
      sessionUnavailable: false,
      pending: false,
      completed: null,
      validToken: true,
    });
  });

  it("does not sign out a different freshly observed native session", async () => {
    const f = await started(actor);
    f.setNative({ ...actor, session: { ...actor.session, id: "replacement" } });
    await f.controller.signOut();
    expect(posts(f.request, signOutPath)).toHaveLength(0);
    expect(f.runAuthentication).not.toHaveBeenCalled();
  });

  it("does not establish anonymous mode when native sign-out leaves a session", async () => {
    const f = await started(actor);
    f.request.mockImplementation((path, options) =>
      path === signOutPath
        ? Promise.resolve({ ok: true })
        : f.respond(path, options),
    );
    await f.controller.signOut();
    expect(f.controller.getState().sessionUnavailable).toBe(true);
    expect(f.controller.getState().mode).not.toBe("existing");
  });

  it("obsolete sign-out completion cannot publish anonymous state or reset cache again", async () => {
    const f = await started(actor);
    const reply = deferred<unknown>();
    f.request.mockImplementation((path, options) =>
      path === signOutPath ? reply.promise : f.respond(path, options),
    );
    const work = f.controller.signOut();
    await settle();
    expect(posts(f.request, signOutPath)).toHaveLength(1);
    f.controller.dispose();
    const published = f.onChange.mock.calls.length;
    f.setNative(null);
    reply.resolve({ ok: true });
    await work;
    expect(f.onChange).toHaveBeenCalledTimes(published);
    expect(f.unverifiedNotifications).toHaveBeenCalledTimes(2);
    expect(
      f.request.mock.calls.filter(([path]) => path === mePath),
    ).toHaveLength(2);
  });

  it("does not publish anonymous success after sign-out cleanup reentrancy", async () => {
    const f = await started(actor);
    const unsubscribe = f.owner.subscribe(() => {
      if (f.owner.getSnapshot().status === "unverified")
        f.ports.isCurrent = () => false;
    });
    await f.controller.signOut();
    unsubscribe();
    expect(f.controller.getState().mode).not.toBe("existing");
    expect(posts(f.request, signOutPath)).toHaveLength(0);
  });
});

async function mounted(f = fixture(), capability = token, strict = true) {
  window.history.replaceState(null, "", `/team-invitation#token=${capability}`);
  const container = document.createElement("div");
  document.body.append(container);
  const entry = { root: createRoot(container), container, active: true };
  mounts.push(entry);
  const render = async (ports = f.ports) => {
    await act(async () => {
      const view = createElement(acceptance.TeamInvitationAcceptance, {
        ports,
      });
      entry.root.render(strict ? createElement(StrictMode, null, view) : view);
    });
  };
  await render();
  return { ...f, container, entry, render };
}
async function click(container: HTMLElement, text: string) {
  const button = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find((entry) => entry.textContent?.trim() === text);
  if (!button) throw new Error(`Expected real button: ${text}`);
  await act(async () => button.click());
  return button;
}
async function submit(container: HTMLElement, existing = false) {
  const input = container.querySelector<HTMLInputElement>(
    'input[name="password"]',
  );
  const form = input?.closest("form");
  if (!input || !form)
    throw new Error("Expected real password acceptance form");
  const email = form.querySelector<HTMLInputElement>('input[name="email"]');
  if (existing && email) email.value = "helper@example.test";
  await act(async () => {
    input.value = existing ? "current-password" : "secret12";
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    expect(input.value).toBe("");
  });
  return input;
}

describe("team acceptance actual React DOM with synthetic native transport", () => {
  it("does not invoke external cleanup returned after a runtime getter changes the owner", async () => {
    const view = await mounted(fixture(actor));
    const cleanup = vi.fn();
    Object.defineProperty(view.ports, "onInvalidate", {
      get() {
        view.owner.invalidate(false);
        return cleanup;
      },
    });
    await click(view.container, "Aceitar convite");
    expect(cleanup).not.toHaveBeenCalled();
    expect(view.container.textContent).not.toContain("Convite aceito");
  });
  it("masks old identity before layout when the same ports object changes owner", async () => {
    const f = fixture(actor);
    const next = fixture({
      ...actor,
      user: { ...actor.user, id: "other-user", email: "other@example.test" },
    });
    await next.owner.load(true);
    window.history.replaceState(null, "", `/join-team#token=${token}`);
    const container = document.createElement("div");
    document.body.append(container);
    const entry = { root: createRoot(container), container, active: true };
    mounts.push(entry);
    const observations: string[] = [];
    function Host({ observe }: { observe: boolean }) {
      useLayoutEffect(() => {
        if (observe) observations.push(container.textContent ?? "");
      }, [observe]);
      return createElement(acceptance.TeamInvitationAcceptance, {
        ports: f.ports,
      });
    }
    await act(async () => {
      entry.root.render(createElement(Host, { observe: false }));
      await settle();
    });
    expect(container.textContent).toContain(actor.user.email);
    f.ports.owner = next.owner;
    await act(async () => {
      entry.root.render(createElement(Host, { observe: true }));
      await settle();
    });
    expect(observations).toHaveLength(1);
    expect(observations[0]).not.toContain(actor.user.email);
    expect(posts(f.request)).toHaveLength(0);
  });
  it("SSR has no enabled acceptance controls or token/password projection", () => {
    const html = renderToStaticMarkup(
      createElement(acceptance.TeamInvitationAcceptance),
    );
    expect(html).toContain("Verificando");
    expect(html).not.toContain(token);
    expect(html).not.toContain('name="password"');
    expect(html).not.toContain('type="submit"');
  });

  it("StrictMode coalesces entry, strips the hash and keeps token private", async () => {
    const f = await mounted();
    expect(f.request.mock.calls).toEqual([[mePath]]);
    expect(window.location.hash).toBe("");
    expect(f.container.textContent).toContain("Primeiro acesso");
    expect(f.container.innerHTML).not.toContain(token);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(posts(f.request)).toHaveLength(0);
  });

  it("anonymous first access clears the actual password on submit and never logs in", async () => {
    const f = fixture();
    const reply = deferred<unknown>();
    f.request.mockImplementation((path, options) =>
      path === invitationPath ? reply.promise : f.respond(path, options),
    );
    const view = await mounted(f);
    await click(view.container, "Primeiro acesso");
    const password = await submit(view.container);
    expect(password.value).toBe("");
    expect(posts(f.request)).toEqual([
      [
        invitationPath,
        { method: "POST", body: { token, password: "secret12" } },
      ],
    ]);
    expect(view.container.innerHTML).not.toContain(token);
    expect(view.container.innerHTML).not.toContain("secret12");
    await act(async () => reply.resolve({ siteId: "wedding-a" }));
    expect(view.container.textContent).toContain("Convite aceito");
    expect(view.container.textContent).toContain("Ir para o login");
    expect(posts(f.request, signInPath)).toHaveLength(0);
    expect(f.invalidate).not.toHaveBeenCalled();
  });

  it("clears the replaced mode's real password input", async () => {
    const f = await mounted();
    await click(f.container, "Primeiro acesso");
    const old = f.container.querySelector<HTMLInputElement>(
      'input[name="password"]',
    );
    if (!old) throw new Error("Expected mounted new-password field");
    old.value = "secret12";
    await click(f.container, "Já tenho acesso");
    expect(old.value).toBe("");
    expect(
      f.container.querySelector<HTMLInputElement>('input[name="password"]')
        ?.value,
    ).toBe("");
    expect(posts(f.request)).toHaveLength(0);
  });

  it("clears a detached password field on actual unmount", async () => {
    const f = await mounted();
    await click(f.container, "Primeiro acesso");
    const input = f.container.querySelector<HTMLInputElement>(
      'input[name="password"]',
    );
    if (!input) throw new Error("Expected password field");
    input.value = "secret12";
    await act(async () => f.entry.root.unmount());
    f.entry.active = false;
    expect(input.value).toBe("");
    expect(posts(f.request)).toHaveLength(0);
  });

  it("existing sign-in uses the actual form and strict Me before token-only acceptance", async () => {
    const f = await mounted();
    await click(f.container, "Já tenho acesso");
    await submit(f.container, true);
    expect(posts(f.request, signInPath)).toHaveLength(1);
    expect(posts(f.request)).toEqual([
      [invitationPath, { method: "POST", body: { token } }],
    ]);
    expect(f.container.textContent).toContain("Convite aceito");
    expect(f.container.textContent).toContain("Abrir casamento");
    expect(f.container.innerHTML).not.toContain(token);
    expect(f.container.innerHTML).not.toContain("current-password");
    expect(f.unverifiedNotifications).toHaveBeenCalledTimes(2);
  });

  it("actual unmount during sign-in prevents the second helper POST", async () => {
    const f = fixture();
    const login = deferred<unknown>();
    f.request.mockImplementation((path, options) =>
      path === signInPath ? login.promise : f.respond(path, options),
    );
    const view = await mounted(f);
    await click(view.container, "Já tenho acesso");
    await submit(view.container, true);
    expect(posts(f.request, signInPath)).toHaveLength(1);
    await act(async () => view.entry.root.unmount());
    view.entry.active = false;
    f.setNative(actor);
    await act(async () => login.resolve({ ok: true }));
    expect(posts(f.request)).toHaveLength(0);
    expect(f.unverifiedNotifications).toHaveBeenCalledTimes(2);
  });

  it.each(["new ports", "same ports"])(
    "replacing owner with %s while sign-in waits cannot resume its old helper",
    async (replacementKind) => {
      const f = fixture();
      const login = deferred<unknown>();
      f.request.mockImplementation((path, options) =>
        path === signInPath ? login.promise : f.respond(path, options),
      );
      const view = await mounted(f);
      await click(view.container, "Já tenho acesso");
      await submit(view.container, true);
      const replacement = fixture(actor);
      if (replacementKind === "same ports") f.ports.owner = replacement.owner;
      await view.render(
        replacementKind === "same ports" ? f.ports : replacement.ports,
      );
      f.setNative(actor);
      await act(async () => login.resolve({ ok: true }));
      expect(posts(f.request)).toHaveLength(0);
      expect(posts(replacement.request)).toHaveLength(0);
      expect(view.container.textContent).not.toContain("Convite aceito");
    },
  );

  it("signed-in acceptance late success after unmount cannot add cache invalidation", async () => {
    const f = fixture(actor);
    const reply = deferred<unknown>();
    f.request.mockImplementation((path, options) =>
      path === invitationPath ? reply.promise : f.respond(path, options),
    );
    const view = await mounted(f);
    await click(view.container, "Aceitar convite");
    expect(posts(f.request)).toHaveLength(1);
    await act(async () => view.entry.root.unmount());
    view.entry.active = false;
    await act(async () => reply.resolve({ siteId: "wedding-a" }));
    expect(f.invalidate).not.toHaveBeenCalled();
    expect(
      f.request.mock.calls.filter(([path]) => path === mePath),
    ).toHaveLength(2);
  });

  it("the use-another-account button verifies native sign-out before showing existing mode", async () => {
    const f = await mounted(fixture(actor));
    await click(f.container, "Usar outra conta");
    expect(posts(f.request, signOutPath)).toHaveLength(1);
    expect(f.container.querySelector('input[name="email"]')).not.toBeNull();
    expect(f.container.textContent).not.toContain("Você está conectado");
    expect(f.loadsDuringAuthentication).not.toHaveBeenCalled();
    expect(
      f.request.mock.calls.filter(([path]) => path === mePath),
    ).toHaveLength(4);
    expect(f.unverifiedNotifications).toHaveBeenCalledTimes(2);
    expect(f.container.innerHTML).not.toContain(token);
  });

  it("a true remount without a fresh fragment cannot resurrect the discarded capability", async () => {
    const f = await mounted();
    await act(async () => f.entry.root.unmount());
    f.entry.active = false;
    const container = document.createElement("div");
    document.body.append(container);
    const entry = { root: createRoot(container), container, active: true };
    mounts.push(entry);
    await act(async () =>
      entry.root.render(
        createElement(acceptance.TeamInvitationAcceptance, { ports: f.ports }),
      ),
    );
    expect(container.textContent).toContain("Link inválido");
    expect(container.querySelector('input[name="password"]')).toBeNull();
    expect(posts(f.request)).toHaveLength(0);
  });

  it("owner invalidation clears real controls and refuses obsolete acceptance settlement", async () => {
    const f = fixture(actor);
    const reply = deferred<unknown>();
    f.request.mockImplementation((path, options) =>
      path === invitationPath ? reply.promise : f.respond(path, options),
    );
    const view = await mounted(f);
    await click(view.container, "Aceitar convite");
    await act(async () => f.owner.invalidate(false));
    const calls = f.invalidate.mock.calls.length;
    await act(async () => reply.resolve({ siteId: "wedding-a" }));
    expect(f.invalidate).toHaveBeenCalledTimes(calls);
    expect(view.container.textContent).not.toContain("Convite aceito");
    expect(view.container.innerHTML).not.toContain(token);
    expect(view.container.querySelector('input[name="password"]')).toBeNull();
  });
});
