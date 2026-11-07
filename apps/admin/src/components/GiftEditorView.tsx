import type {
  GiftCreateInput,
  GiftItem,
  GiftUpdateInput,
} from "@entrelacos/contracts";
import {
  giftCentsSchema,
  giftImageAlt,
  giftMinimumNominalCents,
} from "@entrelacos/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Textarea,
  toast,
} from "@entrelacos/ui";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  Gift,
  ImageIcon,
  Plus,
  Search,
  Upload,
} from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useEffect, useId, useState } from "react";
import { adminStyles, displayHeading } from "../lib/adminStyles";
import { AdminAlertDialogContent, AdminDialogContent } from "./AdminDialog";
import {
  type GiftPricingEstimate,
  GiftPricingPreview,
  giftFeeExplanation,
  useGiftPricingPreview,
} from "./GiftPricingSettings";
import { OverflowMenu } from "./OverflowMenu";
import {
  type PendingGiftPhoto,
  PendingGiftPhotoField,
} from "./PendingGiftPhotoField";

export type GiftEditorViewProps = {
  gifts: GiftItem[];
  loading?: boolean;
  error?: string | null;
  busy?: boolean;
  onRetry: () => void;
  /** Resolves with the created gift so a kept photo can be attached to it. */
  onCreate: (input: GiftCreateInput) => Promise<GiftItem | void>;
  /** Uploads and attaches a photo to an existing gift. */
  onUploadPhoto?: (giftId: string, file: File, alt: string) => Promise<void>;
  onUpdate: (giftId: string, input: GiftUpdateInput) => Promise<void>;
  onPublication: (
    giftId: string,
    state: GiftItem["publicationState"],
  ) => Promise<void>;
  onReorder: (giftIds: string[]) => Promise<void>;
  // `position` is the gift's 1-based place in the catalog list being shown.
  renderMedia?: (
    gift: GiftItem,
    blocked: boolean,
    position: number,
  ) => ReactNode;
  renderPreview?: (gift: GiftItem, position: number) => ReactNode;
};

const noPendingPhoto: PendingGiftPhoto = { file: null, alt: "" };
const photoUploadFailure =
  "O presente foi salvo, mas a foto não foi enviada. Tente enviar de novo.";

/** A browser URL for a local file, revoked when the file changes or unmounts. */
function useObjectUrl(file: File | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file || typeof URL.createObjectURL !== "function") {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url;
}

type GiftMutationState = Pick<
  GiftEditorViewProps,
  "busy" | "loading" | "error"
>;

export function isGiftMutationBlocked({
  busy,
  loading,
  error,
}: GiftMutationState): boolean {
  return Boolean(busy || loading || error);
}

export function runGiftMutationWhenReady<T>(
  state: GiftMutationState,
  mutation: () => T,
): T | undefined {
  return isGiftMutationBlocked(state) ? undefined : mutation();
}

export function parseGiftPriceToCents(value: string): number | null {
  const normalized = value.trim();
  if (normalized.length > 20) return null;
  const match = normalized.match(/^(\d+)(?:[.,](\d{1,2}))?$/);
  if (!match) return null;

  const cents =
    BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (
    cents < BigInt(giftMinimumNominalCents) ||
    cents > BigInt(Number.MAX_SAFE_INTEGER)
  )
    return null;
  const parsed = Number(cents);
  return giftCentsSchema.safeParse(parsed).success ? parsed : null;
}

export function getReorderedGiftIds(
  gifts: GiftItem[],
  giftId: string,
  direction: "up" | "down",
): string[] | null {
  const active = gifts
    .filter((gift) => gift.publicationState !== "ARCHIVED")
    .sort((left, right) => left.sortOrder - right.sortOrder);
  const index = active.findIndex((gift) => gift.id === giftId);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= active.length) return null;

  [active[index], active[target]] = [active[target], active[index]];
  return active.map((gift) => gift.id);
}

export type GiftFilter = "ACTIVE" | GiftItem["publicationState"];

export function getVisibleGifts(
  gifts: GiftItem[],
  query: string,
  filter: GiftFilter,
): GiftItem[] {
  const normalize = (value: string) =>
    value
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLocaleLowerCase("pt-BR");
  const search = normalize(query.trim());
  return gifts
    .filter(
      (gift) =>
        (filter === "ACTIVE"
          ? gift.publicationState !== "ARCHIVED"
          : gift.publicationState === filter) &&
        normalize(`${gift.title} ${gift.description}`).includes(search),
    )
    .sort((left, right) => left.sortOrder - right.sortOrder);
}

function editablePrice(cents: number): string {
  return `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, "0")}`;
}

function formatPrice(cents: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(cents / 100);
}

function statusLabel(state: GiftItem["publicationState"]): string {
  if (state === "PUBLISHED") return "Publicado";
  if (state === "ARCHIVED") return "Arquivado";
  return "Rascunho";
}

const photoTones = [
  "bg-admin-subtle",
  "bg-admin-subtle-hover",
  "bg-admin-accent-subtle",
];

function GiftStatusBadge({ state }: { state: GiftItem["publicationState"] }) {
  return (
    <span
      className={`inline-flex w-fit items-center rounded-full px-2.5 py-1 text-xs leading-none font-bold ${state === "PUBLISHED" ? "bg-admin-success-subtle text-admin-success-text" : state === "ARCHIVED" ? "bg-admin-danger-subtle text-admin-danger-text" : "bg-admin-subtle text-admin-text"}`}
    >
      {statusLabel(state)}
    </span>
  );
}

// Publishing needs a photo (saved, or kept for a gift being created), a name
// and a valid value. The photo description is optional: renderers fall back to
// the gift's position in the list.
export function giftPublishChecklist(
  hasPhoto: boolean,
  title: string,
  nominalCents: number | null,
) {
  const items = [
    {
      id: "photo",
      label: "Foto",
      done: hasPhoto,
    },
    {
      id: "title",
      label: "Nome do presente",
      done: Boolean(title.trim()) && title.trim().length <= 120,
    },
    { id: "price", label: "Valor", done: nominalCents !== null },
  ] as const;
  return { items, done: items.filter((item) => item.done).length };
}

function FormSectionHeader({
  number,
  title,
  badge,
}: {
  number: number;
  title: string;
  badge?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="m-0 flex items-center gap-3 text-lg font-bold text-admin-text">
        <span
          aria-hidden="true"
          className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-admin-accent text-sm font-bold text-admin-on-accent"
        >
          {number}
        </span>
        <span className="sr-only">Parte {number}: </span>
        {title}
      </h2>
      {badge}
    </div>
  );
}

const sectionCard =
  "grid min-w-0 gap-5 rounded-2xl border border-admin-border bg-admin-surface p-6 [@media(max-width:760px)]:p-4";
const fieldClass =
  "min-h-[46px] rounded-[10px] border-admin-border-strong bg-admin-surface px-3.5 text-[0.95rem]";

function Counter({ value, max }: { value: number; max: number }) {
  return (
    <span
      aria-hidden="true"
      className={`text-xs ${value > max ? "font-bold text-admin-danger-text" : "text-admin-text-secondary"}`}
    >
      {value}/{max}
    </span>
  );
}

function GuestPreviewCard({
  gift,
  title,
  description,
  estimate,
  photo,
}: {
  gift?: GiftItem;
  title: string;
  description: string;
  estimate: GiftPricingEstimate | null;
  photo: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-admin-border bg-admin-surface">
      <div className="flex aspect-[300/224] items-center justify-center overflow-hidden border-b border-dashed border-admin-border-strong bg-admin-canvas text-[0.82rem] text-admin-text-secondary [&_img]:h-full [&_img]:w-full [&_img]:object-cover">
        {photo ??
          (gift?.mediaAssetId ? (
            <Gift aria-hidden="true" className="size-10 text-admin-accent/60" />
          ) : (
            "A foto aparece aqui"
          ))}
      </div>
      <div className="grid gap-2 p-[18px]">
        <h3 className="m-0 break-words font-admin-display text-[1.35rem] font-normal text-admin-text">
          {title.trim() || "Nome do presente"}
        </h3>
        <p className="m-0 line-clamp-3 break-words text-sm leading-[1.5] text-admin-text">
          {description.trim() ||
            "Um presente simbólico para celebrar essa nova fase."}
        </p>
        <GuestPreviewPrice estimate={estimate} />
        <span
          aria-hidden="true"
          className="flex min-h-11 items-center justify-center rounded-[10px] bg-admin-accent text-[0.95rem] font-bold text-admin-on-accent"
        >
          Presentear
        </span>
      </div>
    </div>
  );
}

function PublishChecklist({
  checklist,
  published,
}: {
  checklist: ReturnType<typeof giftPublishChecklist>;
  published: boolean;
}) {
  return (
    <section className="grid gap-3 rounded-2xl border border-admin-border bg-admin-surface p-5">
      <h2 className="m-0 text-base font-bold text-admin-text">
        Pronto para publicar? {checklist.done}/3
      </h2>
      <ul className="m-0 grid list-none gap-2.5 p-0">
        {checklist.items.map((item) => (
          <li
            key={item.id}
            className="flex items-center gap-2.5 text-[0.95rem] text-admin-text"
          >
            <span
              aria-hidden="true"
              className={`flex size-[22px] shrink-0 items-center justify-center rounded-full ${item.done ? "bg-admin-success text-admin-on-accent" : "border-2 border-admin-border-strong"}`}
            >
              {item.done && <Check className="size-3.5" />}
            </span>
            {item.label}
            <span className="sr-only">
              {item.done ? " (pronto)" : " (pendente)"}
            </span>
          </li>
        ))}
      </ul>
      <p className="m-0 text-[0.82rem] leading-[1.5] text-admin-text-secondary">
        {published
          ? "Este presente está visível para os convidados. Alterações salvas aparecem na lista publicada."
          : "Enquanto não publicar, o presente fica como rascunho e só vocês veem."}
      </p>
    </section>
  );
}

function GuestPreviewPrice({
  estimate,
}: {
  estimate: GiftPricingEstimate | null;
}) {
  const startingAtCents = estimate?.startingAtCents;
  if (startingAtCents == null)
    return (
      <p className="m-0 text-sm text-admin-text-secondary">
        Preço indisponível.
      </p>
    );
  return (
    <p className="m-0 text-lg font-bold text-admin-text">
      A partir de {formatPrice(startingAtCents)}
      <span className="block text-sm font-normal text-admin-text-secondary">
        Taxas incluídas no valor
      </span>
    </p>
  );
}

export function GiftEditorView({
  gifts,
  loading = false,
  error = null,
  busy = false,
  onRetry,
  onCreate,
  onUploadPhoto,
  onUpdate,
  onPublication,
  onReorder,
  renderMedia,
  renderPreview,
}: GiftEditorViewProps) {
  const idPrefix = useId();
  const [editor, setEditor] = useState<
    { kind: "create" } | { kind: "edit"; giftId: string } | null
  >(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<GiftFilter>("ACTIVE");
  const [formError, setFormError] = useState<string | null>(null);
  const [archive, setArchive] = useState<GiftItem | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [draftPreviewOpen, setDraftPreviewOpen] = useState(false);
  const [awaitingCreated, setAwaitingCreated] = useState<Set<string> | null>(
    null,
  );
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  // A photo chosen before its gift exists stays in the browser until the gift
  // is created. `photoOwner` is the created gift that still owes that upload,
  // so a failed upload is retried without creating the gift again.
  const [pendingPhoto, setPendingPhoto] =
    useState<PendingGiftPhoto>(noPendingPhoto);
  const [photoOwner, setPhotoOwner] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const previewGift = gifts.find((gift) => gift.id === previewId);
  const mutationState = { busy, loading, error };
  const mutationBlocked = isGiftMutationBlocked(mutationState) || saving;
  const selected =
    editor?.kind === "edit"
      ? gifts.find(
          (gift) =>
            gift.id === editor.giftId && gift.publicationState !== "ARCHIVED",
        )
      : undefined;
  const creating = editor?.kind === "create";
  const editing = creating || Boolean(selected);
  const activeGifts = getVisibleGifts(gifts, "", "ACTIVE");
  const visibleGifts = getVisibleGifts(gifts, query, filter);
  // Single-gift views (editor, preview) reuse the position the gift's card has
  // in the visible list, or its place in the full catalog order when hidden.
  const positionOf = (target: GiftItem) => {
    const shown = visibleGifts.findIndex((gift) => gift.id === target.id);
    if (shown >= 0) return shown + 1;
    const ordered = [...gifts].sort(
      (left, right) => left.sortOrder - right.sortOrder,
    );
    return (
      Math.max(
        ordered.findIndex((gift) => gift.id === target.id),
        0,
      ) + 1
    );
  };
  const published = gifts.filter(
    (gift) => gift.publicationState === "PUBLISHED",
  ).length;
  const drafts = gifts.filter(
    (gift) => gift.publicationState === "DRAFT",
  ).length;
  const nominalCents = parseGiftPriceToCents(price);
  const estimate = useGiftPricingPreview(
    previewGift?.nominalCents ?? (editing ? nominalCents : null),
  );
  // Once the kept photo is removed from a created gift, its regular photo
  // field (with consult and recovery) takes over again.
  const pendingActive =
    creating ||
    (selected !== undefined &&
      photoOwner === selected.id &&
      pendingPhoto.file !== null);
  const hasPendingPhoto = pendingActive && pendingPhoto.file !== null;
  const checklist = giftPublishChecklist(
    Boolean(selected?.mediaAssetId) || hasPendingPhoto,
    title,
    nominalCents,
  );
  const pendingUrl = useObjectUrl(hasPendingPhoto ? pendingPhoto.file : null);

  // A new draft opens straight in the editor so the photo can be added next.
  useEffect(() => {
    if (!awaitingCreated) return;
    const created = gifts.find(
      (gift) =>
        !awaitingCreated.has(gift.id) && gift.publicationState === "DRAFT",
    );
    if (!created) return;
    setAwaitingCreated(null);
    setEditor({ kind: "edit", giftId: created.id });
  }, [gifts, awaitingCreated]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Text drafts reset only when another gift (or a new one) opens.
  useEffect(() => {
    setTitle(selected?.title ?? "");
    setDescription(selected?.description ?? "");
  }, [editor, selected?.id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The price draft also resets when the saved price changes.
  useEffect(() => {
    setPrice(
      selected?.nominalCents === undefined
        ? ""
        : editablePrice(selected.nominalCents),
    );
  }, [editor, selected?.id, selected?.nominalCents]);

  function openEditor(value: typeof editor) {
    setFormError(null);
    setPendingPhoto(noPendingPhoto);
    setPhotoOwner(null);
    setPhotoError("");
    setEditor(value);
  }

  // Uploads the kept photo to a saved gift; reports whether it is attached.
  async function uploadPendingPhoto(giftId: string): Promise<boolean> {
    const { file, alt } = pendingPhoto;
    if (!file) return true;
    setPhotoOwner(giftId);
    setPhotoError("");
    setUploadingPhoto(true);
    try {
      if (!onUploadPhoto) throw new Error("Photo upload unavailable");
      await onUploadPhoto(giftId, file, alt.trim());
      setPendingPhoto(noPendingPhoto);
      setPhotoOwner(null);
      return true;
    } catch {
      setPhotoError(photoUploadFailure);
      toast.error(photoUploadFailure);
      return false;
    } finally {
      setUploadingPhoto(false);
    }
  }

  async function retryPendingPhoto() {
    if (!photoOwner || mutationBlocked) return;
    setSaving(true);
    try {
      if (await uploadPendingPhoto(photoOwner)) toast.success("Foto enviada.");
    } finally {
      setSaving(false);
    }
  }

  async function saveGift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutationBlocked) return;
    const submitter = (event.nativeEvent as SubmitEvent).submitter as
      | HTMLButtonElement
      | null
      | undefined;
    const publish = submitter?.value === "publish";
    const data = new FormData(event.currentTarget);
    const nextTitle = String(data.get("title") ?? "").trim();
    const nextDescription = String(data.get("description") ?? "").trim();
    const cents = parseGiftPriceToCents(String(data.get("nominalPrice") ?? ""));
    if (cents === null) {
      setFormError(
        `Informe um valor válido de pelo menos ${formatPrice(giftMinimumNominalCents)}.`,
      );
      return;
    }
    if (!nextTitle || nextTitle.length > 120 || nextDescription.length > 2000) {
      setFormError("Confira o nome e a mensagem do presente.");
      return;
    }
    setFormError(null);
    setSaving(true);
    try {
      if (selected) {
        await onUpdate(selected.id, {
          title: nextTitle,
          description: nextDescription,
          nominalCents: cents,
        });
        const owesPhoto = hasPendingPhoto && photoOwner === selected.id;
        if (owesPhoto && !(await uploadPendingPhoto(selected.id))) return;
        if (
          publish &&
          selected.publicationState === "DRAFT" &&
          giftPublishChecklist(
            Boolean(selected.mediaAssetId) || owesPhoto,
            nextTitle,
            cents,
          ).done === 3
        ) {
          await onPublication(selected.id, "PUBLISHED");
          toast.success("Presente salvo e publicado.");
          openEditor(null);
        } else toast.success("Alterações salvas.");
      } else if (creating) {
        const known = new Set(gifts.map((gift) => gift.id));
        const created = await onCreate({
          title: nextTitle,
          description: nextDescription,
          nominalCents: cents,
          currency: "BRL",
          mediaAssetId: null,
          altText: "",
        });
        if (created && pendingPhoto.file) {
          // Keep editing the created gift: a failed upload is retried there.
          setEditor({ kind: "edit", giftId: created.id });
          if (!(await uploadPendingPhoto(created.id))) return;
          if (publish) {
            await onPublication(created.id, "PUBLISHED");
            toast.success("Presente salvo e publicado.");
            openEditor(null);
          } else toast.success("Presente salvo como rascunho.");
          return;
        }
        openEditor(null);
        setFilter("ACTIVE");
        setQuery("");
        setAwaitingCreated(known);
        toast.success(
          "Presente salvo como rascunho. Agora adicione a foto e publique quando estiver pronto.",
        );
      }
    } catch {
      toast.error("Não foi possível salvar o presente. Tente novamente.");
    } finally {
      setSaving(false);
    }
  }

  async function runAction(action: () => Promise<void>, message: string) {
    const readyAction = runGiftMutationWhenReady(mutationState, action);
    if (!readyAction) return;
    try {
      await readyAction;
      toast.success(message);
    } catch {
      toast.error("Não foi possível atualizar o catálogo. Tente novamente.");
    }
  }

  function moveGift(gift: GiftItem, direction: "up" | "down") {
    const ids = getReorderedGiftIds(gifts, gift.id, direction);
    if (mutationBlocked || ids === null) return;
    void runAction(() => onReorder(ids), "Ordem dos presentes atualizada.");
  }

  const formId = `${idPrefix}-form`;
  const canPublishNow =
    (creating || selected?.publicationState === "DRAFT") &&
    checklist.done === 3;
  const photoPosition = selected
    ? positionOf(selected)
    : activeGifts.length + 1;
  const photo =
    hasPendingPhoto && pendingUrl ? (
      <img
        src={pendingUrl}
        alt={giftImageAlt(pendingPhoto.alt, photoPosition)}
        className="h-full w-full object-cover"
      />
    ) : selected ? (
      renderPreview?.(selected, photoPosition)
    ) : null;

  return (
    <section
      className="min-w-0 space-y-6"
      aria-labelledby="gift-catalog-heading"
    >
      {editing ? (
        <header className="grid gap-2">
          <button
            type="button"
            disabled={busy || saving}
            onClick={() => openEditor(null)}
            className="inline-flex min-h-8 w-fit items-center gap-1 bg-transparent p-0 text-[0.95rem] font-semibold text-admin-accent-hover hover:underline disabled:opacity-60"
          >
            <ChevronLeft aria-hidden="true" className="size-4" />
            Lista de presentes
          </button>
          <h1
            id="gift-catalog-heading"
            className={`m-0 text-[clamp(1.85rem,3vw,2.25rem)] text-admin-text ${displayHeading}`}
          >
            {creating ? "Novo presente" : "Editar presente"}
          </h1>
          <p className="m-0 text-base leading-[1.6] text-admin-text-secondary [@media(max-width:760px)]:hidden">
            Preencha as três partes. A prévia ao lado mostra como os convidados
            vão ver.
          </p>
        </header>
      ) : (
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="grid max-w-[600px] gap-2">
            <h1
              id="gift-catalog-heading"
              className={`m-0 text-[clamp(1.85rem,3vw,2.25rem)] text-admin-text ${displayHeading}`}
            >
              Lista de presentes
            </h1>
            <p className="m-0 text-base leading-[1.6] text-admin-text-secondary">
              Cada presente é uma contribuição simbólica em dinheiro para vocês,
              sem produto ou entrega.
            </p>
          </div>
          <Button
            type="button"
            className="min-h-12 rounded-[10px] px-6 text-[0.95rem] font-bold bg-admin-accent text-admin-on-accent hover:bg-admin-accent-hover [@media(max-width:760px)]:w-full"
            disabled={mutationBlocked}
            onClick={() => openEditor({ kind: "create" })}
          >
            <Plus aria-hidden="true" />
            Adicionar presente
          </Button>
        </header>
      )}

      {loading && (
        <p className={adminStyles.notice} role="status">
          Carregando catálogo…
        </p>
      )}
      {error && (
        <div className={adminStyles.alert} role="alert">
          <p>{error}</p>
          <Button
            type="button"
            variant="outline"
            className="mt-3"
            disabled={busy || loading}
            onClick={onRetry}
          >
            Tentar novamente
          </Button>
        </div>
      )}

      {editing ? (
        <>
          <article className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
            <div className="grid min-w-0 gap-5">
              <section className={sectionCard} aria-label="Foto do presente">
                <FormSectionHeader
                  number={1}
                  title="Foto do presente"
                  badge={
                    <span className="inline-flex items-center rounded-full bg-admin-subtle px-2.5 py-1 text-xs leading-none font-bold text-admin-text [@media(max-width:760px)]:hidden">
                      Necessária para publicar
                    </span>
                  }
                />
                {pendingActive ? (
                  <PendingGiftPhotoField
                    value={pendingPhoto}
                    position={photoPosition}
                    disabled={mutationBlocked}
                    uploading={uploadingPhoto}
                    error={photoError}
                    onChange={(next) => {
                      setPhotoError("");
                      setPendingPhoto(next);
                    }}
                    onRetry={
                      photoOwner ? () => void retryPendingPhoto() : undefined
                    }
                  />
                ) : selected && renderMedia ? (
                  renderMedia(selected, mutationBlocked, positionOf(selected))
                ) : (
                  <div className="flex min-h-[272px] flex-col items-center justify-center gap-2.5 rounded-[14px] border-2 border-dashed border-admin-border-strong bg-admin-canvas px-5 py-8 text-center [@media(max-width:760px)]:min-h-[230px]">
                    <span
                      aria-hidden="true"
                      className="flex size-14 items-center justify-center rounded-full bg-admin-accent-subtle text-admin-accent-hover"
                    >
                      <Upload className="size-[26px]" />
                    </span>
                    <span className="text-base font-bold text-admin-text">
                      A foto deste presente é gerenciada aqui
                    </span>
                    <span className="max-w-md text-[0.82rem] leading-[1.5] text-admin-text-secondary">
                      JPEG, PNG ou WebP · até 5 MB.
                    </span>
                  </div>
                )}
              </section>
              <form
                id={formId}
                key={selected?.id ?? "new"}
                className="grid min-w-0 gap-5"
                onSubmit={(event) => void saveGift(event)}
              >
                <section className={sectionCard} aria-label="Sobre o presente">
                  <FormSectionHeader number={2} title="Sobre o presente" />
                  <div className="grid gap-1.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <label
                        htmlFor={`${idPrefix}-title`}
                        className="text-sm font-bold text-admin-text"
                      >
                        Nome do presente{" "}
                        <span className="text-xs font-semibold text-admin-text-secondary">
                          · Obrigatório
                        </span>
                      </label>
                      <Counter value={title.length} max={120} />
                    </div>
                    <Input
                      id={`${idPrefix}-title`}
                      name="title"
                      required
                      maxLength={120}
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      placeholder="Ex.: Jantar da lua de mel"
                      disabled={mutationBlocked}
                      aria-describedby={`${idPrefix}-title-hint`}
                      className={fieldClass}
                    />
                    <p
                      id={`${idPrefix}-title-hint`}
                      className="m-0 text-[0.8rem] text-admin-text-secondary"
                    >
                      Curto e fácil de reconhecer na lista.
                    </p>
                  </div>
                  <div className="grid gap-1.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <label
                        htmlFor={`${idPrefix}-description`}
                        className="text-sm font-bold text-admin-text"
                      >
                        Mensagem
                        <span className="[@media(max-width:760px)]:hidden">
                          {" "}
                          para os convidados
                        </span>{" "}
                        <span className="text-xs font-semibold text-admin-text-secondary">
                          · Opcional
                        </span>
                      </label>
                      <Counter value={description.length} max={2000} />
                    </div>
                    <Textarea
                      id={`${idPrefix}-description`}
                      name="description"
                      maxLength={2000}
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      placeholder="Conte o que esse presente representa para vocês."
                      disabled={mutationBlocked}
                      rows={3}
                      className="min-h-24 rounded-[10px] border-admin-border-strong bg-admin-surface px-3.5 py-3 text-[0.95rem]"
                    />
                  </div>
                </section>
                <section className={sectionCard} aria-label="Valor">
                  <FormSectionHeader number={3} title="Valor" />
                  <div className="grid gap-1.5">
                    <label
                      htmlFor={`${idPrefix}-price`}
                      className="text-sm font-bold text-admin-text"
                    >
                      Quanto vocês querem receber{" "}
                      <span className="text-xs font-semibold text-admin-text-secondary">
                        · Obrigatório
                      </span>
                    </label>
                    <div className="flex min-h-[52px] w-full max-w-[320px] overflow-hidden rounded-[10px] border border-admin-border-strong bg-admin-surface focus-within:border-admin-accent focus-within:outline-[3px] focus-within:outline-offset-2 focus-within:outline-admin-accent/20 [@media(max-width:760px)]:max-w-none">
                      <span
                        aria-hidden="true"
                        className="flex items-center border-r border-admin-border-strong bg-admin-subtle px-3.5 text-[0.95rem] font-bold text-admin-text"
                      >
                        R$
                      </span>
                      <input
                        id={`${idPrefix}-price`}
                        name="nominalPrice"
                        aria-describedby={`${idPrefix}-price-minimum`}
                        aria-invalid={
                          formError !== null && nominalCents === null
                        }
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        maxLength={20}
                        placeholder="0,00"
                        required
                        disabled={mutationBlocked}
                        value={price}
                        onChange={(event) => setPrice(event.target.value)}
                        className="min-w-0 flex-1 bg-transparent px-3.5 text-xl text-admin-text outline-none placeholder:text-admin-text-secondary disabled:opacity-60"
                      />
                    </div>
                    <p
                      id={`${idPrefix}-price-minimum`}
                      className="m-0 text-[0.82rem] text-admin-text"
                    >
                      Valor mínimo de {formatPrice(giftMinimumNominalCents)}.
                    </p>
                  </div>
                  <GiftPricingPreview
                    nominalCents={nominalCents}
                    estimate={estimate}
                  />
                </section>
                {formError && (
                  <p className={adminStyles.alert} role="alert">
                    {formError}
                  </p>
                )}
              </form>
              <section
                aria-label="Resumo do presente"
                className="flex items-center gap-3 rounded-2xl border border-admin-border bg-admin-surface p-4 [@media(min-width:761px)]:hidden"
              >
                <span className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-[10px] border-2 border-dashed border-admin-border-strong bg-admin-canvas [&_img]:h-full [&_img]:w-full [&_img]:object-cover">
                  {photo}
                </span>
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <strong className="truncate text-[0.95rem] text-admin-text">
                    {title.trim() || "Novo presente"}
                  </strong>
                  <span className="text-xs text-admin-text-secondary">
                    {checklist.items.find((item) => !item.done)?.id === "photo"
                      ? "Falta a foto para publicar"
                      : checklist.done === 3
                        ? "Pronto para publicar"
                        : "Faltam itens para publicar"}{" "}
                    · {checklist.done}/3
                  </span>
                </span>
                <button
                  type="button"
                  className="min-h-11 shrink-0 bg-transparent px-1 text-sm font-semibold text-admin-accent-hover underline underline-offset-4"
                  onClick={() => setDraftPreviewOpen(true)}
                >
                  Prévia
                </button>
              </section>
            </div>
            <aside className="grid min-w-0 gap-5 [@media(max-width:760px)]:hidden">
              <div className="grid gap-2.5">
                <p className="m-0 text-xs font-bold uppercase tracking-[0.08em] text-admin-text-secondary">
                  Como os convidados vão ver
                </p>
                <GuestPreviewCard
                  gift={selected}
                  title={title}
                  description={description}
                  estimate={estimate}
                  photo={photo}
                />
              </div>
              <PublishChecklist
                checklist={checklist}
                published={selected?.publicationState === "PUBLISHED"}
              />
              {selected && (
                <Button
                  type="button"
                  variant="ghost"
                  className="w-fit text-admin-danger-text"
                  disabled={mutationBlocked}
                  onClick={() => setArchive(selected)}
                >
                  Arquivar presente
                </Button>
              )}
            </aside>
          </article>
          {/* The bar is the last block of the page, so its negative bottom
              margin cancels the AdminShell <main> bottom padding (pb-6) and it
              sits flush on the footer at the end of the page. On phones it also
              cancels the space the shell reserves for the fixed bottom nav and
              pads itself by the same amount: it stays pinned to the viewport
              bottom with its own opaque background behind the nav, so no strip
              opens between the bar and the nav at any scroll position. */}
          <div className="sticky bottom-0 z-[5] -mx-[42px] -mb-6 flex flex-wrap items-center justify-between gap-3 border-t border-admin-border bg-admin-surface px-[42px] py-4 [@media(max-width:760px)]:-mx-5 [@media(max-width:760px)]:-mb-[calc(24px+74px+env(safe-area-inset-bottom))] [@media(max-width:760px)]:px-4 [@media(max-width:760px)]:pb-[calc(16px+74px+env(safe-area-inset-bottom))] [@media(min-width:761px)_and_(max-width:1060px)]:-mx-7 [@media(min-width:761px)_and_(max-width:1060px)]:px-7">
            <button
              type="button"
              disabled={busy || saving}
              onClick={() => openEditor(null)}
              className="min-h-11 bg-transparent p-0 text-[0.95rem] font-semibold text-admin-accent-hover underline underline-offset-4 disabled:opacity-60 [@media(max-width:760px)]:hidden"
            >
              Cancelar
            </button>
            <div className="flex flex-1 flex-wrap justify-end gap-3 [@media(max-width:760px)]:grid [@media(max-width:760px)]:grid-cols-2">
              {selected?.publicationState === "PUBLISHED" ? (
                <Button
                  type="submit"
                  form={formId}
                  className="min-h-12 rounded-[10px] px-6 text-[0.95rem] font-bold bg-admin-accent text-admin-on-accent hover:bg-admin-accent-hover [@media(max-width:760px)]:col-span-2"
                  disabled={mutationBlocked}
                >
                  {busy ? "Salvando…" : "Salvar alterações"}
                </Button>
              ) : (
                <>
                  <Button
                    type="submit"
                    form={formId}
                    value="draft"
                    variant="outline"
                    className="min-h-12 rounded-[10px] border-admin-border-strong px-6 text-[0.95rem] font-semibold"
                    disabled={mutationBlocked}
                  >
                    {busy ? "Salvando…" : "Salvar rascunho"}
                  </Button>
                  <Button
                    type="submit"
                    form={formId}
                    value="publish"
                    className="min-h-12 rounded-[10px] px-6 text-[0.95rem] font-bold bg-admin-accent text-admin-on-accent hover:bg-admin-accent-hover disabled:bg-admin-subtle-hover disabled:text-admin-text-secondary disabled:opacity-100"
                    disabled={mutationBlocked || !canPublishNow}
                  >
                    <span className="[@media(max-width:760px)]:hidden">
                      Salvar e publicar
                    </span>
                    <span className="hidden [@media(max-width:760px)]:inline">
                      Publicar
                    </span>
                  </Button>
                </>
              )}
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.75fr)] gap-3.5 [@media(max-width:760px)]:grid-cols-2">
            {(
              [
                ["Publicados", published],
                ["Rascunhos", drafts],
              ] as const
            ).map(([label, value]) => (
              <div
                key={label}
                className="grid min-w-0 gap-1 rounded-2xl border border-admin-border bg-admin-surface px-[18px] py-4"
              >
                <span className="text-[0.82rem] text-admin-text-secondary">
                  {label}
                </span>
                <span className="font-admin-display text-[1.75rem] leading-none text-admin-text">
                  {loading ? "–" : value}
                </span>
              </div>
            ))}
            <div className="flex min-w-0 items-center gap-4 rounded-2xl border border-admin-border bg-admin-surface px-[18px] py-4 [@media(max-width:760px)]:col-span-2">
              <div className="grid min-w-0 gap-1">
                <span className="text-[0.82rem] text-admin-text-secondary">
                  Taxas dos presentes
                </span>
                <strong className="text-[0.95rem] text-admin-text">
                  {giftFeeExplanation}
                </strong>
              </div>
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
            <div className="relative w-full max-w-[406px] [@media(max-width:760px)]:max-w-none">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-admin-text-secondary"
              />
              <Input
                aria-label="Buscar presentes"
                type="search"
                placeholder="Buscar por nome ou descrição"
                className="min-h-[42px] rounded-[10px] border-admin-border-strong bg-admin-surface pl-10 text-[0.95rem]"
                value={query}
                disabled={loading || Boolean(error)}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <fieldset
              className="m-0 flex min-w-0 max-w-full gap-1 rounded-[10px] border border-admin-border bg-admin-surface p-1 [@media(max-width:760px)]:grid [@media(max-width:760px)]:w-full [@media(max-width:760px)]:grid-cols-4"
              aria-label="Filtrar presentes"
            >
              {(
                [
                  ["ACTIVE", "Todos"],
                  ["PUBLISHED", "Publicados"],
                  ["DRAFT", "Rascunhos"],
                  ["ARCHIVED", "Arquivados"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={filter === value}
                  disabled={loading || Boolean(error)}
                  onClick={() => setFilter(value)}
                  className={`min-h-9 shrink-0 rounded-[7px] px-3.5 text-sm font-semibold whitespace-nowrap [@media(max-width:760px)]:min-w-0 [@media(max-width:760px)]:px-1 [@media(max-width:760px)]:text-[0.8rem] transition-colors motion-reduce:transition-none disabled:opacity-60 ${filter === value ? adminStyles.selected : "text-admin-text hover:bg-admin-canvas"}`}
                >
                  {label}
                </button>
              ))}
            </fieldset>
          </div>
          {!loading &&
            !error &&
            visibleGifts.length === 0 &&
            gifts.length > 0 && (
              <div
                className={`${adminStyles.surface} grid justify-items-center gap-3 px-5 py-12 text-center`}
              >
                <h2 className="m-0 text-lg font-semibold text-admin-text">
                  Nenhum presente encontrado
                </h2>
                <p className="m-0 max-w-md text-sm leading-relaxed text-admin-text-secondary">
                  Tente outra busca ou escolha outro filtro.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setQuery("");
                    setFilter("ACTIVE");
                  }}
                >
                  Limpar filtros
                </Button>
              </div>
            )}
          {!loading && !error && (
            <ul className="m-0 grid min-w-0 list-none grid-cols-[repeat(auto-fill,minmax(min(100%,250px),1fr))] gap-[18px] p-0">
              {filter !== "ARCHIVED" && !query && (
                <li className="min-w-0">
                  <button
                    type="button"
                    disabled={mutationBlocked}
                    onClick={() => openEditor({ kind: "create" })}
                    className="flex h-full min-h-[200px] w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-admin-border-strong bg-transparent p-6 text-center transition-colors hover:bg-admin-surface motion-reduce:transition-none disabled:opacity-60"
                  >
                    <span
                      aria-hidden="true"
                      className="flex size-12 items-center justify-center rounded-full bg-admin-accent-subtle text-admin-accent-hover"
                    >
                      <Plus className="size-6" />
                    </span>
                    <span className="text-base font-bold text-admin-accent-hover">
                      {gifts.length === 0
                        ? "Adicionar o primeiro presente"
                        : "Novo presente"}
                    </span>
                    <span className="text-[0.82rem] text-admin-text-secondary">
                      {gifts.length === 0
                        ? "Sua lista começa aqui. Ainda não há presentes cadastrados."
                        : "Foto, nome e valor"}
                    </span>
                  </button>
                </li>
              )}
              {visibleGifts.map((gift, index) => {
                const position = activeGifts.findIndex(
                  (item) => item.id === gift.id,
                );
                const archived = gift.publicationState === "ARCHIVED";
                const belowMinimum =
                  !archived && gift.nominalCents < giftMinimumNominalCents;
                const publishBlocked =
                  belowMinimum && gift.publicationState === "DRAFT";
                const minimumHintId = `${idPrefix}-minimum-${gift.id}`;
                const preview = renderPreview?.(gift, index + 1);
                return (
                  <li key={gift.id} className="min-w-0">
                    <article className="flex h-full min-w-0 flex-col overflow-hidden rounded-2xl border border-admin-border bg-admin-surface">
                      <div
                        className={`relative flex aspect-[290/182] items-center justify-center overflow-hidden ${photoTones[Math.max(position, 0) % photoTones.length]} [&_img]:h-full [&_img]:w-full [&_img]:object-cover`}
                      >
                        {preview ?? (
                          <ImageIcon
                            aria-hidden="true"
                            className="size-9 text-admin-accent-hover"
                          />
                        )}
                        <span className="absolute top-3 left-3">
                          <GiftStatusBadge state={gift.publicationState} />
                        </span>
                        {!archived && (
                          <span className="absolute top-2.5 right-2.5 flex gap-1">
                            <button
                              type="button"
                              disabled={mutationBlocked || position === 0}
                              aria-label={`Mover ${gift.title} para cima`}
                              onClick={() => moveGift(gift, "up")}
                              className="flex size-8 items-center justify-center rounded-lg bg-admin-surface/95 text-admin-text shadow-sm hover:bg-admin-surface disabled:opacity-40"
                            >
                              <ArrowUp aria-hidden="true" className="size-4" />
                            </button>
                            <button
                              type="button"
                              disabled={
                                mutationBlocked ||
                                position === activeGifts.length - 1
                              }
                              aria-label={`Mover ${gift.title} para baixo`}
                              onClick={() => moveGift(gift, "down")}
                              className="flex size-8 items-center justify-center rounded-lg bg-admin-surface/95 text-admin-text shadow-sm hover:bg-admin-surface disabled:opacity-40"
                            >
                              <ArrowDown
                                aria-hidden="true"
                                className="size-4"
                              />
                            </button>
                          </span>
                        )}
                      </div>
                      <div className="flex flex-1 flex-col gap-1.5 p-[18px]">
                        <h3 className="m-0 break-words text-[1.05rem] font-bold text-admin-text">
                          {gift.title}
                        </h3>
                        <p className="m-0 line-clamp-2 break-words text-sm leading-[1.5] text-admin-text">
                          {!gift.mediaAssetId &&
                          gift.publicationState === "DRAFT"
                            ? "Ainda sem foto. Adicione antes de publicar."
                            : gift.description ||
                              "Um presente simbólico para celebrar essa nova fase."}
                        </p>
                        <p className="m-0 text-lg font-bold text-admin-text">
                          {formatPrice(gift.nominalCents)}
                        </p>
                        {belowMinimum && (
                          <p
                            id={minimumHintId}
                            className="m-0 text-xs text-admin-text-secondary"
                          >
                            Ajuste o valor para pelo menos{" "}
                            {formatPrice(giftMinimumNominalCents)} para receber
                            contribuições.
                          </p>
                        )}
                        {archived ? (
                          <p className="m-0 mt-auto pt-2 text-xs text-admin-text-secondary">
                            Preservado no histórico
                          </p>
                        ) : (
                          <div className="mt-auto flex items-center gap-2 pt-3">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="min-h-9 border-admin-border-strong"
                              disabled={mutationBlocked}
                              onClick={() =>
                                openEditor({ kind: "edit", giftId: gift.id })
                              }
                            >
                              Editar<span className="sr-only"> presente</span>
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="min-h-9 border-admin-border-strong"
                              disabled={mutationBlocked || publishBlocked}
                              aria-describedby={
                                publishBlocked ? minimumHintId : undefined
                              }
                              onClick={() =>
                                void runAction(
                                  () =>
                                    onPublication(
                                      gift.id,
                                      gift.publicationState === "DRAFT"
                                        ? "PUBLISHED"
                                        : "DRAFT",
                                    ),
                                  gift.publicationState === "DRAFT"
                                    ? "Presente publicado."
                                    : "Presente retirado da lista pública.",
                                )
                              }
                            >
                              {gift.publicationState === "DRAFT"
                                ? "Publicar"
                                : "Despublicar"}
                            </Button>
                            <span className="ml-auto">
                              <OverflowMenu
                                label={`Mais ações para ${gift.title}`}
                                disabled={mutationBlocked}
                                items={[
                                  { id: "preview", label: "Ver prévia" },
                                  {
                                    id: "archive",
                                    label: "Arquivar presente",
                                    variant: "destructive",
                                  },
                                ]}
                                onSelect={(id) =>
                                  id === "preview"
                                    ? setPreviewId(gift.id)
                                    : setArchive(gift)
                                }
                              />
                            </span>
                          </div>
                        )}
                      </div>
                    </article>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      <Dialog
        open={Boolean(previewGift) || draftPreviewOpen}
        onOpenChange={(open) => {
          if (!open) {
            setPreviewId(null);
            setDraftPreviewOpen(false);
          }
        }}
      >
        <AdminDialogContent>
          <DialogHeader>
            <DialogTitle>Prévia do presente</DialogTitle>
            <DialogDescription>
              {draftPreviewOpen
                ? "Como os convidados vão ver este presente."
                : "Confira o conteúdo salvo antes de compartilhar sua lista."}
            </DialogDescription>
          </DialogHeader>
          {draftPreviewOpen && !previewGift ? (
            <GuestPreviewCard
              gift={selected}
              title={title}
              description={description}
              estimate={estimate}
              photo={photo}
            />
          ) : (
            previewGift && (
              <div className="min-w-0 overflow-hidden rounded-xl border border-admin-border">
                <div className="flex aspect-[16/9] items-center justify-center overflow-hidden bg-admin-subtle/50 [&_img]:h-full [&_img]:w-full [&_img]:object-cover">
                  {renderPreview?.(previewGift, positionOf(previewGift)) ?? (
                    <Gift
                      aria-hidden="true"
                      className="size-10 text-admin-accent/50"
                    />
                  )}
                </div>
                <div className="space-y-3 p-5">
                  <GiftStatusBadge state={previewGift.publicationState} />
                  <h3 className="break-words text-xl font-semibold text-admin-text">
                    {previewGift.title}
                  </h3>
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-admin-text-secondary">
                    {previewGift.description}
                  </p>
                  <GuestPreviewPrice estimate={estimate} />
                  <p className="text-xs text-admin-text-secondary">
                    {previewGift.publicationState === "PUBLISHED"
                      ? "Visível para os convidados"
                      : "Este rascunho está visível apenas no painel."}
                  </p>
                </div>
              </div>
            )
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Fechar prévia
            </DialogClose>
          </DialogFooter>
        </AdminDialogContent>
      </Dialog>
      <AlertDialog
        open={Boolean(archive)}
        onOpenChange={(open) => {
          if (!open) setArchive(null);
        }}
      >
        <AdminAlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Arquivar este presente?</AlertDialogTitle>
            <AlertDialogDescription>
              “{archive?.title}” sairá da lista dos convidados e ficará
              preservado no histórico.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutationBlocked}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={mutationBlocked}
              onClick={() => {
                const gift = archive;
                if (!gift || mutationBlocked) return;
                setArchive(null);
                if (selected?.id === gift.id) openEditor(null);
                void runAction(
                  () => onPublication(gift.id, "ARCHIVED"),
                  "Presente arquivado.",
                );
              }}
            >
              Arquivar presente
            </AlertDialogAction>
          </AlertDialogFooter>
        </AdminAlertDialogContent>
      </AlertDialog>
    </section>
  );
}
