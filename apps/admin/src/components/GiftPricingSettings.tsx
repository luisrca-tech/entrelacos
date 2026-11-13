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
  useMemo,
  useState,
} from "react";
import { z } from "zod";
import { AdminButton } from "./AdminButton";
import { AdminDialogContent } from "./AdminDialog";

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
  "O convidado paga as taxas: você recebe 100% do valor do presente.";

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
  hint,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: "success";
  hint?: string;
}) {
  return (
    <div className="flex min-w-0 flex-wrap justify-between gap-x-3 gap-y-0.5">
      <dt className={strong ? "font-bold text-admin-text" : "text-admin-text"}>
        {label}
        {hint && (
          <button
            type="button"
            aria-label={hint}
            title={hint}
            className="ml-1 cursor-help rounded-full border border-admin-border px-1.5 text-xs font-normal"
          >
            i
          </button>
        )}
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
            O convidado escolhe a forma de pagamento e o parcelamento na hora de
            pagar.
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

const feesTooltip = "Inclui a taxa do meio de pagamento e o serviço Entrelaços";
// Installment plans shown in the simulation; the guest still picks any plan.
const simulatedInstallments = [1, 6, 12];

function PricingComparison({
  nominalCents,
  estimate,
  title,
}: {
  nominalCents: number | null;
  estimate: GiftPricingEstimate | null;
  title?: string;
}) {
  const pix = estimate?.methods.find((method) => method.method === "PIX");
  const card = estimate?.methods.find(
    (method) => method.method === "CREDIT_CARD",
  );
  const rows =
    nominalCents === null || !estimate
      ? []
      : [
          {
            label: "Pix",
            totalCents: pix?.available ? pix.totalCents : null,
          },
          ...simulatedInstallments.flatMap((count) => {
            const option = card?.installmentOptions?.find(
              (candidate) => candidate.installmentCount === count,
            );
            if (!option && count !== 1) return [];
            return [
              {
                label: count === 1 ? "Cartão à vista" : `Cartão em ${count}x`,
                totalCents: option?.totalCents ?? card?.totalCents ?? null,
              },
            ];
          }),
        ];
  const fees = rows.flatMap((row) =>
    row.totalCents === null || nominalCents === null
      ? []
      : [row.totalCents - nominalCents],
  );
  const feeRange =
    fees.length === 0
      ? null
      : Math.min(...fees) === Math.max(...fees)
        ? money(fees[0])
        : `de ${money(Math.min(...fees))} a ${money(Math.max(...fees))}`;
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
        <>
          <dl className="m-0 grid gap-1.5">
            <PreviewRow
              label="Você recebe"
              value={`${money(nominalCents)} (100%)`}
              strong
              tone="success"
            />
          </dl>
          <section aria-label="Total do convidado" className="grid gap-1.5">
            <h3 className="m-0 text-xs font-bold uppercase tracking-[0.06em] text-admin-text-secondary">
              O convidado paga
            </h3>
            <dl className="m-0 grid gap-1.5">
              {rows.map((row) => (
                <PreviewRow
                  key={row.label}
                  label={row.label}
                  value={money(row.totalCents)}
                />
              ))}
              <div className="my-0.5 border-t border-admin-border" />
              <PreviewRow
                label="Taxas pagas pelo convidado"
                value={feeRange ?? "Indisponível"}
                hint={feesTooltip}
              />
            </dl>
          </section>
          {card?.installmentOptions?.length === 1 && (
            <p className="m-0 text-xs text-admin-text-secondary">
              Somente cartão à vista disponível nesta simulação.
            </p>
          )}
        </>
      )}
      <p className="m-0 text-xs leading-[1.5] text-admin-text-secondary">
        Você recebe o valor de cada parcela conforme o cartão libera,
        normalmente em até 32 dias por parcela; no Pix, assim que o pagamento é
        confirmado.
      </p>
    </div>
  );
}
