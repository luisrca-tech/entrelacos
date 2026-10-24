import {
  type GiftCreateInput,
  type GiftItem,
  type GiftMediaPublicAsset,
  type GiftUpdateInput,
  giftMediaStatusResponseSchema,
  meResponseSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ApiError, apiRequest } from "../lib/apiClient";
import { GiftEditorView } from "./GiftEditorView";
import { GiftImageField } from "./GiftImageField";
import { GiftCatalogClient } from "./giftCatalogClient";
import {
  createGiftMediaController,
  type GiftMediaClientPorts,
  type GiftMediaClientState,
  type GiftMediaController,
} from "./giftMediaClient";
import { panelActorOwner } from "./panelActor";

const unavailableCodes = new Set([
  "RECEIVING_NOT_READY",
  "SITE_INACTIVE",
  "SITE_EXPIRED",
  "SITE_INELIGIBLE",
  "MEMBERSHIP_DENIED",
]);
export type GiftEditorPorts = Omit<GiftMediaClientPorts, "request"> & {
  request?: (
    path: string,
    options?: { method?: string; body?: unknown; signal?: AbortSignal },
  ) => Promise<unknown>;
};
export type GiftEditorState = {
  gifts: GiftItem[];
  loading: boolean;
  error: string;
  busy: boolean;
  activeMediaGift: string | null;
  previews: Record<string, GiftMediaPublicAsset>;
  images: Record<string, GiftMediaClientState>;
};
const emptyState: GiftEditorState = {
  gifts: [],
  loading: true,
  error: "",
  busy: false,
  activeMediaGift: null,
  previews: {},
  images: {},
};
export function createGiftEditorController(
  site: string,
  onChange: (state: GiftEditorState) => void,
  ports: GiftEditorPorts = {},
  onEligibilityChanged: () => void = () => {},
  previousPreviewDrain: Promise<void> = Promise.resolve(),
) {
  const siteId = siteIdSchema.parse(site);
  const owner = ports.owner ?? panelActorOwner;
  const snapshot = owner.getSnapshot();
  const parsed = meResponseSchema.safeParse(snapshot.actor);
  const actor = parsed.success ? parsed.data : null;
  const memberships =
    actor?.memberships?.filter(
      (value) => value.siteId === siteId && value.userId === actor.user.id,
    ) ?? [];
  const authorized = Boolean(
    snapshot.status === "verified" &&
      snapshot.sessionEpoch !== null &&
      actor &&
      !actor.memberships?.some((value) => value.userId !== actor.user.id) &&
      (actor.user.role === "OWNER" ||
        (memberships.length === 1 &&
          memberships[0].capabilities.manageCatalog)),
  );
  const transport = ports.transport ?? fetch;
  const suppliedRequest = ports.request;
  const clock = ports.now ?? Date.now;
  const lifetime = new AbortController();
  const request: NonNullable<GiftEditorPorts["request"]> =
    suppliedRequest ??
    ((path: string, options = {}) =>
      apiRequest(path, options, (url, init) =>
        transport(url, {
          ...init,
          signal: options.signal
            ? AbortSignal.any([lifetime.signal, options.signal])
            : lifetime.signal,
        }),
      ));
  let active = true;
  let lastClock = -1;
  let state: GiftEditorState = { ...emptyState };
  let readRevision = 0;
  let previewTail = previousPreviewDrain;
  let previewAbort: AbortController | null = null;
  const previewProofs = new Map<string, { gift: GiftItem; revision: number }>();
  const images = new Map<
    string,
    { active: boolean; gift: GiftItem; controller: GiftMediaController }
  >();
  function current() {
    try {
      if (
        !active ||
        !authorized ||
        !actor ||
        owner.getSnapshot() !== snapshot ||
        (ports.owner ?? panelActorOwner) !== owner ||
        ports.request !== suppliedRequest ||
        (ports.transport ?? fetch) !== transport ||
        (ports.now ?? Date.now) !== clock ||
        ports.isCurrent?.() === false
      )
        return false;
      const now = clock();
      if (
        !Number.isSafeInteger(now) ||
        now < 0 ||
        now < lastClock ||
        Date.parse(actor.session.expiresAt) <= now
      )
        return false;
      lastClock = now;
      const observed = owner.getSnapshot();
      const scoped = ports.isCurrent?.() !== false;
      const bound =
        ports.request === suppliedRequest &&
        (ports.transport ?? fetch) === transport &&
        (ports.now ?? Date.now) === clock;
      const liveSnapshot = owner.getSnapshot();
      const sameOwner = (ports.owner ?? panelActorOwner) === owner;
      return (
        observed === snapshot &&
        liveSnapshot === snapshot &&
        scoped &&
        bound &&
        sameOwner &&
        active
      );
    } catch {
      return false;
    }
  }
  function check() {
    if (!current()) throw new Error("Catalog scope changed");
  }
  const client = new GiftCatalogClient(siteId, async (path, options) => {
    check();
    const result = await request(path, { ...options, signal: lifetime.signal });
    check();
    return result;
  });
  function notify() {
    const revision = readRevision;
    const projection = getState();
    if (current() && revision === readRevision) {
      try {
        onChange(projection);
      } catch {
        dispose();
      }
    }
  }
  function invalidate(cause: unknown, revision = readRevision) {
    const stillCurrent = () => current() && revision === readRevision;
    if (!stillCurrent() || !(cause instanceof ApiError)) return;
    if (unavailableCodes.has(cause.code)) {
      if (!stillCurrent()) return;
      onEligibilityChanged();
    }
    if (stillCurrent()) {
      const report = owner.reportFailure;
      if (stillCurrent()) report.call(owner, cause, snapshot.sessionEpoch);
    }
  }
  function dispose() {
    if (!active) return;
    active = false;
    readRevision++;
    clearPreviews();
    lifetime.abort();
    for (const entry of images.values()) {
      entry.active = false;
      entry.controller.dispose();
    }
    images.clear();
    unsubscribe();
  }
  const unsubscribe = owner.subscribe(() => {
    if (owner.getSnapshot() !== snapshot) dispose();
  });
  function accept(gifts: GiftItem[]) {
    check();
    for (const [id, entry] of images) {
      const next = gifts.find((gift) => gift.id === id);
      if (
        !next ||
        next.mediaAssetId !== entry.gift.mediaAssetId ||
        next.altText !== entry.gift.altText
      ) {
        entry.active = false;
        entry.controller.dispose();
        images.delete(id);
      }
    }
    state = { ...state, gifts, images: {} };
    for (const gift of gifts) {
      let entry = images.get(gift.id);
      if (!entry) {
        const binding = {
          active: true,
          gift,
          controller: null as unknown as GiftMediaController,
        };
        const controller = createGiftMediaController(
          gift,
          (value) => {
            if (
              current() &&
              binding.active &&
              images.get(gift.id) === binding
            ) {
              state = {
                ...state,
                images: { ...state.images, [gift.id]: value },
              };
              notify();
            }
          },
          {
            ...ports,
            owner,
            request: (path, options) => request(path, options),
            isCurrent: () => current() && binding.active,
            onEligibilityChanged: () => {
              check();
              onEligibilityChanged();
            },
          },
        );
        binding.controller = controller;
        images.set(gift.id, binding);
        entry = binding;
        void controller
          .start()
          .then(async () => {
            if (!current() || !binding.active) return;
            const value = controller.getState();
            if (
              value.retained &&
              ["FINALIZED", "FAILED", "EXPIRED"].includes(value.state)
            ) {
              const fresh = await client.list();
              check();
              if (binding.active) controller.confirmCatalog(fresh);
            }
          })
          .catch(() => {});
      }
      state.images[gift.id] = entry.controller.getState();
    }
  }

  function sameAttachment(left: GiftItem, right: GiftItem) {
    return (
      left.id === right.id &&
      left.siteId === right.siteId &&
      left.mediaAssetId === right.mediaAssetId &&
      left.altText === right.altText &&
      left.publicationState === right.publicationState &&
      left.updatedAt === right.updatedAt
    );
  }
  function clearPreviews() {
    previewAbort?.abort();
    previewProofs.clear();
    state = { ...state, previews: {} };
  }
  function getState(): GiftEditorState {
    const revision = readRevision;
    if (current()) {
      const previews: GiftEditorState["previews"] = {};
      for (const gift of state.gifts) {
        const proof = previewProofs.get(gift.id);
        const media = state.previews[gift.id];
        if (
          proof?.revision === revision &&
          sameAttachment(gift, proof.gift) &&
          media?.id === gift.mediaAssetId &&
          media.siteId === siteId
        )
          previews[gift.id] = media;
      }
      if (current() && revision === readRevision) return { ...state, previews };
    }
    previewAbort?.abort();
    return {
      ...emptyState,
      loading: false,
      error: "Verifique sua sessão para editar os presentes.",
    };
  }
  function savedCurrent(revision: number, gifts: GiftItem[]) {
    return (
      current() &&
      revision === readRevision &&
      !state.loading &&
      !state.busy &&
      gifts.every((gift) => {
        const actual = state.gifts.find((value) => value.id === gift.id);
        return actual !== undefined && sameAttachment(actual, gift);
      }) &&
      revision === readRevision &&
      active
    );
  }
  function previewFailure(cause: unknown, revision: number, gifts: GiftItem[]) {
    if (!savedCurrent(revision, gifts) || !(cause instanceof ApiError))
      return false;
    const denied =
      [401, 403].includes(cause.status) || unavailableCodes.has(cause.code);
    if (!denied || !savedCurrent(revision, gifts)) return false;
    clearPreviews();
    invalidate(cause, revision);
    if (current() && revision === readRevision) notify();
    return true;
  }
  function queueSavedPreviews(gifts: GiftItem[], revision: number) {
    const selected = gifts
      .filter(
        (gift) =>
          gift.mediaAssetId &&
          gift.altText.trim() &&
          !getState().previews[gift.id],
      )
      .map((gift) => Object.freeze({ ...gift }));
    if (!selected.length || !savedCurrent(revision, selected)) return;
    const previous = previewTail;
    previewTail = (async () => {
      await previous;
      if (!savedCurrent(revision, selected)) return;
      async function read(
        path: string,
        options: { method?: string; body?: unknown } = {},
      ) {
        if (!savedCurrent(revision, selected))
          throw new Error("Preview scope changed");
        const child = new AbortController();
        const signal = AbortSignal.any([lifetime.signal, child.signal]);
        previewAbort = child;
        const timer = setTimeout(() => child.abort(), 45_000);
        try {
          if (!savedCurrent(revision, selected) || signal.aborted)
            throw new Error("Preview scope changed");
          const result = await request(path, { ...options, signal });
          if (!savedCurrent(revision, selected) || signal.aborted)
            throw new Error("Preview scope changed");
          return result;
        } finally {
          clearTimeout(timer);
          if (previewAbort === child) previewAbort = null;
        }
      }
      const assets = new Map<string, GiftMediaPublicAsset>();
      for (const assetId of new Set(
        selected.map((gift) => gift.mediaAssetId as string),
      )) {
        if (!savedCurrent(revision, selected)) return;
        try {
          const status = giftMediaStatusResponseSchema.parse(
            await read(
              `/v1/sites/${encodeURIComponent(siteId)}/gift-media/${encodeURIComponent(assetId)}/finalize`,
              { method: "POST", body: {} },
            ),
          ).status;
          if (!savedCurrent(revision, selected)) return;
          if (
            status.state === "FINALIZED" &&
            status.siteId === siteId &&
            status.assetId === assetId &&
            status.media?.id === assetId &&
            status.media.siteId === siteId
          )
            assets.set(assetId, Object.freeze(status.media));
        } catch (cause) {
          if (previewFailure(cause, revision, selected)) return;
        }
      }
      if (!assets.size || !savedCurrent(revision, selected)) return;
      try {
        const fresh = await new GiftCatalogClient(siteId, read).list();
        if (!savedCurrent(revision, selected)) return;
        const previews: GiftEditorState["previews"] = {};
        for (const gift of selected) {
          const actual = fresh.find((value) => value.id === gift.id);
          const media = assets.get(gift.mediaAssetId as string);
          if (actual && media && sameAttachment(actual, gift))
            previews[gift.id] = media;
        }
        if (!savedCurrent(revision, selected)) return;
        for (const gift of selected)
          if (previews[gift.id]) previewProofs.set(gift.id, { gift, revision });
        state = { ...state, previews: { ...state.previews, ...previews } };
        notify();
      } catch (cause) {
        previewFailure(cause, revision, selected);
      }
    })().catch(() => {});
  }

  async function load() {
    if (!current() || state.busy) return;
    const revision = ++readRevision;
    clearPreviews();
    state = { ...state, loading: true, error: "" };
    notify();
    try {
      const gifts = await client.list();
      if (!current() || revision !== readRevision) return;
      accept(gifts);
      state = { ...state, loading: false };
    } catch (cause) {
      if (!current() || revision !== readRevision) return;
      invalidate(cause);
      if (current())
        state = {
          ...state,
          loading: false,
          error: "Não foi possível carregar os presentes. Tente novamente.",
        };
    }
    notify();
    if (current() && revision === readRevision && !state.error)
      queueSavedPreviews(state.gifts, revision);
  }
  async function mutate(action: () => Promise<unknown>) {
    check();
    if (state.busy || state.loading || state.error)
      throw new Error("Catalog operation unavailable");
    state = { ...state, busy: true, error: "" };
    readRevision++;
    clearPreviews();
    notify();
    try {
      check();
      await action();
      check();
      accept(await client.list());
      check();
    } catch (cause) {
      invalidate(cause);
      if (current())
        state = {
          ...state,
          error:
            cause instanceof ApiError && cause.code === "GIFT_REORDER_CONFLICT"
              ? "A lista mudou. Atualize os presentes antes de reorganizar."
              : "Não foi possível salvar. Atualize os presentes antes de tentar novamente.",
        };
      throw new Error("Catalog operation failed");
    } finally {
      if (current()) {
        state = { ...state, busy: false };
        notify();
        if (!state.error) queueSavedPreviews(state.gifts, readRevision);
      }
    }
  }
  async function mediaAction(
    giftId: string,
    alt: string,
    attach: boolean,
    action: (
      controller: GiftMediaController,
    ) => Promise<GiftMediaPublicAsset | null>,
  ) {
    check();
    if (state.busy || state.loading || state.error)
      throw new Error("Catalog operation unavailable");
    const entry = images.get(giftId);
    if (!entry?.active || !entry.controller.current())
      throw new Error("Image scope unavailable");
    if (attach && (!alt.trim() || alt.trim().length > 240))
      throw new Error("Invalid image description");
    state = { ...state, busy: true, activeMediaGift: giftId, error: "" };
    readRevision++;
    clearPreviews();
    notify();
    let descriptionMismatch = false;
    try {
      check();
      const media = await action(entry.controller);
      check();
      if (!entry.active) throw new Error("Image selection changed");
      const before = await client.list();
      check();
      if (!entry.active) throw new Error("Image selection changed");
      const actual = before.find((gift) => gift.id === giftId);
      if (!actual) throw new Error("Gift unavailable");
      if (!attach || !media) {
        entry.controller.confirmCatalog(before);
        accept(before);
        return;
      }
      if (
        actual.mediaAssetId !== media.id &&
        (actual.mediaAssetId !== entry.gift.mediaAssetId ||
          actual.altText !== entry.gift.altText)
      ) {
        accept(before);
        throw new Error("Gift image changed");
      }
      if (actual.mediaAssetId !== media.id || actual.altText !== alt.trim()) {
        check();
        if (!entry.active) throw new Error("Image selection changed");
        try {
          await client.update(giftId, {
            mediaAssetId: media.id,
            altText: alt.trim(),
          });
        } catch (cause) {
          check();
          if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
            invalidate(cause);
            check();
          }
        }
      }
      check();
      const confirmed = await client.list();
      check();
      if (!entry.active) throw new Error("Image selection changed");
      const attached = confirmed.find((gift) => gift.id === giftId);
      if (attached?.mediaAssetId !== media.id) {
        accept(confirmed);
        throw new Error("Image attachment not confirmed");
      }
      entry.controller.confirmCatalog(confirmed);
      check();
      accept(confirmed);
      check();
      previewProofs.set(giftId, {
        gift: Object.freeze({ ...attached }),
        revision: readRevision,
      });
      state = { ...state, previews: { ...state.previews, [giftId]: media } };
      if (attached.altText !== alt.trim()) {
        descriptionMismatch = true;
        state = {
          ...state,
          error:
            "A imagem foi associada, mas a descrição não foi confirmada. Atualize o catálogo antes de salvar a descrição.",
        };
        throw new Error("Image description not confirmed");
      }
    } catch (cause) {
      invalidate(cause);
      throw new Error(
        descriptionMismatch
          ? "A imagem foi associada, mas a descrição não foi confirmada."
          : "Não foi possível confirmar a imagem no catálogo.",
      );
    } finally {
      if (current()) {
        state = { ...state, busy: false, activeMediaGift: null };
        notify();
        if (!state.error) queueSavedPreviews(state.gifts, readRevision);
      }
    }
  }
  return {
    current,
    load,
    dispose,
    getState,
    previewDrain: () => previewTail,
    create: (input: GiftCreateInput) => mutate(() => client.create(input)),
    update: (id: string, input: GiftUpdateInput) =>
      mutate(() => client.update(id, input)),
    publication: (id: string, value: GiftItem["publicationState"]) =>
      mutate(() => client.publication(id, value)),
    reorder: (ids: string[]) => mutate(() => client.reorder(ids)),
    uploadImage: (id: string, file: Blob, alt: string) =>
      mediaAction(id, alt, true, (controller) => controller.upload(file)),
    recoverImage: (id: string, alt: string) =>
      mediaAction(id, alt, true, (controller) => controller.recover()),
    consultImage: (id: string) =>
      mediaAction(id, "", false, (controller) => controller.consult()),
  };
}
type GiftEditorController = ReturnType<typeof createGiftEditorController>;
const defaultPorts: GiftEditorPorts = {};
export function GiftEditor({
  siteId,
  onEligibilityChanged,
  ports = defaultPorts,
}: {
  siteId: string;
  onEligibilityChanged: () => void;
  ports?: GiftEditorPorts;
}) {
  const owner = ports.owner ?? panelActorOwner;
  const snapshot = useSyncExternalStore(
    owner.subscribe,
    owner.getSnapshot,
    owner.getServerSnapshot,
  );
  const scope = useRef({ siteId, snapshot, ports, onEligibilityChanged });
  scope.current = { siteId, snapshot, ports, onEligibilityChanged };
  const holder = useRef<GiftEditorController | null>(null);
  const previewDrain = useRef<Promise<void>>(Promise.resolve());
  const [view, setView] = useState<{
    controller: GiftEditorController;
    state: GiftEditorState;
  } | null>(null);
  useEffect(() => {
    const originalRequest = ports.request;
    const originalTransport = ports.transport ?? fetch;
    const originalClock = ports.now ?? Date.now;
    let controller!: GiftEditorController;
    controller = createGiftEditorController(
      siteId,
      (state) => {
        if (holder.current === controller && controller.current())
          setView({ controller, state });
      },
      {
        ...ports,
        owner,
        isCurrent: () => {
          const scoped = ports.isCurrent?.() !== false;
          const bound =
            ports.request === originalRequest &&
            (ports.transport ?? fetch) === originalTransport &&
            (ports.now ?? Date.now) === originalClock;
          const sameOwner = (ports.owner ?? panelActorOwner) === owner;
          return (
            scoped &&
            bound &&
            sameOwner &&
            holder.current === controller &&
            scope.current.siteId === siteId &&
            scope.current.snapshot === snapshot &&
            scope.current.ports === ports
          );
        },
      },
      () => {
        if (holder.current === controller && controller.current())
          scope.current.onEligibilityChanged();
      },
      previewDrain.current,
    );
    holder.current = controller;
    setView({ controller, state: controller.getState() });
    void controller.load();
    return () => {
      previewDrain.current = controller.previewDrain();
      controller.dispose();
      if (holder.current === controller) holder.current = null;
    };
  }, [siteId, owner, snapshot, ports]);
  const controller = view?.controller;
  if (
    !view ||
    snapshot.status !== "verified" ||
    !controller?.current() ||
    holder.current !== controller
  )
    return <p role="status">Verifique sua sessão para editar os presentes.</p>;
  const state = controller.getState();
  return (
    <GiftEditorView
      gifts={state.gifts}
      loading={state.loading}
      error={state.error || null}
      busy={state.busy}
      onRetry={() => {
        void controller.load();
      }}
      onCreate={controller.create}
      onUpdate={controller.update}
      onPublication={controller.publication}
      onReorder={controller.reorder}
      renderPreview={(gift) => {
        const preview = state.previews[gift.id];
        return preview ? (
          <img
            src={preview.url}
            alt={gift.altText}
            className="h-full w-full object-cover"
          />
        ) : null;
      }}
      renderMedia={(gift, blocked) => (
        <GiftImageField
          key={JSON.stringify([
            siteId,
            snapshot.sessionEpoch,
            gift.id,
            gift.mediaAssetId,
            gift.altText,
          ])}
          gift={gift}
          disabled={blocked && state.activeMediaGift !== gift.id}
          preview={state.previews[gift.id]}
          mediaState={state.images[gift.id]}
          isCurrent={() =>
            holder.current === controller && controller.current()
          }
          onUpload={(file, alt) => controller.uploadImage(gift.id, file, alt)}
          onConsult={() => controller.consultImage(gift.id)}
          onRecover={(alt) => controller.recoverImage(gift.id, alt)}
          onRemove={() =>
            controller.update(gift.id, { mediaAssetId: null, altText: "" })
          }
          onAltChange={(altText) => controller.update(gift.id, { altText })}
        />
      )}
    />
  );
}
