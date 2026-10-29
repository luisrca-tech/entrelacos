import type {
  GiftCreateInput,
  GiftItem,
  GiftUpdateInput,
} from "@entrelacos/contracts";
import { giftCentsSchema } from "@entrelacos/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
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
  ArrowLeft,
  ArrowUp,
  Gift,
  Plus,
  Search,
} from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useId, useState } from "react";
import { adminStyles, displayHeading } from "../lib/adminStyles";
import {
  GiftPricingPreview,
  useGiftFeeAllocation,
} from "./GiftPricingSettings";

export type GiftEditorViewProps = {
  gifts: GiftItem[];
  loading?: boolean;
  error?: string | null;
  busy?: boolean;
  onRetry: () => void;
  onCreate: (input: GiftCreateInput) => Promise<void>;
  onUpdate: (giftId: string, input: GiftUpdateInput) => Promise<void>;
  onPublication: (
    giftId: string,
    state: GiftItem["publicationState"],
  ) => Promise<void>;
  onReorder: (giftIds: string[]) => Promise<void>;
  renderMedia?: (gift: GiftItem, blocked: boolean) => ReactNode;
  renderPreview?: (gift: GiftItem) => ReactNode;
};

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
  if (cents <= 0n || cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
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

function GiftPriceField({
  id,
  disabled,
  nominalCents: initialCents,
}: {
  id: string;
  disabled: boolean;
  nominalCents?: number;
}) {
  const [price, setPrice] = useState(() =>
    initialCents === undefined ? "" : editablePrice(initialCents),
  );
  const nominalCents = parseGiftPriceToCents(price);
  const feeAllocation = useGiftFeeAllocation();
  return (
    <div className="space-y-3">
      <label htmlFor={id}>
        {feeAllocation === "BUYER_GROSS_UP"
          ? "Valor que vocês receberão (R$)"
          : feeAllocation === "RECIPIENT_DEDUCTED"
            ? "Valor que o convidado pagará (R$)"
            : "Valor cadastrado (R$)"}
        <Input
          id={id}
          name="nominalPrice"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          maxLength={20}
          placeholder="Ex.: 120,00"
          required
          disabled={disabled}
          value={price}
          onChange={(event) => setPrice(event.target.value)}
        />
      </label>
      <GiftPricingPreview nominalCents={nominalCents} />
    </div>
  );
}

function statusLabel(state: GiftItem["publicationState"]): string {
  if (state === "PUBLISHED") return "Publicado";
  if (state === "ARCHIVED") return "Arquivado";
  return "Rascunho";
}

export function GiftEditorView({
  gifts,
  loading = false,
  error = null,
  busy = false,
  onRetry,
  onCreate,
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
  const previewGift = gifts.find((gift) => gift.id === previewId);
  const mutationState = { busy, loading, error };
  const mutationBlocked = isGiftMutationBlocked(mutationState);
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

  function openEditor(value: typeof editor) {
    setFormError(null);
    setEditor(value);
  }

  async function saveGift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutationBlocked) return;
    const data = new FormData(event.currentTarget);
    const title = String(data.get("title") ?? "").trim();
    const description = String(data.get("description") ?? "").trim();
    const nominalCents = parseGiftPriceToCents(
      String(data.get("nominalPrice") ?? ""),
    );
    if (
      !title ||
      title.length > 120 ||
      description.length > 2000 ||
      nominalCents === null
    ) {
      setFormError("Confira o título, a descrição e o valor informado.");
      return;
    }
    setFormError(null);
    try {
      if (selected) {
        await onUpdate(selected.id, { title, description, nominalCents });
        toast.success("Alterações salvas.");
      } else if (creating) {
        await onCreate({
          title,
          description,
          nominalCents,
          currency: "BRL",
          mediaAssetId: null,
          altText: "",
        });
        openEditor(null);
        setFilter("ACTIVE");
        setQuery("");
        toast.success(
          "Presente criado como rascunho. Adicione uma imagem e publique quando estiver pronto.",
        );
      }
    } catch {
      toast.error("Não foi possível salvar o presente. Tente novamente.");
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

  const statusBadge = (gift: GiftItem) => (
    <Badge
      variant="secondary"
      className={
        gift.publicationState === "PUBLISHED"
          ? "bg-admin-status-confirmed/10 text-admin-status-confirmed"
          : "bg-admin-beige text-admin-graphite"
      }
    >
      {statusLabel(gift.publicationState)}
    </Badge>
  );

  return (
    <section
      className="min-w-0 space-y-6"
      aria-labelledby="gift-catalog-heading"
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-xl">
          <h2
            id="gift-catalog-heading"
            className={`${displayHeading} text-3xl text-admin-ink`}
          >
            {editing
              ? creating
                ? "Novo presente"
                : "Editar presente"
              : "Lista de presentes"}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-admin-muted">
            {editing
              ? "Defina os detalhes e salve. A publicação é feita separadamente no catálogo."
              : "Cada presente é uma contribuição simbólica para o casal, sem produto físico ou entrega."}
          </p>
        </div>
        {editing ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => openEditor(null)}
          >
            <ArrowLeft aria-hidden="true" />
            Voltar ao catálogo
          </Button>
        ) : (
          <Button
            type="button"
            disabled={mutationBlocked}
            onClick={() => openEditor({ kind: "create" })}
          >
            <Plus aria-hidden="true" />
            Adicionar presente
          </Button>
        )}
      </header>

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
        <article className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(260px,0.65fr)]">
          <section
            className={`${adminStyles.surface} min-w-0 p-5 sm:p-6`}
            aria-label="Detalhes do presente"
          >
            <h3 className="font-semibold text-admin-ink">
              Detalhes do presente
            </h3>
            <form
              key={selected?.id ?? "new"}
              className={`${adminStyles.form} mb-0 mt-5`}
              onSubmit={(event) => void saveGift(event)}
            >
              <label htmlFor={`${idPrefix}-title`}>
                Título
                <Input
                  id={`${idPrefix}-title`}
                  name="title"
                  required
                  maxLength={120}
                  defaultValue={selected?.title ?? ""}
                  placeholder="Ex.: Jantar na lua de mel"
                  disabled={mutationBlocked}
                />
              </label>
              <label htmlFor={`${idPrefix}-description`}>
                Descrição{" "}
                <span className="text-xs font-normal text-admin-muted">
                  Opcional
                </span>
                <Textarea
                  id={`${idPrefix}-description`}
                  name="description"
                  maxLength={2000}
                  defaultValue={selected?.description ?? ""}
                  placeholder="Conte o que esse presente representa para vocês."
                  disabled={mutationBlocked}
                  rows={3}
                />
              </label>
              <GiftPriceField
                key={selected?.nominalCents ?? "new"}
                id={`${idPrefix}-price`}
                nominalCents={selected?.nominalCents}
                disabled={mutationBlocked}
              />
              {formError && (
                <p className={adminStyles.alert} role="alert">
                  {formError}
                </p>
              )}
              <div className="flex flex-wrap gap-3">
                <Button type="submit" disabled={mutationBlocked}>
                  {busy
                    ? "Salvando…"
                    : creating
                      ? "Salvar rascunho"
                      : "Salvar alterações"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => openEditor(null)}
                >
                  Cancelar
                </Button>
              </div>
            </form>
          </section>
          <aside className="min-w-0 space-y-5">
            <div className={`${adminStyles.surface} p-5`}>
              <div className="flex items-center gap-2 text-sm font-semibold text-admin-ink">
                <Gift aria-hidden="true" className="size-4" />
                {selected ? "Publicação" : "Primeiro, salve o rascunho"}
              </div>
              {selected && <div className="mt-3">{statusBadge(selected)}</div>}
              <p className="mt-3 text-sm leading-relaxed text-admin-muted">
                {selected?.publicationState === "PUBLISHED"
                  ? "Este presente está visível para os convidados. Alterações salvas aparecem na lista publicada."
                  : "Rascunhos ficam visíveis apenas para quem administra o casamento. Adicione uma imagem e publique quando estiver pronto."}
              </p>
              {selected && (
                <Button
                  type="button"
                  variant="ghost"
                  className="mt-3 text-destructive"
                  disabled={mutationBlocked}
                  onClick={() => setArchive(selected)}
                >
                  Arquivar presente
                </Button>
              )}
            </div>
            {selected && renderMedia?.(selected, mutationBlocked)}
            {creating && (
              <p className="px-1 text-sm leading-relaxed text-admin-muted">
                Depois de salvar, abra o presente para adicionar ou trocar sua
                imagem.
              </p>
            )}
          </aside>
        </article>
      ) : (
        <>
          <div className="space-y-4">
            <div className="relative max-w-md">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-3.5 size-4 text-admin-muted"
              />
              <Input
                aria-label="Buscar presentes"
                type="search"
                placeholder="Buscar por título ou descrição"
                className="pl-10"
                value={query}
                disabled={loading || Boolean(error)}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <fieldset
              className="flex flex-wrap gap-2"
              aria-label="Filtrar presentes"
            >
              {(
                [
                  ["ACTIVE", "Todos os ativos"],
                  ["PUBLISHED", "Publicados"],
                  ["DRAFT", "Rascunhos"],
                  ["ARCHIVED", "Arquivados"],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  type="button"
                  variant={filter === value ? "secondary" : "ghost"}
                  size="sm"
                  aria-pressed={filter === value}
                  disabled={loading || Boolean(error)}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </Button>
              ))}
            </fieldset>
          </div>
          {!loading && !error && visibleGifts.length === 0 && (
            <div
              className={`${adminStyles.surface} grid justify-items-center gap-3 px-5 py-12 text-center`}
            >
              <div className="rounded-full bg-admin-beige p-4">
                <Gift
                  aria-hidden="true"
                  className="size-7 text-admin-terracotta"
                />
              </div>
              <h3 className="text-lg font-semibold text-admin-ink">
                {gifts.length === 0
                  ? "Sua lista começa aqui"
                  : "Nenhum presente encontrado"}
              </h3>
              <p className="max-w-md text-sm leading-relaxed text-admin-muted">
                {gifts.length === 0
                  ? "Ainda não há presentes cadastrados. Use Adicionar presente para criar o primeiro rascunho."
                  : "Tente outra busca ou escolha outro filtro."}
              </p>
              {gifts.length > 0 && (
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
              )}
            </div>
          )}
          <div className="grid min-w-0 gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {visibleGifts.map((gift) => {
              const position = activeGifts.findIndex(
                (item) => item.id === gift.id,
              );
              const archived = gift.publicationState === "ARCHIVED";
              return (
                <article
                  key={gift.id}
                  className={`${adminStyles.surface} flex min-w-0 flex-col overflow-hidden`}
                >
                  <div className="flex aspect-[16/9] items-center justify-center overflow-hidden bg-admin-beige/50 [&_img]:h-full [&_img]:w-full [&_img]:object-cover">
                    {renderPreview?.(gift) ?? (
                      <Gift
                        aria-hidden="true"
                        className="size-10 text-admin-terracotta/50"
                      />
                    )}
                  </div>
                  <div className="flex flex-1 flex-col p-5">
                    <div>{statusBadge(gift)}</div>
                    <h3 className="mt-3 break-words text-lg font-semibold text-admin-ink">
                      {gift.title}
                    </h3>
                    <p className="mt-1 line-clamp-2 break-words text-sm leading-relaxed text-admin-muted">
                      {gift.description ||
                        "Um presente simbólico para celebrar essa nova fase."}
                    </p>
                    <p className="mt-4 text-xl font-semibold text-admin-ink">
                      {formatPrice(gift.nominalCents)}
                    </p>
                    <p className="mt-1 text-xs text-admin-muted">
                      {archived
                        ? "Preservado no histórico"
                        : gift.publicationState === "PUBLISHED"
                          ? "Visível para os convidados"
                          : "Visível apenas no painel"}
                    </p>
                    {!archived && (
                      <div className="mt-auto pt-5">
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={mutationBlocked}
                            onClick={() =>
                              openEditor({ kind: "edit", giftId: gift.id })
                            }
                          >
                            Editar presente
                          </Button>
                          <Button
                            type="button"
                            variant={
                              gift.publicationState === "DRAFT"
                                ? "default"
                                : "ghost"
                            }
                            size="sm"
                            disabled={mutationBlocked}
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
                        </div>
                        <div className="mt-4 flex items-center justify-between border-t border-admin-line pt-3">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={mutationBlocked}
                            onClick={() => setPreviewId(gift.id)}
                          >
                            Ver prévia
                          </Button>
                          <div className="flex gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              disabled={mutationBlocked || position === 0}
                              aria-label={`Mover ${gift.title} para cima`}
                              onClick={() => moveGift(gift, "up")}
                            >
                              <ArrowUp aria-hidden="true" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              disabled={
                                mutationBlocked ||
                                position === activeGifts.length - 1
                              }
                              aria-label={`Mover ${gift.title} para baixo`}
                              onClick={() => moveGift(gift, "down")}
                            >
                              <ArrowDown aria-hidden="true" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </>
      )}
      <Dialog
        open={Boolean(previewGift)}
        onOpenChange={(open) => {
          if (!open) setPreviewId(null);
        }}
      >
        <DialogContent className={adminStyles.dialog}>
          <DialogHeader>
            <DialogTitle>Prévia do presente</DialogTitle>
            <DialogDescription>
              Confira o conteúdo salvo antes de compartilhar sua lista.
            </DialogDescription>
          </DialogHeader>
          {previewGift && (
            <div className="min-w-0 overflow-hidden rounded-xl border border-admin-line">
              <div className="flex aspect-[16/9] items-center justify-center overflow-hidden bg-admin-beige/50 [&_img]:h-full [&_img]:w-full [&_img]:object-cover">
                {renderPreview?.(previewGift) ?? (
                  <Gift
                    aria-hidden="true"
                    className="size-10 text-admin-terracotta/50"
                  />
                )}
              </div>
              <div className="space-y-3 p-5">
                {statusBadge(previewGift)}
                <h3 className="break-words text-xl font-semibold text-admin-ink">
                  {previewGift.title}
                </h3>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-admin-muted">
                  {previewGift.description}
                </p>
                <p className="text-2xl font-semibold text-admin-ink">
                  {formatPrice(previewGift.nominalCents)}
                </p>
                <p className="text-xs text-admin-muted">
                  {previewGift.publicationState === "PUBLISHED"
                    ? "Visível para os convidados"
                    : "Este rascunho está visível apenas no painel."}
                </p>
              </div>
            </div>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Fechar prévia
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={Boolean(archive)}
        onOpenChange={(open) => {
          if (!open) setArchive(null);
        }}
      >
        <AlertDialogContent>
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
                void runAction(
                  () => onPublication(gift.id, "ARCHIVED"),
                  "Presente arquivado.",
                );
              }}
            >
              Arquivar presente
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
