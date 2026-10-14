import type { PublicGiftItem } from "@entrelacos/contracts";
import { useId } from "react";

type Props = {
  gifts: PublicGiftItem[];
  mode: "disabled" | "sandbox" | "live";
  busy: boolean;
  onSelect: (gift: PublicGiftItem) => void;
  search?: {
    value: string;
    page: number;
    total: number;
    totalPages: number;
    loading: boolean;
    error: boolean;
    onChange: (q: string) => void;
    onPage: (page: number) => void;
  };
};

const giftActionButtonClass =
  "min-h-11 w-full cursor-pointer border border-template-ink bg-template-ink px-4 py-[0.65rem] text-template-ivory font-[inherit] font-bold disabled:cursor-not-allowed disabled:opacity-50";
const pageButtonClass =
  "min-h-11 cursor-pointer border border-template-line bg-transparent px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50";
const currencyFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

export function GiftCatalogView({
  gifts,
  mode,
  busy,
  onSelect,
  search,
}: Props) {
  const searchId = useId();
  if (mode === "disabled" || (gifts.length === 0 && !search)) return null;

  return (
    <section
      aria-labelledby="gift-catalog-heading"
      className="grid min-w-0 gap-5 text-template-ink"
    >
      <header className="grid min-w-0 gap-3">
        <h2
          id="gift-catalog-heading"
          className="m-0 font-template-serif text-[clamp(2rem,5vw,3rem)] font-normal leading-tight"
        >
          Presentes simbólicos
        </h2>
        {mode === "sandbox" && (
          <p
            role="status"
            className="m-0 border border-template-line px-4 py-3 text-sm"
          >
            Ambiente de testes — sem pagamentos reais.
          </p>
        )}
        <p className="m-0 text-template-muted">
          Presente simbólico: não há produto físico ou entrega.
        </p>
      </header>

      {search && (
        <div className="grid min-w-0 gap-3">
          <label htmlFor={searchId}>Buscar presentes</label>
          <input
            id={searchId}
            type="search"
            value={search.value}
            maxLength={100}
            onChange={(event) => search.onChange(event.target.value)}
            className="min-h-11 min-w-0 border border-template-line bg-transparent p-3"
          />
          <nav
            aria-label="Paginação dos presentes"
            className="flex flex-wrap items-center gap-3"
          >
            <button
              type="button"
              className={pageButtonClass}
              disabled={search.loading || search.error || search.page <= 1}
              onClick={() => search.onPage(search.page - 1)}
            >
              Página anterior
            </button>
            <p className="m-0" aria-live="polite">
              {!search.loading && !search.error && (
                <>
                  Página {search.page} de {search.totalPages} · {search.total}{" "}
                  presentes
                </>
              )}
            </p>
            <button
              type="button"
              className={pageButtonClass}
              disabled={
                search.loading ||
                search.error ||
                search.page >= search.totalPages
              }
              onClick={() => search.onPage(search.page + 1)}
            >
              Próxima página
            </button>
          </nav>
          {search.loading && <p role="status">Carregando presentes…</p>}
          {search.error && (
            <p role="alert">Não foi possível carregar os presentes agora.</p>
          )}
          {!search.loading && !search.error && gifts.length === 0 && (
            <p role="status">Nenhum presente nesta página.</p>
          )}
        </div>
      )}

      <ul className="m-0 grid min-w-0 list-none grid-cols-1 gap-4 p-0 [@media(min-width:640px)]:grid-cols-2 [@media(min-width:1024px)]:grid-cols-3">
        {gifts.map((gift) => (
          <li
            key={gift.id}
            className="grid min-w-0 content-start border border-template-line bg-[var(--template-paper,#fffdf8)]"
          >
            {gift.image && (
              <img
                src={gift.image.url}
                alt={gift.image.alt}
                loading="lazy"
                className="aspect-[4/3] w-full object-cover"
              />
            )}
            <div className="grid min-w-0 gap-3 p-5">
              <h3 className="m-0 break-words font-template-serif text-2xl font-normal">
                {gift.title}
              </h3>
              <p className="m-0 break-words leading-relaxed text-template-muted">
                {gift.description}
              </p>
              <p className="m-0 text-template-ink">
                Valor simbólico:{" "}
                {currencyFormatter.format(gift.nominalCents / 100)}
              </p>
              <button
                type="button"
                className={giftActionButtonClass}
                disabled={busy}
                onClick={() => onSelect(gift)}
              >
                {busy ? "Aguarde…" : "Escolher presente"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
