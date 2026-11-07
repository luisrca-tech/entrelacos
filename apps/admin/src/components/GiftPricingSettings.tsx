import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { z } from "zod";

const feeAllocation = "BUYER_GROSS_UP";
const cents = z.number().int().nonnegative().safe();
const previewSchema = z.object({
  siteId: z.string(),
  feeAllocation: z.literal(feeAllocation),
  guaranteed: z.literal(false),
  startingAtCents: cents.nullable().optional(),
  methods: z
    .array(
      z.object({
        method: z.enum(["PIX", "CREDIT_CARD"]),
        available: z.boolean(),
        nominalCents: cents,
        commissionCents: cents,
        processingCents: cents.nullable(),
        totalCents: cents.nullable(),
        recipientNetCents: cents.nullable(),
      }),
    )
    .length(2),
});
export function parsePricingPreview(
  value: unknown,
  siteId: string,
  nominalCents: number,
) {
  const parsed = previewSchema.parse(value);
  if (
    parsed.siteId !== siteId ||
    new Set(parsed.methods.map((m) => m.method)).size !== 2 ||
    parsed.methods.some(
      (m) =>
        m.nominalCents !== nominalCents ||
        (!m.available &&
          (m.processingCents !== null ||
            m.totalCents !== null ||
            m.recipientNetCents !== null)),
    )
  )
    throw new Error("Invalid pricing preview");
  return parsed;
}
type Request = (
  path: string,
  options?: { method?: string; body?: unknown; signal?: AbortSignal },
) => Promise<unknown>;
type PricingRequest = {
  request: Request;
  siteId: string;
  isCurrent: () => boolean;
};
const PricingContext = createContext<PricingRequest | null | undefined>(
  undefined,
);
export const money = (value: number | null) =>
  value === null
    ? "Indisponível"
    : new Intl.NumberFormat("pt-BR", {
        style: "currency",
        currency: "BRL",
      }).format(value / 100);
export const giftFeeExplanation =
  "As taxas estão incluídas no preço que o convidado vê.";

export function GiftPricingSettings({
  enabled = true,
  siteId,
  request,
  isCurrent,
  children,
}: PricingRequest & {
  enabled?: boolean;
  children: ReactNode;
}) {
  const context = useMemo(
    () => (enabled ? { siteId, request, isCurrent } : null),
    [enabled, siteId, request, isCurrent],
  );
  return (
    <PricingContext.Provider value={context}>
      {children}
    </PricingContext.Provider>
  );
}

export type GiftPricingEstimate = z.infer<typeof previewSchema>;

export function useGiftPricingPreview(nominalCents: number | null) {
  const context = useContext(PricingContext);
  const [preview, setPreview] = useState<{
    context: PricingRequest;
    nominalCents: number;
    value: GiftPricingEstimate;
  } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    setPreview(null);
    if (!context || nominalCents === null || !context.isCurrent()) return;
    const { request, siteId, isCurrent } = context;
    void request(
      `/v1/sites/${encodeURIComponent(siteId)}/gift-pricing-preview`,
      {
        method: "POST",
        signal: abort.signal,
        body: { nominalCents, feeAllocation },
      },
    )
      .then((value) => {
        const parsed = parsePricingPreview(value, siteId, nominalCents);
        if (!abort.signal.aborted && isCurrent())
          setPreview({ context, nominalCents, value: parsed });
      })
      .catch(() => {});
    return () => abort.abort();
  }, [context, nominalCents]);
  return context &&
    preview?.context === context &&
    preview.nominalCents === nominalCents &&
    context.isCurrent()
    ? preview.value
    : null;
}

function PreviewRow({
  label,
  value,
  strong = false,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: "success";
}) {
  return (
    <div className="flex min-w-0 flex-wrap justify-between gap-x-3 gap-y-0.5">
      <dt className={strong ? "font-bold text-admin-text" : "text-admin-text"}>
        {label}
      </dt>
      <dd
        className={`m-0 text-right ${strong ? "font-bold" : ""} ${tone === "success" ? "text-admin-success-text" : "text-admin-text"}`}
      >
        {value}
      </dd>
    </div>
  );
}

export function GiftPricingPreview({
  nominalCents,
  estimate,
  title,
}: {
  nominalCents: number | null;
  estimate: GiftPricingEstimate | null;
  title?: string;
}) {
  if (useContext(PricingContext) === null) return null;
  return (
    <div
      aria-live="polite"
      className="grid min-w-0 gap-3 rounded-[14px] bg-admin-canvas p-4 text-sm"
    >
      {title && <p className="m-0 font-bold text-admin-text">{title}</p>}
      {nominalCents === null ? (
        <p className="m-0 text-admin-text-secondary">
          Informe um valor válido para simular.
        </p>
      ) : (
        (["PIX", "CREDIT_CARD"] as const).map((method) => {
          const item = estimate?.methods.find((m) => m.method === method);
          return (
            <section
              key={method}
              aria-label={method === "PIX" ? "Pix" : "Cartão à vista"}
              className="grid min-w-0 gap-1.5"
            >
              <h4 className="m-0 text-xs font-bold uppercase tracking-[0.06em] text-admin-text-secondary">
                {method === "PIX" ? "Pix" : "Cartão à vista"}
              </h4>
              <dl className="m-0 grid gap-1.5">
                <PreviewRow
                  label="Valor cadastrado"
                  value={money(nominalCents)}
                />
                <PreviewRow
                  label="Taxas"
                  value={money(
                    item?.processingCents == null
                      ? null
                      : item.commissionCents + item.processingCents,
                  )}
                />
                <div className="my-0.5 border-t border-admin-border" />
                <PreviewRow
                  label="Total do convidado"
                  value={money(item?.totalCents ?? null)}
                  strong
                />
                <PreviewRow
                  label="Líquido do casal"
                  value={money(item?.recipientNetCents ?? null)}
                  strong
                  tone="success"
                />
              </dl>
            </section>
          );
        })
      )}
      <p className="m-0 text-xs leading-[1.5] text-admin-text-secondary">
        {giftFeeExplanation} A simulação mostra os valores à vista.
      </p>
    </div>
  );
}
