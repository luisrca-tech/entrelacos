import {
  type GiftItem,
  type GiftMediaPublicAsset,
  type GiftMediaStatus,
  giftItemSchema,
  giftMediaFinalizeResponseSchema,
  giftMediaStatusResponseSchema,
  giftMediaUploadInputSchema,
  giftMediaUploadResponseSchema,
  meResponseSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import { ApiError, apiRequest } from "../lib/apiClient";
import { panelActorOwner } from "./panelActor";

type JsonRequest = (
  path: string,
  options: { method: string; body: unknown; signal: AbortSignal },
) => Promise<unknown>;
type Marker = {
  version: 1;
  siteId: string;
  operatorId: string;
  giftId: string;
  assetId: string;
};
export type GiftMediaClientState = {
  state: GiftMediaStatus["state"] | "IDLE" | "HASHING" | "UPLOADING";
  busy: boolean;
  retained: boolean;
  canRetrySameBytes: boolean;
  media: GiftMediaPublicAsset | null;
  error: string;
};
export type GiftMediaClientPorts = {
  owner?: typeof panelActorOwner;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  request?: JsonRequest;
  transport?: typeof fetch;
  now?: () => number;
  isCurrent?: () => boolean;
  onEligibilityChanged?: () => void;
};
export function createGiftMediaController(
  selected: GiftItem,
  onChange: (state: GiftMediaClientState) => void,
  ports: GiftMediaClientPorts = {},
) {
  const gift = giftItemSchema.parse(selected);
  const owner = ports.owner ?? panelActorOwner;
  const snapshot = owner.getSnapshot();
  const parsed = meResponseSchema.safeParse(snapshot.actor);
  const actor = parsed.success ? parsed.data : null;
  const access =
    actor?.memberships?.filter(
      (value) => value.siteId === gift.siteId && value.userId === actor.user.id,
    ) ?? [];
  const authorized = Boolean(
    snapshot.status === "verified" &&
      snapshot.sessionEpoch !== null &&
      actor &&
      !actor.memberships?.some((value) => value.userId !== actor.user.id) &&
      (actor.user.role === "OWNER" ||
        (access.length === 1 && access[0].capabilities.manageCatalog)),
  );
  const transport = ports.transport ?? fetch;
  const suppliedRequest = ports.request;
  const request: JsonRequest =
    suppliedRequest ??
    ((path, options) =>
      apiRequest(path, options, (url, init) =>
        transport(url, { ...init, signal: options.signal }),
      ));
  const clock = ports.now ?? Date.now;
  const suppliedStorage = ports.storage;
  const base = `/v1/sites/${encodeURIComponent(gift.siteId)}/gift-media`;
  const key = `entrelacos-gift-media-v1:${encodeURIComponent(gift.siteId)}:${encodeURIComponent(actor?.user.id ?? "")}:${encodeURIComponent(gift.id)}`;
  let storage: GiftMediaClientPorts["storage"];
  let marker: Marker | null = null;
  let markerText: string | null = null;
  let blockedStorage = false;
  let active = true;
  let busy = false;
  let attempt = 0;
  let lastClock = -1;
  let leaseExpiresAt: number | null = null;
  let abort: AbortController | null = null;
  let state: GiftMediaClientState = {
    state: "IDLE",
    busy: false,
    retained: false,
    canRetrySameBytes: false,
    media: null,
    error: "",
  };
  function current(revision = attempt): boolean {
    try {
      if (
        !active ||
        !authorized ||
        revision !== attempt ||
        (ports.owner ?? panelActorOwner) !== owner ||
        owner.getSnapshot() !== snapshot ||
        ports.isCurrent?.() === false ||
        ports.request !== suppliedRequest ||
        (ports.transport ?? fetch) !== transport ||
        (ports.now ?? Date.now) !== clock ||
        ports.storage !== suppliedStorage ||
        !actor
      )
        return false;
      const time = clock();
      if (
        !Number.isSafeInteger(time) ||
        time < 0 ||
        time < lastClock ||
        Date.parse(actor.session.expiresAt) <= time
      )
        return false;
      lastClock = time;
      const observed = owner.getSnapshot();
      const scoped = ports.isCurrent?.() !== false;
      const bound =
        ports.request === suppliedRequest &&
        (ports.transport ?? fetch) === transport &&
        (ports.now ?? Date.now) === clock &&
        ports.storage === suppliedStorage &&
        selected.id === gift.id &&
        selected.siteId === gift.siteId &&
        selected.mediaAssetId === gift.mediaAssetId &&
        selected.altText === gift.altText;
      const liveSnapshot = owner.getSnapshot();
      const sameOwner = (ports.owner ?? panelActorOwner) === owner;
      return (
        observed === snapshot &&
        liveSnapshot === snapshot &&
        scoped &&
        bound &&
        sameOwner &&
        active &&
        revision === attempt
      );
    } catch {
      return false;
    }
  }
  function check(revision = attempt, signal?: AbortSignal) {
    if (!current(revision) || signal?.aborted)
      throw new Error("Image operation is no longer current");
  }
  function notify() {
    if (!current()) return;
    try {
      onChange(
        Object.freeze({
          ...state,
          busy,
          retained: Boolean(marker) || blockedStorage,
        }),
      );
    } catch {
      dispose();
    }
    check();
  }
  function dispose() {
    if (!active) return;
    active = false;
    attempt++;
    abort?.abort();
    unsubscribe();
  }
  const unsubscribe = owner.subscribe(() => {
    if (owner.getSnapshot() !== snapshot) dispose();
  });
  function readStored() {
    check();
    if (!storage) throw new Error("Image correlation storage unavailable");
    const read = storage.getItem;
    check();
    const value = read.call(storage, key);
    check();
    return value;
  }
  try {
    check();
    storage = ports.storage ?? globalThis.localStorage;
    check();
    markerText = readStored();
    if (markerText !== null) {
      const value = JSON.parse(markerText);
      if (
        !value ||
        typeof value !== "object" ||
        Object.keys(value).sort().join(",") !==
          "assetId,giftId,operatorId,siteId,version" ||
        value.version !== 1 ||
        value.siteId !== gift.siteId ||
        value.operatorId !== actor?.user.id ||
        value.giftId !== gift.id ||
        !siteIdSchema.safeParse(value.assetId).success
      )
        throw new Error("Invalid retained correlation");
      marker = {
        version: 1,
        siteId: value.siteId,
        operatorId: value.operatorId,
        giftId: value.giftId,
        assetId: value.assetId,
      };
      state = { ...state, state: "UNKNOWN", retained: true };
    }
  } catch {
    blockedStorage = true;
    state = {
      ...state,
      state: "UNKNOWN",
      retained: true,
      error:
        "Não foi possível verificar o envio anterior. Nenhum novo envio foi iniciado.",
    };
  }
  function correlated() {
    if (blockedStorage || readStored() !== markerText)
      throw new Error("Image correlation changed");
  }
  async function run<T>(
    operation: (revision: number, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    check();
    if (busy || blockedStorage) throw new Error("Image operation unavailable");
    busy = true;
    const revision = ++attempt;
    const controller = new AbortController();
    abort = controller;
    const timer = setTimeout(() => controller.abort(), 45_000);
    state = { ...state, error: "" };
    try {
      notify();
      check(revision, controller.signal);
      return await operation(revision, controller.signal);
    } catch (cause) {
      if (current(revision) && cause instanceof ApiError) {
        if (
          [
            "RECEIVING_NOT_READY",
            "SITE_INACTIVE",
            "SITE_EXPIRED",
            "SITE_INELIGIBLE",
            "MEMBERSHIP_DENIED",
          ].includes(cause.code)
        ) {
          const invalidate = ports.onEligibilityChanged;
          check(revision);
          invalidate?.();
        }
        if (current(revision)) {
          const report = owner.reportFailure;
          if (current(revision))
            report.call(owner, cause, snapshot.sessionEpoch);
        }
      }
      if (current(revision)) {
        state = {
          ...state,
          state: marker ? "UNKNOWN" : "IDLE",
          canRetrySameBytes: false,
          media: null,
          error: marker
            ? "O envio ainda não foi confirmado. Consulte ou recupere a imagem antes de tentar novamente."
            : "Não foi possível enviar a imagem. Confira o arquivo e tente novamente.",
        };
      }
      throw new Error("Não foi possível confirmar a imagem.");
    } finally {
      clearTimeout(timer);
      if (abort === controller) abort = null;
      if (revision === attempt) {
        busy = false;
        if (current(revision)) notify();
      }
    }
  }
  async function json(
    path: string,
    body: unknown,
    revision: number,
    signal: AbortSignal,
  ) {
    correlated();
    check(revision, signal);
    const result = await request(path, { method: "POST", body, signal });
    check(revision, signal);
    correlated();
    return result;
  }
  function status(value: unknown) {
    const result = giftMediaStatusResponseSchema.parse(value).status;
    if (
      !marker ||
      result.siteId !== gift.siteId ||
      result.assetId !== marker.assetId
    )
      throw new Error("Unexpected image status scope");
    state = {
      ...state,
      state: result.state,
      canRetrySameBytes: result.canRetrySameBytes,
      media: result.media,
    };
    leaseExpiresAt = Date.parse(result.expiresAt);
    return result;
  }
  async function inspect(recovery: boolean) {
    return run(async (revision, signal) => {
      if (!marker) throw new Error("No retained image");
      const result = status(
        await json(
          `${base}/${encodeURIComponent(marker.assetId)}/finalize`,
          recovery ? { action: "RECOVER" } : {},
          revision,
          signal,
        ),
      );
      check(revision, signal);
      return result.media;
    });
  }
  return {
    current,
    getState: (): GiftMediaClientState =>
      Object.freeze(
        current()
          ? { ...state, busy, retained: Boolean(marker) || blockedStorage }
          : {
              state: "UNKNOWN",
              busy: false,
              retained: Boolean(marker) || blockedStorage,
              canRetrySameBytes: false,
              media: null,
              error: "Verifique sua sessão para editar a imagem.",
            },
      ),
    async start() {
      if (marker) await inspect(false);
    },
    consult: () => inspect(false),
    recover: () => inspect(true),
    upload(file: Blob) {
      if (marker && !state.canRetrySameBytes)
        return Promise.reject(
          new Error("Retained image requires consultation"),
        );
      return run(async (revision, signal) => {
        correlated();
        state = { ...state, state: "HASHING" };
        notify();
        const contentType = giftMediaUploadInputSchema.shape.contentType.parse(
          file.type,
        );
        const byteLength = giftMediaUploadInputSchema.shape.byteLength.parse(
          file.size,
        );
        const read = file.arrayBuffer;
        check(revision, signal);
        const bytes = await read.call(file);
        check(revision, signal);
        if (bytes.byteLength !== byteLength)
          throw new Error("Invalid image bytes");
        const subtle = globalThis.crypto.subtle;
        const digest = subtle.digest;
        check(revision, signal);
        const hashed = await digest.call(subtle, "SHA-256", bytes);
        check(revision, signal);
        const contentSha256 = Array.from(new Uint8Array(hashed), (value) =>
          value.toString(16).padStart(2, "0"),
        ).join("");
        const input = giftMediaUploadInputSchema.parse({
          contentType,
          byteLength,
          contentSha256,
        });
        if (!marker) {
          const { upload } = giftMediaUploadResponseSchema.parse(
            await json(`${base}/uploads`, input, revision, signal),
          );
          if (Date.parse(upload.expiresAt) <= clock())
            throw new Error("Expired image lease");
          leaseExpiresAt = Date.parse(upload.expiresAt);
          check(revision, signal);
          correlated();
          if (!actor || !storage)
            throw new Error("Image correlation unavailable");
          const next: Marker = {
            version: 1,
            siteId: gift.siteId,
            operatorId: actor.user.id,
            giftId: gift.id,
            assetId: upload.id,
          };
          const text = JSON.stringify(next);
          const write = storage.setItem;
          check(revision, signal);
          correlated();
          marker = next;
          markerText = text;
          write.call(storage, key, text);
          check(revision, signal);
          if (readStored() !== text)
            throw new Error("Image correlation acknowledgement lost");
        }
        const retained = marker;
        correlated();
        check(revision, signal);
        state = {
          ...state,
          state: "UPLOADING",
          retained: true,
          canRetrySameBytes: false,
        };
        notify();
        check(revision, signal);
        if (leaseExpiresAt === null || clock() >= leaseExpiresAt)
          throw new Error("Expired image lease");
        correlated();
        check(revision, signal);
        const response = await transport(
          `/api${base}/${encodeURIComponent(retained.assetId)}/finalize`,
          {
            method: "POST",
            body: file,
            headers: { "Content-Type": contentType },
            credentials: "same-origin",
            cache: "no-store",
            signal,
          },
        );
        check(revision, signal);
        correlated();
        const readResponse = response.json;
        check(revision, signal);
        const value = await readResponse.call(response);
        check(revision, signal);
        correlated();
        if (!response.ok) {
          const code =
            value &&
            typeof value === "object" &&
            "code" in value &&
            typeof value.code === "string" &&
            /^[A-Z0-9_]{1,80}$/.test(value.code)
              ? value.code
              : "REQUEST_FAILED";
          throw new ApiError(response.status, code);
        }
        const result = giftMediaFinalizeResponseSchema.parse(value).media;
        if (result.siteId !== gift.siteId || result.id !== retained.assetId)
          throw new Error("Unexpected image scope");
        state = { ...state, state: "FINALIZED", media: result };
        return result;
      });
    },
    confirmCatalog(values: GiftItem[]) {
      try {
        check();
        if (busy || !marker || !storage) return;
        correlated();
        const gifts = giftItemSchema.array().parse(values);
        const found = gifts.filter(
          (value) => value.siteId === gift.siteId && value.id === gift.id,
        );
        if (
          gifts.some((value) => value.siteId !== gift.siteId) ||
          found.length !== 1
        )
          return;
        const attached =
          state.state === "FINALIZED" &&
          state.media?.id === marker.assetId &&
          found[0].mediaAssetId === marker.assetId;
        const closed =
          (state.state === "FAILED" || state.state === "EXPIRED") &&
          found[0].mediaAssetId !== marker.assetId;
        if (!attached && !closed) return;
        const remove = storage.removeItem;
        check();
        correlated();
        remove.call(storage, key);
        check();
        if (readStored() !== null) return;
        marker = null;
        markerText = null;
        state = {
          ...state,
          retained: false,
          canRetrySameBytes: false,
          ...(closed ? { state: "IDLE" as const, media: null } : {}),
        };
        notify();
      } catch {}
    },
    dispose,
  };
}
export type GiftMediaController = ReturnType<typeof createGiftMediaController>;
