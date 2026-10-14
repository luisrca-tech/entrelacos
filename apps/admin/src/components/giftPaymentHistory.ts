import {
  type GiftPurchaseHistoryDetailPage,
  type GiftPurchaseHistoryPayment,
  type GiftPurchaseHistoryPurchase,
  type GiftPurchaseHistoryReceipt,
  type GiftPurchaseHistoryScope,
  giftPurchaseHistoryDetailResponseSchema,
  giftPurchaseHistoryLimits,
  giftPurchaseHistoryPageResponseSchema,
  type SiteAccess,
  siteAccessSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import { ApiError, apiRequest } from "../lib/apiClient";
import {
  type createPanelActorOwner,
  type PanelSessionSnapshot,
  panelActorOwner,
} from "./panelActor";

export const MAX_OWNER_READ_ADMISSIONS = 64;
export const HISTORY_FEEDBACK_MS = 45_000;
export type HistoryViewerScope = {
  siteId: string;
  access: SiteAccess | null;
  sessionEpoch: number | null;
};
export type HistoryPorts = {
  owner?: ReturnType<typeof createPanelActorOwner>;
  request?: (
    path: string,
    options: { signal: AbortSignal },
  ) => Promise<unknown>;
  now?: () => number;
};
type Status =
  | "idle"
  | "loading"
  | "ready"
  | "denied"
  | "unavailable"
  | "conflict"
  | "local_limit"
  | "local_code";
export type GiftPaymentHistoryState = {
  status: Status;
  busy: boolean;
  admissions: number;
  purchases: GiftPurchaseHistoryPurchase[];
  nextIndexCursor: string | null;
  nextDetailCursor: string | null;
  indexReadCount: number | null;
  detail: {
    purchase: GiftPurchaseHistoryPurchase;
    samples: GiftPurchaseHistoryPayment[];
    receipts: GiftPurchaseHistoryReceipt[];
    coverage: GiftPurchaseHistoryDetailPage["coverage"];
    currentKnowledge: "UNKNOWN" | "UNAVAILABLE";
    readObservedAtMicros: string | null;
  } | null;
};
type PortValues = {
  owner: HistoryPorts["owner"];
  request: HistoryPorts["request"];
  now: HistoryPorts["now"];
};
type Authority = {
  owner: ReturnType<typeof createPanelActorOwner>;
  snapshot: PanelSessionSnapshot;
  readSnapshot: () => PanelSessionSnapshot;
  siteId: string;
  access: SiteAccess;
  accessKey: string;
  epoch: number;
  time: number;
};
type NavigationKey = { micros: string; kind: number; id: string };
type Navigation = {
  loaded: boolean;
  cursor: string | null;
  seen: Set<string>;
  tail: NavigationKey | null;
};
type Read = { orderId: string | null; cursor: string | null; restart: boolean };
type Holder = {
  authority: Authority;
  wireScope: GiftPurchaseHistoryScope | null;
  admissions: number;
  initialAttempted: boolean;
  lastTime: number;
  status: Status;
  selected: string | null;
  failed: Read | null;
  indexReadCount: number | null;
  purchases: Map<string, GiftPurchaseHistoryPurchase>;
  quotes: Map<string, string>;
  payments: Map<string, GiftPurchaseHistoryPayment[]>;
  paymentOrders: Map<string, string>;
  attempts: Map<string, string>;
  receipts: Map<string, GiftPurchaseHistoryReceipt>;
  credited: Map<string, string>;
  index: Navigation;
  details: Map<string, Navigation>;
  reads: Map<string, GiftPurchaseHistoryDetailPage>;
};
type Slot = { work: Promise<boolean>; abort: AbortController; token: object };
function navigation(): Navigation {
  return { loaded: false, cursor: null, seen: new Set(), tail: null };
}
function portsNow(ports: HistoryPorts): PortValues {
  return { owner: ports.owner, request: ports.request, now: ports.now };
}
function samePorts(a: PortValues, b: PortValues) {
  return a.owner === b.owner && a.request === b.request && a.now === b.now;
}
function sameAuthority(a: Authority, b: Authority) {
  return (
    a.owner === b.owner &&
    a.snapshot === b.snapshot &&
    a.readSnapshot === b.readSnapshot &&
    a.siteId === b.siteId &&
    a.access === b.access &&
    a.accessKey === b.accessKey &&
    a.epoch === b.epoch
  );
}
function accessKey(access: SiteAccess | null) {
  const parsed = siteAccessSchema.safeParse(access);
  return parsed.success ? JSON.stringify(parsed.data) : null;
}
function authority(
  scope: HistoryViewerScope,
  ports: HistoryPorts,
): Authority | null {
  try {
    // Read-port availability cannot revoke native ownership or refund retained admissions.
    const before = { owner: ports.owner, now: ports.now },
      owner = before.owner ?? panelActorOwner;
    const readSnapshot = owner.getSnapshot;
    const snapshot = readSnapshot.call(owner);
    const siteId = scope.siteId,
      access = scope.access,
      epoch = scope.sessionEpoch,
      key = accessKey(access);
    const time = before.now ? before.now() : Date.now(),
      actor = snapshot.actor;
    const membership = actor?.memberships?.find(
      (value) => value.siteId === siteId && value.userId === actor.user.id,
    );
    const finalReader = owner.getSnapshot;
    const finalPorts = { owner: ports.owner, now: ports.now };
    if (
      !siteIdSchema.safeParse(siteId).success ||
      !access ||
      !key ||
      snapshot.status !== "verified" ||
      !actor ||
      actor.user.role !== "SITE_ADMIN" ||
      epoch === null ||
      epoch !== snapshot.sessionEpoch ||
      !membership ||
      membership.membershipRole !== "SITE_ADMIN" ||
      !membership.membershipId ||
      !membership.capabilities.readFinance ||
      key !== accessKey(membership) ||
      !Number.isSafeInteger(time) ||
      time < 0 ||
      Date.parse(actor.session.expiresAt) <= time ||
      before.owner !== finalPorts.owner ||
      before.now !== finalPorts.now ||
      scope.siteId !== siteId ||
      scope.access !== access ||
      scope.sessionEpoch !== epoch ||
      accessKey(scope.access) !== key ||
      finalReader !== readSnapshot ||
      readSnapshot.call(owner) !== snapshot
    )
      return null;
    return {
      owner,
      snapshot,
      readSnapshot,
      siteId,
      access,
      accessKey: key,
      epoch,
      time,
    };
  } catch {
    return null;
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>,
    keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.hasOwn(right, key) && equal(left[key], right[key]),
    )
  );
}
function compare(a: NavigationKey, b: NavigationKey) {
  const left = BigInt(a.micros),
    right = BigInt(b.micros);
  return left < right
    ? -1
    : left > right
      ? 1
      : a.kind - b.kind || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function indexKey(purchase: GiftPurchaseHistoryPurchase): NavigationKey {
  return { micros: purchase.purchasedAtMicros, kind: 0, id: purchase.orderId };
}
function blank(status: Status, busy = false): GiftPaymentHistoryState {
  return {
    status,
    busy,
    admissions: 0,
    purchases: [],
    nextIndexCursor: null,
    nextDetailCursor: null,
    indexReadCount: null,
    detail: null,
  };
}
function newHolder(captured: Authority): Holder {
  return {
    authority: captured,
    wireScope: null,
    admissions: 0,
    initialAttempted: false,
    lastTime: captured.time,
    status: "idle",
    selected: null,
    failed: null,
    indexReadCount: null,
    purchases: new Map(),
    quotes: new Map(),
    payments: new Map(),
    paymentOrders: new Map(),
    attempts: new Map(),
    receipts: new Map(),
    credited: new Map(),
    index: navigation(),
    details: new Map(),
    reads: new Map(),
  };
}
class HistorySession {
  holder: Holder | null = null;
  slot: Slot | null = null;
  private listeners = new Set<() => void>();
  private attachments = 0;
  private inspecting = false;
  private notifying = false;
  inspect(scope: HistoryViewerScope, ports: HistoryPorts) {
    if (this.inspecting) return null;
    this.inspecting = true;
    try {
      const current = authority(scope, ports);
      if (
        !current ||
        (this.holder && !sameAuthority(this.holder.authority, current))
      )
        this.discard();
      return current;
    } finally {
      this.inspecting = false;
    }
  }
  discard() {
    const previous = this.holder;
    this.holder = null;
    if (previous) {
      previous.purchases.clear();
      previous.quotes.clear();
      previous.payments.clear();
      previous.paymentOrders.clear();
      previous.attempts.clear();
      previous.receipts.clear();
      previous.credited.clear();
      previous.details.clear();
      previous.reads.clear();
      previous.admissions = 0;
      previous.selected = null;
      previous.failed = null;
      previous.index = navigation();
      previous.wireScope = null;
      previous.indexReadCount = null;
    }
    try {
      this.slot?.abort.abort();
    } catch {}
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit() {
    if (this.notifying) return;
    this.notifying = true;
    try {
      for (const listener of [...this.listeners]) {
        try {
          listener();
        } catch {}
      }
    } finally {
      this.notifying = false;
    }
  }
  attach() {
    this.attachments++;
    return () => {
      this.attachments--;
      // StrictMode reconnects before this microtask; a full unmount releases private facts.
      queueMicrotask(() => {
        if (this.attachments === 0) this.discard();
      });
    };
  }
  whenSettled() {
    return this.slot?.work.then(() => {}) ?? Promise.resolve();
  }
}
export function createGiftPaymentHistorySession() {
  return new HistorySession();
}

async function boundedRequest(
  path: string,
  signal: AbortSignal,
  transport: typeof fetch,
  current: () => boolean,
): Promise<unknown> {
  const fetcher: typeof fetch = async (input, options) => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
      cancellation: Promise<void> | undefined;
    const cancel = () => {
      if (reader && !cancellation) {
        try {
          cancellation = reader.cancel().then(
            () => {},
            () => {},
          );
        } catch {
          cancellation = Promise.resolve();
        }
      }
    };
    const assertCurrent = () => {
      if (signal.aborted || !current())
        throw new Error("History read unavailable");
    };
    signal.addEventListener("abort", cancel);
    try {
      assertCurrent();
      const response = await transport(input, { ...options, signal });
      if (response.body) reader = response.body.getReader();
      assertCurrent();
      if (!reader) throw new Error("History body unavailable");
      const bytes = new Uint8Array(giftPurchaseHistoryLimits.jsonBytes);
      let size = 0;
      while (true) {
        assertCurrent();
        const { done, value } = await reader.read();
        assertCurrent();
        if (done) break;
        if (
          !(value instanceof Uint8Array) ||
          size + value.byteLength > bytes.byteLength
        )
          throw new Error("History body exceeds bound");
        bytes.set(value, size);
        size += value.byteLength;
      }
      assertCurrent();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, size),
      );
      return new Response(text, {
        status: response.status,
        headers: response.headers,
      });
    } finally {
      cancel();
      if (cancellation) await cancellation;
      reader?.releaseLock();
      signal.removeEventListener("abort", cancel);
    }
  };
  return apiRequest(path, {}, fetcher);
}
class HistoryConflict extends Error {}
function conflict() {
  throw new HistoryConflict("History facts conflict");
}
function validateNavigation(
  previous: Navigation,
  keys: NavigationKey[],
  cursor: string | null,
  read: Read,
) {
  const base = read.restart ? navigation() : previous;
  if (cursor !== null && (cursor === read.cursor || base.seen.has(cursor)))
    conflict();
  const direction = read.orderId === null ? -1 : 1;
  for (let i = 0; i < keys.length; i++) {
    const before =
      i === 0 ? (read.cursor === null ? null : base.tail) : keys[i - 1];
    if (before && compare(before, keys[i]) * direction >= 0) conflict();
  }
  const seen = new Set(base.seen);
  if (cursor !== null) seen.add(cursor);
  return { loaded: true, cursor, seen, tail: keys.at(-1) ?? base.tail };
}
function stage(holder: Holder, value: unknown, read: Read) {
  const history =
    read.orderId !== null
      ? giftPurchaseHistoryDetailResponseSchema.parse(value).history
      : giftPurchaseHistoryPageResponseSchema.parse(value).history;
  if (
    history.scope.siteId !== holder.authority.siteId ||
    (holder.wireScope && !equal(history.scope, holder.wireScope))
  )
    conflict();
  const purchases = new Map(holder.purchases),
    quotes = new Map(holder.quotes);
  const payments = new Map(holder.payments),
    paymentOrders = new Map(holder.paymentOrders),
    attempts = new Map(holder.attempts);
  const receipts = new Map(holder.receipts),
    credited = new Map(holder.credited),
    details = new Map(holder.details),
    reads = new Map(holder.reads);
  const originals =
    "items" in history ? history.items : [history.originalPurchase];
  for (const purchase of originals) {
    const previous = purchases.get(purchase.orderId);
    if (
      (previous && !equal(previous, purchase)) ||
      (quotes.has(purchase.quoteId) &&
        quotes.get(purchase.quoteId) !== purchase.orderId)
    )
      conflict();
    purchases.set(purchase.orderId, freeze(purchase));
    quotes.set(purchase.quoteId, purchase.orderId);
  }
  let index = holder.index;
  if ("items" in history)
    index = validateNavigation(
      holder.index,
      history.items.map(indexKey),
      history.nextCursor,
      read,
    );
  else {
    if (
      history.originalPurchase.orderId !== read.orderId ||
      !holder.purchases.has(history.originalPurchase.orderId)
    )
      conflict();
    const keys: NavigationKey[] = [];
    for (const payment of history.retainedPayments) {
      const prior = payments.get(payment.paymentId) ?? [];
      const binding = (sample: GiftPurchaseHistoryPayment) => ({
        paymentId: sample.paymentId,
        attemptId: sample.attemptId,
        orderId: sample.orderId,
        currency: sample.currency,
        createdAtMicros: sample.createdAtMicros,
      });
      if (
        (prior[0] && !equal(binding(prior[0]), binding(payment))) ||
        (paymentOrders.has(payment.paymentId) &&
          paymentOrders.get(payment.paymentId) !== payment.orderId) ||
        (attempts.has(payment.attemptId) &&
          attempts.get(payment.attemptId) !== payment.paymentId)
      )
        conflict();
      paymentOrders.set(payment.paymentId, payment.orderId);
      attempts.set(payment.attemptId, payment.paymentId);
      if (!prior.some((sample) => equal(sample, payment)))
        payments.set(payment.paymentId, [...prior, freeze(payment)]);
      keys.push({
        micros: payment.createdAtMicros,
        kind: 0,
        id: payment.paymentId,
      });
    }
    for (let i = 1; i < keys.length; i++)
      if (compare(keys[i - 1], keys[i]) >= 0) conflict();
    const receiptKeys: NavigationKey[] = [];
    for (const receipt of history.validatedHistoricalReceipts) {
      const prior = receipts.get(receipt.effectId);
      if (
        (prior && !equal(prior, receipt)) ||
        (credited.has(receipt.paymentId) &&
          credited.get(receipt.paymentId) !== receipt.effectId) ||
        (paymentOrders.has(receipt.paymentId) &&
          paymentOrders.get(receipt.paymentId) !== receipt.orderId)
      )
        conflict();
      receipts.set(receipt.effectId, freeze(receipt));
      credited.set(receipt.paymentId, receipt.effectId);
      paymentOrders.set(receipt.paymentId, receipt.orderId);
      receiptKeys.push({
        micros: receipt.postedAtMicros,
        kind: 1,
        id: receipt.effectId,
      });
    }
    for (let i = 1; i < receiptKeys.length; i++)
      if (compare(receiptKeys[i - 1], receiptKeys[i]) >= 0) conflict();
    keys.push(...receiptKeys);
    keys.sort(compare);
    details.set(
      history.originalPurchase.orderId,
      validateNavigation(
        holder.details.get(history.originalPurchase.orderId) ?? navigation(),
        keys,
        history.nextCursor,
        read,
      ),
    );
    reads.set(history.originalPurchase.orderId, freeze(history));
  }
  return {
    wireScope: freeze(history.scope),
    purchases,
    quotes,
    payments,
    paymentOrders,
    attempts,
    receipts,
    credited,
    index,
    details,
    reads,
    indexReadCount:
      "items" in history ? history.items.length : holder.indexReadCount,
  };
}
function project(holder: Holder, busy: boolean): GiftPaymentHistoryState {
  const orderId = holder.selected,
    purchase = orderId ? holder.purchases.get(orderId) : undefined,
    read = orderId ? holder.reads.get(orderId) : undefined;
  return freeze({
    status: holder.status,
    busy,
    admissions: holder.admissions,
    purchases: [...holder.purchases.values()].sort(
      (a, b) => -compare(indexKey(a), indexKey(b)),
    ),
    nextIndexCursor: holder.index.cursor,
    nextDetailCursor: orderId
      ? (holder.details.get(orderId)?.cursor ?? null)
      : null,
    indexReadCount: holder.indexReadCount,
    detail: purchase
      ? {
          purchase,
          samples: [...holder.payments.values()]
            .flat()
            .filter((sample) => sample.orderId === orderId),
          receipts: [...holder.receipts.values()].filter(
            (receipt) => receipt.orderId === orderId,
          ),
          coverage: read?.coverage ?? {
            payments: "UNAVAILABLE",
            receipts: "UNAVAILABLE",
            reversals: "UNAVAILABLE",
            bankSettlement: "UNAVAILABLE",
          },
          currentKnowledge: read?.currentKnowledge ?? "UNAVAILABLE",
          readObservedAtMicros: read?.readObservedAtMicros ?? null,
        }
      : null,
  });
}
export function createGiftPaymentHistoryController(
  scope: HistoryViewerScope,
  onState: (state: GiftPaymentHistoryState) => void,
  ports: HistoryPorts = {},
  session = createGiftPaymentHistorySession(),
) {
  let capturedPorts: PortValues;
  try {
    capturedPorts = portsNow(ports);
  } catch {
    capturedPorts = { owner: undefined, request: undefined, now: undefined };
  }
  const captured = session.inspect(scope, ports);
  if (captured && !session.holder) session.holder = newHolder(captured);
  const holder = session.holder,
    transport = globalThis.fetch,
    token = {};
  let disposed = false;
  function current() {
    if (disposed || !captured || !holder || session.holder !== holder)
      return false;
    const live = session.inspect(scope, ports);
    if (!live || !sameAuthority(captured, live)) return false;
    try {
      const finalReader = captured.owner.getSnapshot;
      const finalPorts = portsNow(ports);
      if (
        !samePorts(capturedPorts, finalPorts) ||
        (!capturedPorts.request && globalThis.fetch !== transport) ||
        live.time < holder.lastTime ||
        scope.siteId !== captured.siteId ||
        scope.access !== captured.access ||
        scope.sessionEpoch !== captured.epoch ||
        accessKey(scope.access) !== captured.accessKey
      )
        return false;
      holder.lastTime = live.time;
      return (
        finalReader === captured.readSnapshot &&
        captured.readSnapshot.call(captured.owner) === captured.snapshot &&
        session.holder === holder &&
        !disposed
      );
    } catch {
      return false;
    }
  }
  function getState(): GiftPaymentHistoryState {
    if (!current())
      return freeze(
        blank(
          authority(scope, ports) ? "unavailable" : "denied",
          !!session.slot,
        ),
      );
    return project(holder as Holder, !!session.slot);
  }
  const notify = () => {
    if (disposed) return;
    const next = getState();
    if (!disposed && (session.holder === holder || session.holder === null))
      onState(next);
  };
  const unsubscribeSession = session.subscribe(notify);
  const unsubscribeOwner = captured?.owner.subscribe(() => {
    if (holder && session.holder === holder) session.inspect(scope, ports);
    session.emit();
  });
  function issue(read: Read): Promise<boolean> {
    if (!current() || !holder || session.slot) return Promise.resolve(false);
    const stream =
      read.orderId === null
        ? holder.index
        : (holder.details.get(read.orderId) ?? navigation());
    if (read.orderId !== null && !holder.purchases.has(read.orderId))
      return Promise.resolve(false);
    if (
      read.cursor !== null &&
      (!stream.loaded || stream.cursor !== read.cursor)
    )
      return Promise.resolve(false);
    if (holder.admissions >= MAX_OWNER_READ_ADMISSIONS) {
      holder.status = "local_limit";
      session.emit();
      return Promise.resolve(false);
    }
    if (
      read.orderId !== null &&
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(read.orderId)
    ) {
      holder.status = "local_code";
      session.emit();
      return Promise.resolve(false);
    }
    let finish!: (value: boolean) => void;
    const work = new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
      abort = new AbortController();
    const slot = { work, abort, token };
    session.slot = slot;
    const started = holder.lastTime;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (current()) {
        holder.status = "unavailable";
        holder.failed = read;
      }
      try {
        abort.abort();
      } catch {}
      session.emit();
    }, HISTORY_FEEDBACK_MS);
    const valid = () =>
      current() &&
      !abort.signal.aborted &&
      !timedOut &&
      session.slot === slot &&
      holder.lastTime - started < HISTORY_FEEDBACK_MS;
    void (async () => {
      let accepted = false;
      try {
        holder.status = "loading";
        session.emit();
        if (!valid()) return;
        holder.admissions++;
        if (read.orderId === null) holder.initialAttempted = true;
        if (read.restart) {
          if (read.orderId === null) holder.index = navigation();
          else holder.details.set(read.orderId, navigation());
        }
        if (read.orderId !== null) holder.selected = read.orderId;
        else if (read.restart) holder.selected = null;
        const path =
          `/v1/sites/${encodeURIComponent(captured?.siteId ?? "")}/finance/purchases` +
          (read.orderId === null
            ? ""
            : `/${encodeURIComponent(read.orderId).replaceAll(".", "%2E")}/history`) +
          (read.cursor === null
            ? ""
            : `?cursor=${encodeURIComponent(read.cursor).replaceAll(".", "%2E")}`);
        const value = capturedPorts.request
          ? await capturedPorts.request(path, { signal: abort.signal })
          : await boundedRequest(path, abort.signal, transport, valid);
        if (!valid()) return;
        const candidate = stage(holder, value, read);
        if (!valid()) return;
        Object.assign(holder, candidate, { status: "ready", failed: null });
        accepted = true;
        session.emit();
        if (!valid()) accepted = false;
      } catch (cause) {
        if (valid()) {
          if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
            const report = captured?.owner.reportFailure;
            if (valid())
              report?.call(captured?.owner, cause, captured?.epoch ?? null);
          }
          if (valid()) {
            holder.status =
              cause instanceof HistoryConflict ? "conflict" : "unavailable";
            holder.failed = read;
          }
        }
      } finally {
        clearTimeout(timer);
        if (session.slot === slot) {
          // Settlement belongs to the retained holder even if its initiating controller was replaced.
          if (session.holder === holder && holder.status === "loading") {
            holder.status = "unavailable";
            holder.failed = read;
          }
          session.slot = null;
        }
        finish(accepted);
        session.emit();
      }
    })();
    return work;
  }
  return {
    getState,
    isBoundTo(next: HistoryViewerScope, nextPorts: HistoryPorts) {
      const live = session.inspect(next, nextPorts);
      if (!live || !captured || !sameAuthority(captured, live)) return false;
      try {
        return samePorts(capturedPorts, portsNow(nextPorts)) && current();
      } catch {
        return false;
      }
    },
    loadFirstIndex() {
      return holder?.initialAttempted
        ? Promise.resolve(false)
        : issue({ orderId: null, cursor: null, restart: false });
    },
    loadMoreIndex(cursor: string) {
      return issue({ orderId: null, cursor, restart: false });
    },
    openPurchase(orderId: string) {
      return issue({ orderId, cursor: null, restart: true });
    },
    loadMoreDetail(orderId: string, cursor: string) {
      return holder?.selected === orderId
        ? issue({ orderId, cursor, restart: false })
        : Promise.resolve(false);
    },
    retryFailedRead() {
      return holder?.failed ? issue(holder.failed) : Promise.resolve(false);
    },
    restartIndex() {
      return issue({ orderId: null, cursor: null, restart: true });
    },
    restartDetail(orderId: string) {
      return holder?.selected === orderId
        ? issue({ orderId, cursor: null, restart: true })
        : Promise.resolve(false);
    },
    closeDetail() {
      if (current() && holder && !session.slot) {
        holder.selected = null;
        session.emit();
      }
    },
    whenSettled: () => session.whenSettled(),
    dispose() {
      disposed = true;
      unsubscribeSession();
      unsubscribeOwner?.();
      if (session.slot?.token === token) {
        try {
          session.slot.abort.abort();
        } catch {}
      }
    },
  };
}
