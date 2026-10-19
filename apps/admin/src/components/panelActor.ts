import { type MeResponse, meResponseSchema } from "@entrelacos/contracts";
import { ApiError, apiRequest } from "../lib/apiClient";

export type PanelSessionSnapshot = {
  status:
    | "unverified"
    | "loading"
    | "verified"
    | "unauthenticated"
    | "denied"
    | "unavailable";
  actor: MeResponse | null;
  sessionEpoch: number | null;
};
const emptySnapshot: PanelSessionSnapshot = Object.freeze({
  status: "unverified",
  actor: null,
  sessionEpoch: null,
});
const hint = Object.freeze({ type: "ADMIN_SESSION_INVALIDATED" });
const channelName = "entrelacos-admin-session";

function immutableActor(actor: MeResponse): MeResponse {
  Object.freeze(actor.user);
  Object.freeze(actor.session);
  for (const access of actor.memberships ?? []) {
    Object.freeze(access.capabilities);
    Object.freeze(access);
  }
  if (actor.memberships) Object.freeze(actor.memberships);
  return Object.freeze(actor);
}

export function createPanelActorOwner(
  options: {
    request?: () => Promise<unknown>;
    now?: () => number;
    broadcast?: () => void;
  } = {},
) {
  const request = options.request ?? (() => apiRequest("/v1/me"));
  const now = options.now ?? (() => Date.now());
  let snapshot = emptySnapshot;
  let generation = 0;
  let pending: Promise<MeResponse> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let authenticating = 0;
  let hidden = false;
  let suspended = false;
  const listeners = new Set<() => void>();
  const suspensionListeners = new Set<() => void>();
  function setSuspended(value: boolean) {
    if (suspended === value) return;
    suspended = value;
    for (const listener of suspensionListeners) listener();
  }
  function publish(next: PanelSessionSnapshot) {
    snapshot = Object.freeze(next);
    for (const listener of listeners) listener();
  }
  function invalidate(broadcast = true) {
    generation++;
    pending = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    publish(emptySnapshot);
    setSuspended(hidden);
    if (broadcast) options.broadcast?.();
  }
  function changed(): Error {
    return new Error("Session ownership changed");
  }
  function expire(epoch: number, expiresAt: number) {
    if (disposed || snapshot.sessionEpoch !== epoch) return;
    const current = now();
    if (!Number.isSafeInteger(current) || current < 0 || current >= expiresAt) {
      invalidate(false);
      publish({ status: "unauthenticated", actor: null, sessionEpoch: null });
      return;
    }
    timer = setTimeout(
      () => expire(epoch, expiresAt),
      Math.min(expiresAt - current, 2147483647),
    );
  }
  function load(refresh = false, silent = false): Promise<MeResponse> {
    if (disposed || authenticating) return Promise.reject(changed());
    if (pending) return pending;
    const reading = now();
    if (!Number.isSafeInteger(reading) || reading < 0) {
      invalidate(false);
      publish({ status: "unavailable", actor: null, sessionEpoch: null });
      return Promise.reject(new Error("Invalid administrative session"));
    }
    if (
      !refresh &&
      snapshot.status === "verified" &&
      snapshot.actor &&
      Date.parse(snapshot.actor.session.expiresAt) > reading
    )
      return Promise.resolve(snapshot.actor);
    const retained =
      silent &&
      snapshot.status === "verified" &&
      snapshot.actor &&
      Date.parse(snapshot.actor.session.expiresAt) > reading
        ? snapshot
        : null;
    generation++;
    if (!retained) {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    }
    const currentGeneration = generation;
    const work = Promise.resolve()
      .then(() => {
        if (disposed || currentGeneration !== generation) throw changed();
        return request();
      })
      .then((value) => {
        if (disposed || currentGeneration !== generation) throw changed();
        const actor = meResponseSchema.parse(value);
        const current = now();
        const expiresAt = Date.parse(actor.session.expiresAt);
        if (
          !Number.isSafeInteger(current) ||
          current < 0 ||
          expiresAt <= current ||
          actor.memberships?.some((access) => access.userId !== actor.user.id)
        )
          throw new Error("Invalid administrative session");
        if (
          retained &&
          JSON.stringify(actor) === JSON.stringify(retained.actor)
        )
          return retained.actor!;
        const immutable = immutableActor(actor);
        if (timer !== null) clearTimeout(timer);
        timer = null;
        publish({
          status: "verified",
          actor: immutable,
          sessionEpoch: currentGeneration,
        });
        if (disposed || currentGeneration !== generation) throw changed();
        expire(currentGeneration, expiresAt);
        if (disposed || currentGeneration !== generation) throw changed();
        return immutable;
      })
      .catch((cause) => {
        if (disposed || currentGeneration !== generation) throw changed();
        publish({
          status:
            cause instanceof ApiError && cause.status === 401
              ? "unauthenticated"
              : cause instanceof ApiError && cause.status === 403
                ? "denied"
                : "unavailable",
          actor: null,
          sessionEpoch: null,
        });
        throw cause;
      })
      .finally(() => {
        if (pending === work) pending = null;
        if (!disposed && currentGeneration === generation) setSuspended(hidden);
      });
    pending = work;
    // Reset can detach a request before its caller observes settlement.
    void work.catch(() => {});
    if (silent) setSuspended(true);
    if (!retained)
      publish({ status: "loading", actor: null, sessionEpoch: null });
    return work;
  }
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => emptySnapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load: (refresh = false) => load(refresh),
    revalidate() {
      hidden = false;
      return load(true, true);
    },
    suspend() {
      hidden = true;
      setSuspended(true);
    },
    isSuspended: () => suspended,
    getServerSuspensionSnapshot: () => false,
    subscribeSuspension(listener: () => void) {
      suspensionListeners.add(listener);
      return () => {
        suspensionListeners.delete(listener);
      };
    },
    invalidate,
    async runAuthentication<T>(operation: () => Promise<T>): Promise<T> {
      if (disposed) throw changed();
      authenticating++;
      invalidate();
      try {
        return await operation();
      } finally {
        authenticating--;
        invalidate();
      }
    },
    receiveHint(value: unknown) {
      if (
        value &&
        typeof value === "object" &&
        Object.keys(value).length === 1 &&
        "type" in value &&
        value.type === hint.type
      )
        invalidate(false);
    },
    reportFailure(cause: unknown, epoch: number | null) {
      if (
        epoch === null ||
        epoch !== snapshot.sessionEpoch ||
        !(cause instanceof ApiError) ||
        ![401, 403].includes(cause.status)
      )
        return;
      invalidate();
      publish({
        status: cause.status === 401 ? "unauthenticated" : "denied",
        actor: null,
        sessionEpoch: null,
      });
    },
    dispose() {
      disposed = true;
      generation++;
      pending = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      listeners.clear();
      suspensionListeners.clear();
      suspended = false;
      snapshot = emptySnapshot;
    },
  };
}

function broadcastInvalidation() {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined")
    return;
  try {
    const channel = new BroadcastChannel(channelName);
    channel.postMessage(hint);
    channel.close();
  } catch {}
}
export const panelActorOwner = createPanelActorOwner({
  broadcast: broadcastInvalidation,
});
export function getCachedPanelActor(): MeResponse | null {
  return panelActorOwner.getSnapshot().actor;
}
export function loadPanelActor(refresh = false): Promise<MeResponse> {
  return panelActorOwner.load(refresh);
}
export function resetPanelActorCache() {
  panelActorOwner.invalidate();
}
export function isCurrentPanelSessionEpoch(epoch: number | null): boolean {
  return (
    epoch !== null &&
    panelActorOwner.getSnapshot().status === "verified" &&
    panelActorOwner.getSnapshot().sessionEpoch === epoch
  );
}

export function createPanelAuthenticationActions() {
  let active = true;
  let attempt = 0;
  return {
    async run(
      operation: () => Promise<unknown>,
      onSuccess: () => void,
      onFailure: () => void,
    ) {
      if (!active) return;
      const current = ++attempt;
      try {
        await operation();
        if (active && current === attempt) onSuccess();
      } catch {
        if (active && current === attempt) onFailure();
      }
    },
    dispose() {
      active = false;
      attempt++;
    },
  };
}

type PanelActorOwner = ReturnType<typeof createPanelActorOwner>;
const lifecycles = new WeakMap<
  PanelActorOwner,
  { users: number; cleanup(): void }
>();
export function mountPanelSessionLifecycle(
  environment: {
    target: Pick<Window, "addEventListener" | "removeEventListener">;
    document: Pick<
      Document,
      "visibilityState" | "addEventListener" | "removeEventListener"
    >;
    createChannel?: () => Pick<BroadcastChannel, "onmessage" | "close">;
  },
  owner = panelActorOwner,
) {
  let lifecycle = lifecycles.get(owner);
  if (!lifecycle) {
    const resume = () => {
      if (environment.document.visibilityState === "visible")
        void owner.revalidate().catch(() => {});
      else owner.suspend();
    };
    let channel: Pick<BroadcastChannel, "onmessage" | "close"> | null = null;
    try {
      channel = environment.createChannel
        ? environment.createChannel()
        : typeof BroadcastChannel === "undefined"
          ? null
          : new BroadcastChannel(channelName);
      if (channel) channel.onmessage = (event) => owner.receiveHint(event.data);
    } catch {}
    environment.target.addEventListener("focus", resume);
    environment.document.addEventListener("visibilitychange", resume);
    lifecycle = {
      users: 0,
      cleanup() {
        environment.target.removeEventListener("focus", resume);
        environment.document.removeEventListener("visibilitychange", resume);
        if (channel) {
          channel.onmessage = null;
          channel.close();
        }
        owner.invalidate(false);
      },
    };
    lifecycles.set(owner, lifecycle);
  }
  const retained = lifecycle;
  retained.users++;
  if (environment.document.visibilityState === "visible")
    void owner.revalidate().catch(() => {});
  else {
    owner.suspend();
    void owner.load().catch(() => {});
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--retained.users === 0) {
      retained.cleanup();
      if (lifecycles.get(owner) === retained) lifecycles.delete(owner);
    }
  };
}
