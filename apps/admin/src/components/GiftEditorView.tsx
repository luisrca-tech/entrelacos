import type {
  GiftCreateInput,
  GiftItem,
  GiftUpdateInput,
} from "@entrelacos/contracts";
import { giftCentsSchema } from "@entrelacos/contracts";
import { Button, Input, Textarea } from "@entrelacos/ui";
import type { FormEvent, ReactNode } from "react";
import { useId, useState } from "react";
import { adminStyles, displayHeading } from "../lib/adminStyles";

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
}: GiftEditorViewProps) {
  const idPrefix = useId();
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const mutationState = { busy, loading, error };
  const mutationBlocked = isGiftMutationBlocked(mutationState);
  const activeGifts = gifts
    .filter((gift) => gift.publicationState !== "ARCHIVED")
    .sort((left, right) => left.sortOrder - right.sortOrder);
  const archivedGifts = gifts
    .filter((gift) => gift.publicationState === "ARCHIVED")
    .sort((left, right) => left.sortOrder - right.sortOrder);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
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
    setActionError(null);
    try {
      await onCreate({
        title,
        description,
        nominalCents,
        currency: "BRL",
        mediaAssetId: null,
        altText: "",
      });
    } catch {
      setActionError("Não foi possível salvar o presente. Tente novamente.");
    }
  }

  async function handleUpdate(
    event: FormEvent<HTMLFormElement>,
    gift: GiftItem,
  ) {
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
    setActionError(null);
    try {
      // Keep media fields untouched until the catalog has an upload/edit seam.
      await onUpdate(gift.id, { title, description, nominalCents });
    } catch {
      setActionError("Não foi possível atualizar o presente. Tente novamente.");
    }
  }

  async function runAction(action: () => Promise<void>) {
    const readyAction = runGiftMutationWhenReady(mutationState, action);
    if (!readyAction) return;
    setActionError(null);
    try {
      await readyAction;
    } catch {
      setActionError("Não foi possível atualizar o catálogo. Tente novamente.");
    }
  }

  function archiveGift(gift: GiftItem) {
    if (mutationBlocked) return;
    const confirmed = window.confirm(
      `Arquivar “${gift.title}”? O presente ficará preservado no histórico.`,
    );
    if (confirmed) {
      void runAction(() => onPublication(gift.id, "ARCHIVED"));
    }
  }

  function moveGift(gift: GiftItem, direction: "up" | "down") {
    const reorderedIds = getReorderedGiftIds(gifts, gift.id, direction);
    if (mutationBlocked || reorderedIds === null) return;
    void runAction(() => onReorder(reorderedIds));
  }

  return (
    <section
      className="min-w-0 space-y-6"
      aria-labelledby="gift-catalog-heading"
    >
      <header className={adminStyles.card}>
        <h2
          id="gift-catalog-heading"
          className={`${displayHeading} text-2xl text-admin-ink`}
        >
          Catálogo de presentes
        </h2>
        <p className={`${adminStyles.muted} mt-2 leading-relaxed`}>
          Cada presente é uma contribuição simbólica para o casal. Não há
          produto físico nem entrega.
        </p>
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

      <section className={adminStyles.card} aria-labelledby="new-gift-heading">
        <h3
          id="new-gift-heading"
          className={`${displayHeading} text-xl text-admin-ink`}
        >
          Novo presente
        </h3>
        <form className={adminStyles.formGrid} onSubmit={handleCreate}>
          <label htmlFor={`${idPrefix}-create-title`}>
            Título
            <Input
              id={`${idPrefix}-create-title`}
              name="title"
              required
              maxLength={120}
              disabled={mutationBlocked}
            />
          </label>
          <label htmlFor={`${idPrefix}-create-description`}>
            Descrição
            <Textarea
              id={`${idPrefix}-create-description`}
              name="description"
              maxLength={2000}
              disabled={mutationBlocked}
              rows={3}
            />
          </label>
          <label htmlFor={`${idPrefix}-create-price`}>
            Valor simbólico (R$)
            <Input
              id={`${idPrefix}-create-price`}
              name="nominalPrice"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              maxLength={20}
              placeholder="Ex.: 120,00"
              required
              disabled={mutationBlocked}
            />
          </label>
          <Button type="submit" disabled={mutationBlocked}>
            Cadastrar presente
          </Button>
        </form>
      </section>

      {formError && !error && (
        <p className={adminStyles.alert} role="alert">
          {formError}
        </p>
      )}

      {!loading && !error && gifts.length === 0 && (
        <p className={adminStyles.notice}>
          Ainda não há presentes cadastrados.
        </p>
      )}

      {activeGifts.length > 0 && (
        <section aria-labelledby="active-gifts-heading" className="min-w-0">
          <h3
            id="active-gifts-heading"
            className={`${displayHeading} mb-4 text-xl text-admin-ink`}
          >
            Presentes ativos
          </h3>
          <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
            {activeGifts.map((gift, index) => (
              <article
                key={gift.id}
                className={`${adminStyles.surface} min-w-0 p-5`}
              >
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="break-words text-lg font-semibold text-admin-ink">
                      {gift.title}
                    </h4>
                    <p className={`${adminStyles.muted} mt-1 break-words`}>
                      {gift.description || "Sem descrição."}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-admin-beige px-3 py-1 text-sm text-admin-graphite">
                    {statusLabel(gift.publicationState)}
                  </span>
                </div>
                <p className="mt-4 font-medium text-admin-ink">
                  {formatPrice(gift.nominalCents)}
                </p>

                <details className="mt-4 border-t border-admin-line pt-4">
                  <summary className="cursor-pointer font-medium text-admin-terracotta-deep underline underline-offset-4">
                    Editar presente
                  </summary>
                  <form
                    className={adminStyles.form}
                    onSubmit={(event) => void handleUpdate(event, gift)}
                  >
                    <label htmlFor={`${idPrefix}-edit-title-${index}`}>
                      Título
                      <Input
                        id={`${idPrefix}-edit-title-${index}`}
                        name="title"
                        required
                        maxLength={120}
                        defaultValue={gift.title}
                        disabled={mutationBlocked}
                      />
                    </label>
                    <label htmlFor={`${idPrefix}-edit-description-${index}`}>
                      Descrição
                      <Textarea
                        id={`${idPrefix}-edit-description-${index}`}
                        name="description"
                        maxLength={2000}
                        defaultValue={gift.description}
                        disabled={mutationBlocked}
                        rows={3}
                      />
                    </label>
                    <label htmlFor={`${idPrefix}-edit-price-${index}`}>
                      Valor simbólico (R$)
                      <Input
                        id={`${idPrefix}-edit-price-${index}`}
                        name="nominalPrice"
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        maxLength={20}
                        required
                        defaultValue={editablePrice(gift.nominalCents)}
                        disabled={mutationBlocked}
                      />
                    </label>
                    <Button type="submit" disabled={mutationBlocked}>
                      Salvar alterações
                    </Button>
                    {renderMedia?.(gift, mutationBlocked)}
                  </form>
                </details>

                <div className={`${adminStyles.inline} mt-4`}>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={mutationBlocked || index === 0}
                    aria-label={`Mover ${gift.title} para cima`}
                    onClick={() => moveGift(gift, "up")}
                  >
                    Subir
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={
                      mutationBlocked || index === activeGifts.length - 1
                    }
                    aria-label={`Mover ${gift.title} para baixo`}
                    onClick={() => moveGift(gift, "down")}
                  >
                    Descer
                  </Button>
                  {gift.publicationState === "DRAFT" ? (
                    <Button
                      type="button"
                      disabled={mutationBlocked}
                      onClick={() =>
                        void runAction(() =>
                          onPublication(gift.id, "PUBLISHED"),
                        )
                      }
                    >
                      Publicar
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={mutationBlocked}
                      onClick={() =>
                        void runAction(() => onPublication(gift.id, "DRAFT"))
                      }
                    >
                      Despublicar
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={mutationBlocked}
                    aria-label={`Arquivar ${gift.title}`}
                    onClick={() => archiveGift(gift)}
                  >
                    Arquivar
                  </Button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {archivedGifts.length > 0 && (
        <details className={adminStyles.card}>
          <summary className="cursor-pointer font-semibold text-admin-ink">
            Presentes arquivados ({archivedGifts.length})
          </summary>
          <ul className="mt-4 grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2">
            {archivedGifts.map((gift) => (
              <li
                key={gift.id}
                className="min-w-0 rounded-lg border border-admin-line p-4"
              >
                <h4 className="break-words font-semibold text-admin-ink">
                  {gift.title}
                </h4>
                <p className={`${adminStyles.muted} mt-1 break-words`}>
                  {gift.description || "Sem descrição."}
                </p>
                <p className="mt-3 text-sm text-admin-graphite">
                  {formatPrice(gift.nominalCents)} ·{" "}
                  {statusLabel(gift.publicationState)}
                </p>
              </li>
            ))}
          </ul>
        </details>
      )}

      {actionError && !error && (
        <p className={adminStyles.alert} role="alert">
          {actionError}
        </p>
      )}
    </section>
  );
}
