import {
  giftInstallmentOptionSchema,
  giftMaximumInstallments,
} from "@entrelacos/contracts";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@entrelacos/ui";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { z } from "zod";
import { AdminButton } from "./AdminButton";
import { AdminDialogContent } from "./AdminDialog";
import { receivingField } from "./receivingUi";

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
        installmentOptions: z
          .array(giftInstallmentOptionSchema)
          .min(1)
          .max(giftMaximumInstallments)
          .optional(),
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
    parsed.methods.some((m) => {
      if (
        m.nominalCents !== nominalCents ||
        (!m.available &&
          (m.processingCents !== null ||
            m.totalCents !== null ||
            m.recipientNetCents !== null))
      )
        return true;
      const options = m.installmentOptions;
      if (!options) return false;
      if (
        m.method !== "CREDIT_CARD" ||
        !m.available ||
        m.totalCents === null ||
        m.recipientNetCents === null
      )
        return true;
      const total = m.totalCents;
      const minimumTotal = m.recipientNetCents + m.commissionCents;
      return (
        options[0].installmentCount !== 1 ||
        options[0].totalCents !== total ||
        options.some(
          (option, index) =>
            option.installmentSurchargeCents !== option.totalCents - total ||
            option.totalCents < minimumTotal ||
            (index > 0 &&
              option.installmentCount <= options[index - 1].installmentCount),
        )
      );
    })
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
    <Dialog>
      <DialogTrigger
        render={
          <AdminButton
            type="button"
            tone="secondary"
            className="w-fit max-w-full whitespace-normal"
          />
        }
      >
        Simular taxas e parcelamento
      </DialogTrigger>
      <AdminDialogContent>
        <DialogHeader>
          <DialogTitle>Simulação de taxas e parcelamento</DialogTitle>
          <DialogDescription>
            A seleção vale só para esta simulação. O convidado escolhe o
            parcelamento na hora de pagar.
          </DialogDescription>
        </DialogHeader>
        <PricingComparison
          nominalCents={nominalCents}
          estimate={estimate}
          title={title}
        />
      </AdminDialogContent>
    </Dialog>
  );
}

function PricingComparison({
  nominalCents,
  estimate,
  title,
}: {
  nominalCents: number | null;
  estimate: GiftPricingEstimate | null;
  title?: string;
}) {
  const id = useId();
  const [installmentCount, setInstallmentCount] = useState(1);
  const cardOptions = estimate?.methods.find(
    (method) => method.method === "CREDIT_CARD",
  )?.installmentOptions;
  const cardSelection =
    cardOptions?.find(
      (option) => option.installmentCount === installmentCount,
    ) ?? cardOptions?.[0];
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
          const selected = method === "CREDIT_CARD" ? cardSelection : undefined;
          const installments =
            selected && selected.installmentCount > 1 ? selected : null;
          const amounts = installments?.installmentCents;
          const adjustedLast =
            amounts && amounts[0] !== amounts[amounts.length - 1];
          return (
            <section
              key={method}
              aria-label={method === "PIX" ? "Pix" : "Cartão"}
              className="grid min-w-0 gap-1.5"
            >
              <h3 className="m-0 text-xs font-bold uppercase tracking-[0.06em] text-admin-text-secondary">
                {method === "PIX" ? "Pix" : "Cartão"}
              </h3>
              {method === "CREDIT_CARD" &&
                cardOptions &&
                cardOptions.length > 1 && (
                  <div className="mb-2 grid gap-2">
                    <label
                      htmlFor={`${id}-installments`}
                      className="font-semibold text-admin-text"
                    >
                      Parcelas para simular
                    </label>
                    <select
                      id={`${id}-installments`}
                      className={receivingField}
                      value={cardSelection?.installmentCount ?? 1}
                      onChange={(event) =>
                        setInstallmentCount(Number(event.target.value))
                      }
                    >
                      {cardOptions.map((option) => (
                        <option
                          key={option.installmentCount}
                          value={option.installmentCount}
                        >
                          {option.installmentCount === 1
                            ? "À vista"
                            : `${option.installmentCount} parcelas`}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              {method === "CREDIT_CARD" && cardOptions?.length === 1 && (
                <p className="m-0 text-xs text-admin-text-secondary">
                  Somente cartão à vista disponível nesta simulação.
                </p>
              )}
              <dl className="m-0 grid gap-1.5">
                <PreviewRow
                  label="Valor cadastrado"
                  value={money(nominalCents)}
                />
                <PreviewRow
                  label={installments ? "Taxas à vista" : "Taxas"}
                  value={money(
                    item?.processingCents == null
                      ? null
                      : item.commissionCents + item.processingCents,
                  )}
                />
                {installments && (
                  <PreviewRow
                    label={
                      installments.installmentSurchargeCents < 0
                        ? "Desconto no parcelamento"
                        : "Acréscimo do parcelamento"
                    }
                    value={money(
                      Math.abs(installments.installmentSurchargeCents),
                    )}
                  />
                )}
                <div className="my-0.5 border-t border-admin-border" />
                <PreviewRow
                  label="Total do convidado"
                  value={money(
                    selected?.totalCents ?? item?.totalCents ?? null,
                  )}
                  strong
                />
                {amounts &&
                  (adjustedLast ? (
                    <>
                      <PreviewRow
                        label={
                          amounts.length === 2
                            ? "Primeira parcela"
                            : `Primeiras ${amounts.length - 1} parcelas`
                        }
                        value={`${money(amounts[0])}${amounts.length === 2 ? "" : " cada"}`}
                      />
                      <PreviewRow
                        label="Última parcela"
                        value={money(amounts[amounts.length - 1])}
                      />
                    </>
                  ) : (
                    <PreviewRow
                      label="Parcelas"
                      value={`${amounts.length}x de ${money(amounts[0])}`}
                    />
                  ))}
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
        As taxas e o ajuste do parcelamento já estão incluídos no total do
        convidado. O líquido do casal fica disponível conforme o Asaas libera o
        pagamento ou as parcelas.
      </p>
    </div>
  );
}
