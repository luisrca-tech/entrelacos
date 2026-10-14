import type { MeResponse } from "@entrelacos/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../lib/apiClient";
import {
  createPanelActorOwner,
  createPanelAuthenticationActions,
  getCachedPanelActor,
  loadPanelActor,
  mountPanelSessionLifecycle,
  resetPanelActorCache,
} from "./panelActor";

vi.mock("../lib/apiClient", async (original) => ({
  ...(await original<typeof import("../lib/apiClient")>()),
  apiRequest: vi.fn(),
}));

const apiRequestMock = vi.mocked(apiRequest);

const actor = {
  user: {
    id: "user-1",
    name: "Test User",
    email: "user@example.test",
    role: "OWNER",
  },
  session: { id: "session-1", expiresAt: "2026-10-19T00:00:00.000Z" },
  siteId: null,
} as MeResponse;

const start = Date.parse("2026-10-12T18:00:00.000Z");
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("observable administrative session ownership", () => {
  afterEach(() => vi.useRealTimers());
  function fixture(request = vi.fn().mockResolvedValue(actor)) {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const broadcast = vi.fn();
    const owner = createPanelActorOwner({
      request,
      broadcast,
      now: () => Date.now(),
    });
    return { owner, request, broadcast };
  }
  it("publishes only a validated current actor with an observable epoch", async () => {
    const f = fixture();
    const changed = vi.fn();
    const unsubscribe = f.owner.subscribe(changed);
    expect(f.owner.getSnapshot()).toEqual({
      status: "unverified",
      actor: null,
      sessionEpoch: null,
    });
    await f.owner.load();
    expect(f.owner.getSnapshot()).toMatchObject({
      status: "verified",
      actor,
      sessionEpoch: expect.any(Number),
    });
    expect(changed).toHaveBeenCalled();
    unsubscribe();
    f.owner.dispose();
  });
  it("does not dispatch a scheduled identity read after reset before its microtask", async () => {
    const f = fixture();
    const first = f.owner.load();
    f.owner.invalidate();
    await expect(first).rejects.toThrow("Session ownership changed");
    expect(f.request).not.toHaveBeenCalled();
    f.owner.dispose();
  });
  it("attaches real entry/resume/hint listeners and cleans up its final owner", async () => {
    const f = fixture();
    const target = new EventTarget();
    const document = Object.assign(new EventTarget(), {
      visibilityState: "visible" as DocumentVisibilityState,
    });
    const channel = {
      onmessage: null as BroadcastChannel["onmessage"],
      close: vi.fn(),
    };
    const cleanup = mountPanelSessionLifecycle(
      { target, document, createChannel: () => channel },
      f.owner,
    );
    await f.owner.load();
    expect(f.request).toHaveBeenCalledTimes(1);
    const firstEpoch = f.owner.getSnapshot().sessionEpoch;
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(f.owner.getSnapshot().sessionEpoch).toBeNull();
    expect(f.request).toHaveBeenCalledTimes(1);
    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await f.owner.load();
    expect(f.owner.getSnapshot().sessionEpoch).toBeGreaterThan(
      firstEpoch as number,
    );
    channel.onmessage?.call(
      {} as BroadcastChannel,
      new MessageEvent("message", {
        data: { type: "ADMIN_SESSION_INVALIDATED" },
      }),
    );
    expect(f.owner.getSnapshot().sessionEpoch).toBeNull();
    expect(f.request).toHaveBeenCalledTimes(2);
    target.dispatchEvent(new Event("focus"));
    await f.owner.load();
    expect(f.request).toHaveBeenCalledTimes(3);
    cleanup();
    expect(channel.close).toHaveBeenCalledTimes(1);
    expect(f.owner.getSnapshot().sessionEpoch).toBeNull();
    target.dispatchEvent(new Event("focus"));
    expect(f.request).toHaveBeenCalledTimes(3);
    f.owner.dispose();
  });
  it("keeps concurrent lifecycle consumers until the last cleanup", async () => {
    const f = fixture();
    const target = new EventTarget();
    const document = Object.assign(new EventTarget(), {
      visibilityState: "visible" as DocumentVisibilityState,
    });
    const channel = {
      onmessage: null as BroadcastChannel["onmessage"],
      close: vi.fn(),
    };
    const createChannel = vi.fn(() => channel);
    const first = mountPanelSessionLifecycle(
      { target, document, createChannel },
      f.owner,
    );
    const second = mountPanelSessionLifecycle(
      { target, document, createChannel },
      f.owner,
    );
    await f.owner.load();
    first();
    expect(f.owner.getSnapshot().status).toBe("verified");
    expect(channel.close).not.toHaveBeenCalled();
    second();
    expect(channel.close).toHaveBeenCalledTimes(1);
    expect(createChannel).toHaveBeenCalledTimes(1);
    f.owner.dispose();
  });
  it("invalidates synchronously on refresh and shares only the current generation request", async () => {
    const f = fixture();
    await f.owner.load();
    const oldEpoch = f.owner.getSnapshot().sessionEpoch;
    const pending = deferred<unknown>();
    f.request.mockReturnValueOnce(pending.promise);
    const first = f.owner.load(true);
    const second = f.owner.load(true);
    expect(first).toBe(second);
    expect(f.owner.getSnapshot()).toEqual({
      status: "loading",
      actor: null,
      sessionEpoch: null,
    });
    pending.resolve(actor);
    await first;
    expect(f.owner.getSnapshot().sessionEpoch).toBeGreaterThan(
      oldEpoch as number,
    );
    expect(f.request).toHaveBeenCalledTimes(2);
    f.owner.dispose();
  });
  it("rejects an old caller's successful promise after reset", async () => {
    const pending = deferred<unknown>();
    const f = fixture(vi.fn(() => pending.promise));
    const first = f.owner.load();
    const rejection = expect(first).rejects.toThrow(
      "Session ownership changed",
    );
    f.owner.invalidate();
    pending.resolve(actor);
    await rejection;
    expect(f.owner.getSnapshot()).toEqual({
      status: "unverified",
      actor: null,
      sessionEpoch: null,
    });
    expect(f.broadcast).toHaveBeenCalledTimes(1);
    f.owner.dispose();
  });
  it("does not let a late success or failure replace a newer session", async () => {
    const pending = deferred<unknown>();
    const f = fixture(
      vi
        .fn()
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue({
          ...actor,
          session: { ...actor.session, id: "session-2" },
        }),
    );
    const first = f.owner.load();
    const rejected = expect(first).rejects.toThrow("Session ownership changed");
    await Promise.resolve();
    f.owner.invalidate();
    await f.owner.load();
    const snapshot = f.owner.getSnapshot();
    pending.resolve(actor);
    await rejected;
    expect(f.owner.getSnapshot()).toBe(snapshot);
    f.owner.dispose();
  });
  it.each([401, 403])(
    "does not publish an obsolete identity denial %s over a newer actor",
    async (status) => {
      const { ApiError } = await import("../lib/apiClient");
      const pending = deferred<unknown>();
      const f = fixture(
        vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(actor),
      );
      const first = f.owner.load();
      const rejected = expect(first).rejects.toThrow(
        "Session ownership changed",
      );
      await Promise.resolve();
      f.owner.invalidate(false);
      await f.owner.load();
      const current = f.owner.getSnapshot();
      pending.reject(new ApiError(status, "ACCESS_DENIED"));
      await rejected;
      expect(f.owner.getSnapshot()).toBe(current);
      f.owner.dispose();
    },
  );
  it.each([
    { ...actor, session: undefined },
    { ...actor, session: { ...actor.session, id: "" } },
    {
      ...actor,
      session: { ...actor.session, expiresAt: "2026-02-30T00:00:00.000Z" },
    },
    {
      ...actor,
      session: { ...actor.session, expiresAt: "2026-10-12T17:59:59.999Z" },
    },
    { ...actor, sessionToken: "private" },
  ])("rejects malformed/expired/private me projections %j", async (value) => {
    const f = fixture(vi.fn().mockResolvedValue(value));
    await expect(f.owner.load()).rejects.toThrow();
    expect(f.owner.getSnapshot()).toEqual({
      status: "unavailable",
      actor: null,
      sessionEpoch: null,
    });
    f.owner.dispose();
  });
  it.each([401, 403, 503])(
    "clears every actor/epoch on current identity failure %i",
    async (status) => {
      const f = fixture();
      await f.owner.load();
      const { ApiError } = await import("../lib/apiClient");
      f.request.mockRejectedValueOnce(new ApiError(status, "REQUEST_FAILED"));
      await expect(f.owner.load(true)).rejects.toThrow();
      expect(f.owner.getSnapshot()).toEqual({
        status:
          status === 401
            ? "unauthenticated"
            : status === 403
              ? "denied"
              : "unavailable",
        actor: null,
        sessionEpoch: null,
      });
      f.owner.dispose();
    },
  );
  it("exposes no shared mutable authority through snapshots or return values", async () => {
    const f = fixture();
    const result = await f.owner.load();
    expect(() => {
      result.user.role = "SITE_ADMIN";
    }).toThrow();
    expect(f.owner.getSnapshot().actor?.user.role).toBe("OWNER");
    f.owner.dispose();
  });
  it("changes epoch for same-user new session and does not use time as epoch", async () => {
    const f = fixture();
    await f.owner.load();
    const old = f.owner.getSnapshot().sessionEpoch;
    f.request.mockResolvedValueOnce({
      ...actor,
      session: { ...actor.session, id: "session-2" },
    });
    await f.owner.load(true);
    const next = f.owner.getSnapshot().sessionEpoch;
    expect(next).toBeGreaterThan(old as number);
    expect(next).toBeLessThan(100);
    f.owner.dispose();
  });
  it("removes confidence at the session deadline without polling me", async () => {
    const f = fixture(
      vi.fn().mockResolvedValue({
        ...actor,
        session: {
          ...actor.session,
          expiresAt: new Date(start + 1000).toISOString(),
        },
      }),
    );
    await f.owner.load();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.owner.getSnapshot()).toEqual({
      status: "unauthenticated",
      actor: null,
      sessionEpoch: null,
    });
    expect(f.request).toHaveBeenCalledTimes(1);
    f.owner.dispose();
  });
  it("invalidates tokenless cross-tab hints without requesting or granting authority", async () => {
    const f = fixture();
    await f.owner.load();
    f.owner.receiveHint({ type: "ADMIN_SESSION_INVALIDATED" });
    expect(f.owner.getSnapshot()).toEqual({
      status: "unverified",
      actor: null,
      sessionEpoch: null,
    });
    expect(f.broadcast).not.toHaveBeenCalled();
    expect(f.request).toHaveBeenCalledTimes(1);
    f.owner.dispose();
  });
  it.each([
    null,
    {},
    { type: "VERIFIED", actor },
    { type: "ADMIN_SESSION_INVALIDATED", actor },
  ])("ignores malformed or permission-granting hint %j", async (hint) => {
    const f = fixture();
    await f.owner.load();
    const snapshot = f.owner.getSnapshot();
    f.owner.receiveHint(hint);
    expect(f.owner.getSnapshot()).toBe(snapshot);
    f.owner.dispose();
  });
  it("denies current resource authorization failures and ignores old-generation failures", async () => {
    const f = fixture();
    const { ApiError } = await import("../lib/apiClient");
    await f.owner.load();
    const oldEpoch = f.owner.getSnapshot().sessionEpoch;
    await f.owner.load(true);
    const current = f.owner.getSnapshot();
    f.owner.reportFailure(new ApiError(401, "UNAUTHORIZED"), oldEpoch);
    expect(f.owner.getSnapshot()).toBe(current);
    f.owner.reportFailure(
      new ApiError(403, "MEMBERSHIP_DENIED"),
      current.sessionEpoch,
    );
    expect(f.owner.getSnapshot()).toEqual({
      status: "denied",
      actor: null,
      sessionEpoch: null,
    });
    f.owner.dispose();
  });
  it("keeps a stable unverified SSR snapshot regardless of browser owner state", async () => {
    const f = fixture();
    const first = f.owner.getServerSnapshot();
    await f.owner.load();
    expect(f.owner.getServerSnapshot()).toBe(first);
    expect(first).toEqual({
      status: "unverified",
      actor: null,
      sessionEpoch: null,
    });
    f.owner.dispose();
  });
  it("rejects an actor invalidated by a synchronous verified subscriber", async () => {
    const f = fixture();
    f.owner.subscribe(() => {
      if (f.owner.getSnapshot().status === "verified")
        f.owner.invalidate(false);
    });
    await expect(f.owner.load()).rejects.toThrow("Session ownership changed");
    expect(f.owner.getSnapshot().actor).toBeNull();
    f.owner.dispose();
  });
  it("rejects installation that reaches its deadline before the caller receives the actor", async () => {
    const now = vi
      .fn()
      .mockReturnValueOnce(start)
      .mockReturnValueOnce(start)
      .mockReturnValue(start + 1);
    const owner = createPanelActorOwner({
      now,
      request: vi.fn().mockResolvedValue({
        ...actor,
        session: {
          ...actor.session,
          expiresAt: new Date(start + 1).toISOString(),
        },
      }),
    });
    await expect(owner.load()).rejects.toThrow("Session ownership changed");
    expect(owner.getSnapshot().status).toBe("unauthenticated");
    owner.dispose();
  });
  it("reserves the current promise before notifying loading subscribers", async () => {
    const f = fixture();
    let nested: Promise<MeResponse> | undefined;
    f.owner.subscribe(() => {
      if (f.owner.getSnapshot().status === "loading") nested = f.owner.load();
    });
    const first = f.owner.load();
    expect(first).toBe(nested);
    await first;
    expect(f.request).toHaveBeenCalledTimes(1);
    f.owner.dispose();
  });
  it.each([-1, 0.5, Number.NaN])(
    "denies a cached actor under an invalid clock %s",
    async (clock) => {
      let current = start;
      const owner = createPanelActorOwner({
        request: vi.fn().mockResolvedValue(actor),
        now: () => current,
      });
      await owner.load();
      current = clock;
      await expect(owner.load()).rejects.toThrow();
      expect(owner.getSnapshot().actor).toBeNull();
      owner.dispose();
    },
  );
  it.each([true, false])(
    "invalidates before authentication and keeps reads fenced until settlement %s",
    async (success) => {
      const f = fixture();
      await f.owner.load();
      const pending = deferred<void>();
      const operation = vi.fn(() => {
        expect(f.owner.getSnapshot().sessionEpoch).toBeNull();
        return pending.promise;
      });
      const work = f.owner.runAuthentication(operation);
      await expect(f.owner.load()).rejects.toThrow("Session ownership changed");
      expect(f.request).toHaveBeenCalledTimes(1);
      if (success) {
        pending.resolve();
        await work;
      } else {
        const rejected = expect(work).rejects.toThrow("Failed");
        pending.reject(new Error("Failed"));
        await rejected;
      }
      expect(f.owner.getSnapshot().actor).toBeNull();
      expect(f.broadcast).toHaveBeenCalledTimes(2);
      await f.owner.load();
      expect(f.request).toHaveBeenCalledTimes(2);
      f.owner.dispose();
    },
  );
});

describe("panel actor loading", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
  });
  it("lets only the latest mounted authentication attempt perform completion effects", async () => {
    const actions = createPanelAuthenticationActions();
    const old = deferred<void>();
    const next = deferred<void>();
    const oldSuccess = vi.fn();
    const currentSuccess = vi.fn();
    const failure = vi.fn();
    const first = actions.run(() => old.promise, oldSuccess, failure);
    const second = actions.run(() => next.promise, currentSuccess, failure);
    old.resolve();
    await first;
    expect(oldSuccess).not.toHaveBeenCalled();
    next.resolve();
    await second;
    expect(currentSuccess).toHaveBeenCalledTimes(1);
    actions.dispose();
  });
  afterEach(() => {
    resetPanelActorCache();
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  it("shares the bootstrap request and reuses the actor on sibling mounts", async () => {
    let resolveRequest!: (value: MeResponse) => void;
    apiRequestMock.mockReturnValueOnce(
      new Promise<MeResponse>((resolve) => {
        resolveRequest = resolve;
      }),
    );

    const first = loadPanelActor();
    const second = loadPanelActor();

    expect(first).toBe(second);
    await Promise.resolve();
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
    expect(getCachedPanelActor()).toBeNull();

    resolveRequest(actor);
    await expect(first).resolves.toEqual(actor);
    expect(getCachedPanelActor()).toEqual(actor);

    await expect(loadPanelActor()).resolves.toEqual(actor);
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
  });

  it("does not restore an old actor after session cache reset", async () => {
    let resolveRequest!: (value: MeResponse) => void;
    apiRequestMock.mockReturnValueOnce(
      new Promise<MeResponse>((resolve) => {
        resolveRequest = resolve;
      }),
    );
    const old = loadPanelActor();
    const rejected = expect(old).rejects.toThrow("Session ownership changed");
    await Promise.resolve();
    resetPanelActorCache();
    resolveRequest(actor);
    await rejected;
    expect(getCachedPanelActor()).toBeNull();
  });

  it("refreshes cached site permissions while sharing a concurrent refresh", async () => {
    apiRequestMock.mockResolvedValueOnce(actor);
    await loadPanelActor();
    const updated = { ...actor, memberships: [] };
    apiRequestMock.mockResolvedValueOnce(updated);
    const first = loadPanelActor(true);
    const second = loadPanelActor(true);
    expect(first).toBe(second);
    await expect(first).resolves.toEqual(updated);
    expect(apiRequestMock).toHaveBeenCalledTimes(2);
  });
});
