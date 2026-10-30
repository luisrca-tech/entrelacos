import type { PublicGiftItem } from "@entrelacos/contracts";
import { type CSSProperties, useId } from "react";

type Props = {
  gifts: PublicGiftItem[];
  mode: "disabled" | "sandbox" | "live";
  busy: boolean;
  actionLabel?: string;
  recoveryOnly?: boolean;
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
  "min-h-11 cursor-pointer rounded-full border border-template-ink bg-template-ink px-5 py-3 text-template-ivory font-[inherit] text-sm font-medium transition-[background-color,box-shadow,transform] duration-200 ease-out hover:-translate-y-0.5 hover:bg-template-olive hover:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-template-ink disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transform-none motion-reduce:transition-none w-full";
const pageButtonClass =
  "min-h-11 cursor-pointer rounded-full border border-template-line bg-transparent px-5 py-3 text-template-ink font-[inherit] text-sm font-medium transition-[background-color,color,border-color,transform] duration-200 ease-out hover:-translate-y-0.5 hover:border-template-ink hover:bg-template-ink hover:text-template-ivory focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-template-ink disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transform-none motion-reduce:transition-none";
const currencyFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

export function GiftCatalogView({
  gifts,
  mode,
  busy,
  actionLabel,
  recoveryOnly = false,
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
          className="m-0 text-lg font-medium leading-relaxed"
        >
          Presentes simbólicos
        </h2>
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
            className="min-h-11 w-full rounded-xl border border-[rgba(37,53,43,0.25)] bg-[#fffdf8] px-4 py-3 text-base text-template-ink font-[inherit] transition-[border-color,box-shadow] duration-200 focus:border-template-olive focus:outline-2 focus:outline-offset-2 focus:outline-template-olive motion-reduce:transition-none min-w-0"
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
          {!search.loading && !search.error && gifts.length === 0 && (
            <p role="status">Nenhum presente nesta página.</p>
          )}
        </div>
      )}

      <ul className="m-0 grid min-w-0 list-none grid-cols-1 items-stretch gap-6 p-0 sm:grid-cols-2 lg:grid-cols-3">
        {gifts.map((gift, index) => (
          <li key={gift.id} className="min-w-0" data-template-reveal>
            <article
              data-template-reveal-item
              data-template-reveal-kind="card"
              style={
                {
                  "--template-card-delay-medium": `${(index % 2) * 180}ms`,
                  "--template-card-delay-wide": `${(index % 3) * 180}ms`,
                } as CSSProperties
              }
              className="group/gift flex h-full min-w-0 flex-col overflow-hidden rounded-[1.5rem] border border-template-line bg-[var(--template-paper,#fffdf8)] [--template-reveal-delay:0ms] sm:[--template-reveal-delay:var(--template-card-delay-medium)] lg:[--template-reveal-delay:var(--template-card-delay-wide)] transition-[border-color,box-shadow] duration-300 hover:border-template-muted hover:shadow-[0_12px_35px_rgba(37,53,43,0.06)] focus-within:border-template-muted motion-reduce:transition-none"
            >
              {gift.image && (
                <img
                  src={gift.image.url}
                  alt={gift.image.alt}
                  loading="lazy"
                  className="aspect-[4/3] w-full object-cover transition-transform duration-700 ease-out group-hover/gift:scale-[1.025] motion-reduce:transform-none motion-reduce:transition-none"
                />
              )}
              <div className="flex min-w-0 flex-1 flex-col items-start gap-4 p-[clamp(1.25rem,2vw,1.75rem)] [&>button]:mt-auto">
                <h3 className="m-0 break-words font-template-serif text-2xl font-normal">
                  {gift.title}
                </h3>
                <p className="m-0 break-words leading-relaxed text-template-muted">
                  {gift.description}
                </p>
                {gift.pricing?.feeAllocation === "BUYER_GROSS_UP" ? (
                  <p role="status" className="m-0 text-template-muted">
                    {gift.pricing.available && mode === "sandbox"
                      ? "Homologação Sandbox. Escolha Pix ou cartão para consultar o total com taxas."
                      : "Preço indisponível. Os pagamentos deste presente aguardam validação."}
                  </p>
                ) : (
                  <p className="m-0 text-template-ink">
                    Valor simbólico:{" "}
                    {currencyFormatter.format(gift.nominalCents / 100)}
                    <span className="block text-sm text-template-muted">
                      Pix ou cartão à vista · mesmo preço final
                    </span>
                  </p>
                )}
                <button
                  type="button"
                  className={giftActionButtonClass}
                  disabled={
                    busy || (!recoveryOnly && gift.pricing?.available === false)
                  }
                  onClick={() => onSelect(gift)}
                >
                  {busy ? "Aguarde…" : (actionLabel ?? "Escolher presente")}
                </button>
              </div>
            </article>
          </li>
        ))}
      </ul>
    </section>
  );
}
