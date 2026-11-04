import { Button } from "@entrelacos/ui";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { z } from "zod";

export type FeeAllocation = "RECIPIENT_DEDUCTED" | "BUYER_GROSS_UP";
const allocation = z.enum(["RECIPIENT_DEDUCTED", "BUYER_GROSS_UP"]);
const settingsSchema = z.object({
  siteId: z.string(),
  feeAllocation: allocation,
  revision: z.number().int().nonnegative(),
  buyerGrossUpAvailable: z.literal(false),
  sandboxBuyerGrossUpAvailable: z.literal(true).optional(),
  blockedReason: z.string().min(1),
});
export type PricingSettings = z.infer<typeof settingsSchema>;
export function parsePricingSettings(
  value: unknown,
  siteId: string,
): PricingSettings {
  const parsed = z.object({ settings: settingsSchema }).parse(value).settings;
  if (parsed.siteId !== siteId) throw new Error("Pricing site changed");
  return parsed;
}
const cents = z.number().int().nonnegative().safe();
const previewSchema = z.object({
  siteId: z.string(),
  feeAllocation: allocation,
  guaranteed: z.literal(false),
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
  feeAllocation: FeeAllocation,
) {
  const parsed = previewSchema.parse(value);
  if (
    parsed.siteId !== siteId ||
    parsed.feeAllocation !== feeAllocation ||
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
type PricingControls = {
  busy: boolean;
  error: string;
  pending: FeeAllocation | null;
  savedSettings: PricingSettings | null;
  gifts: { nominalCents: number }[];
  select: (mode: FeeAllocation) => void;
  cancel: () => void;
  retry: () => void;
  save: (mode?: FeeAllocation) => Promise<boolean>;
};
const PricingContext = createContext<{
  hidden?: boolean;
  settings: PricingSettings | null;
  request: Request;
  siteId: string;
  isCurrent: () => boolean;
  controls?: PricingControls;
} | null>(null);
export const money = (value: number | null) =>
  value === null
    ? "Indisponível"
    : new Intl.NumberFormat("pt-BR", {
        style: "currency",
        currency: "BRL",
      }).format(value / 100);
export function useGiftFeeAllocation() {
  const context = useContext(PricingContext);
  return context
    ? (context.settings?.feeAllocation ?? null)
    : "RECIPIENT_DEDUCTED";
}
// Settings for a chooser rendered anywhere below the provider.
export function useGiftPricingControls() {
  const context = useContext(PricingContext);
  return context?.hidden ? null : (context?.controls ?? null);
}
export const feeAllocationOptions = [
  {
    mode: "BUYER_GROSS_UP",
    title: "O convidado",
    summary: "O convidado — taxas somadas ao valor",
    description:
      "As taxas são somadas ao valor na hora do pagamento. Vocês recebem perto do valor cadastrado.",
  },
  {
    mode: "RECIPIENT_DEDUCTED",
    title: "Nós, o casal",
    summary: "Nós, o casal — taxas descontadas do valor",
    description:
      "O convidado paga exatamente o valor cadastrado. As taxas são descontadas do que vocês recebem.",
  },
] as const;

export function GiftPricingSettings({
  enabled = true,
  siteId,
  request,
  isCurrent,
  gifts,
  children,
}: {
  enabled?: boolean;
  siteId: string;
  request: Request;
  isCurrent: () => boolean;
  gifts: { nominalCents: number }[];
  children: ReactNode;
}) {
  const [settings, setSettings] = useState<PricingSettings | null>(null);
  const [pending, setPending] = useState<FeeAllocation | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const mounted = useRef(false);
  const endpoint = `/v1/sites/${encodeURIComponent(siteId)}/gift-pricing-settings`;
  useEffect(() => {
    if (!enabled) return;
    void retry;
    mounted.current = true;
    const abort = new AbortController();
    setBusy(true);
    setSettings(null);
    setError("");
    void request(endpoint, { signal: abort.signal })
      .then((value) => {
        if (!abort.signal.aborted && isCurrent())
          setSettings(parsePricingSettings(value, siteId));
      })
      .catch(() => {
        if (!abort.signal.aborted && isCurrent())
          setError(
            "Não foi possível carregar as taxas. Simulações indisponíveis.",
          );
      })
      .finally(() => {
        if (!abort.signal.aborted && isCurrent()) setBusy(false);
      });
    return () => {
      mounted.current = false;
      abort.abort();
    };
  }, [enabled, endpoint, request, isCurrent, retry, siteId]);
  const save = useCallback(
    async (mode?: FeeAllocation) => {
      const target = mode ?? pending;
      if (!settings || !target || busy || !isCurrent()) return false;
      setBusy(true);
      setError("");
      try {
        const value = await request(endpoint, {
          method: "PATCH",
          body: { feeAllocation: target, revision: settings.revision },
        });
        if (mounted.current && isCurrent()) {
          setSettings(parsePricingSettings(value, siteId));
          setPending(null);
        }
        return true;
      } catch {
        if (mounted.current && isCurrent()) {
          setSettings(null);
          setPending(null);
          setError(
            "Não foi possível confirmar a preferência. Atualize antes de tentar novamente.",
          );
        }
        return false;
      } finally {
        if (mounted.current && isCurrent()) setBusy(false);
      }
    },
    [settings, pending, busy, isCurrent, request, endpoint, siteId],
  );
  const contextValue = useMemo(
    () => ({
      settings: busy || error ? null : settings,
      request,
      siteId,
      isCurrent,
      controls: {
        busy,
        error,
        pending,
        savedSettings: settings,
        gifts,
        select: (mode: FeeAllocation) =>
          setPending(mode === settings?.feeAllocation ? null : mode),
        cancel: () => setPending(null),
        retry: () => setRetry((value) => value + 1),
        save,
      },
    }),
    [settings, busy, error, request, siteId, isCurrent, pending, gifts, save],
  );
  return (
    <PricingContext.Provider
      value={enabled ? contextValue : { ...contextValue, hidden: true }}
    >
      {children}
    </PricingContext.Provider>
  );
}

// Couple-facing summary of the saved preference ("Quem paga as taxas").
export function GiftFeeSummary() {
  const controls = useGiftPricingControls();
  if (!controls) return null;
  const saved = controls.savedSettings;
  return (
    <span>
      {controls.busy && !saved
        ? "Consultando…"
        : saved && !controls.error
          ? feeAllocationOptions.find(
              ({ mode }) => mode === saved.feeAllocation,
            )?.summary
          : "Indisponível"}
    </span>
  );
}

export function GiftFeeAllocationChooser({
  legend = "Quem paga as taxas dos presentes?",
}: {
  legend?: string;
}) {
  const controls = useGiftPricingControls();
  if (!controls) return null;
  const { busy, error, pending, savedSettings: settings, gifts } = controls;
  const values = gifts.map((g) => g.nominalCents);
  const selected = pending ?? settings?.feeAllocation;
  return (
    <section
      className="grid min-w-0 gap-4"
      aria-label="Taxas dos presentes"
      aria-busy={busy}
    >
      {busy && (
        <p role="status" className="m-0 text-sm text-admin-muted">
          Carregando ou salvando preferência…
        </p>
      )}
      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-[10px] bg-admin-danger-wash p-3 text-sm text-admin-danger-ink"
        >
          {error}
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={controls.retry}
          >
            Tentar novamente
          </Button>
        </div>
      )}
      <fieldset
        disabled={busy || !settings || Boolean(error)}
        className="m-0 grid min-w-0 gap-3 border-0 p-0"
      >
        <legend className="sr-only">{legend}</legend>
        {feeAllocationOptions.map((option) => {
          const checked = selected === option.mode;
          return (
            <label
              key={option.mode}
              className={`flex min-w-0 cursor-pointer items-start gap-3 rounded-[14px] border p-4 transition-colors motion-reduce:transition-none has-[:focus-visible]:outline-[3px] has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[rgb(168_77_57_/_30%)] ${checked ? "border-2 border-admin-terracotta bg-admin-terracotta-wash" : "border-admin-line-strong bg-admin-surface hover:bg-admin-canvas"}`}
            >
              <input
                type="radio"
                name="gift-fee-allocation"
                className="mt-1 size-[18px] shrink-0 accent-admin-terracotta"
                checked={checked}
                onChange={() => controls.select(option.mode)}
              />
              <span className="grid min-w-0 gap-1">
                <span className="text-base font-bold text-admin-ink">
                  {option.title}
                </span>
                <span className="text-sm leading-[1.5] text-admin-body">
                  {option.description}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>
      {settings?.feeAllocation === "BUYER_GROSS_UP" && !pending && (
        <p
          role="status"
          className="m-0 rounded-[10px] bg-admin-pending-wash p-3 text-sm text-admin-pending-ink"
        >
          {settings.sandboxBuyerGrossUpAvailable
            ? "Homologação Sandbox disponível. Não representa liberação comercial nem garantia de líquido."
            : "Novos pagamentos pausados até a validação das tarifas e da política de diferenças."}
        </p>
      )}
      {pending && (
        <section
          className="grid min-w-0 gap-3 rounded-[14px] border border-admin-line bg-admin-canvas p-4 text-sm leading-[1.55] text-admin-body"
          aria-label="Confirmar impacto das taxas"
        >
          <p className="m-0 font-semibold text-admin-ink">
            Alteração em todos os presentes.{" "}
            {values.length
              ? `Valores cadastrados: ${money(Math.min(...values))}${Math.min(...values) !== Math.max(...values) ? ` a ${money(Math.max(...values))}` : ""}.`
              : "Ainda não há presentes cadastrados."}
          </p>
          <p className="m-0">
            {pending === "BUYER_GROSS_UP"
              ? "Os valores cadastrados passam a representar o líquido pretendido do casal, sem garantia. Confira abaixo os totais estimados para o convidado."
              : "Os valores cadastrados passam a representar exatamente o total que o convidado pagará. O líquido do casal é estimado e depende das tarifas."}{" "}
            {pending === "BUYER_GROSS_UP"
              ? settings?.sandboxBuyerGrossUpAvailable
                ? "Esta escolha permite somente testes no Sandbox. Divergências de recebimento continuam em conciliação, sem ajuste automático."
                : "Esta escolha pausa novos pagamentos até a validação das tarifas e da política de diferenças."
              : "Esta escolha mantém os pagamentos pelo valor nominal, com as taxas descontadas do casal."}
          </p>
          {[
            ...new Set(
              values.length ? [Math.min(...values), Math.max(...values)] : [],
            ),
          ].map((nominalCents) => (
            <GiftPricingPreview
              key={`${pending}:${nominalCents}`}
              nominalCents={nominalCents}
              feeAllocation={pending}
            />
          ))}
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              disabled={busy}
              onClick={() => void controls.save()}
            >
              {pending === "BUYER_GROSS_UP"
                ? settings?.sandboxBuyerGrossUpAvailable
                  ? "Confirmar homologação Sandbox"
                  : "Confirmar e pausar novos pagamentos"
                : "Confirmar preferência"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={controls.cancel}
            >
              Cancelar
            </Button>
          </div>
        </section>
      )}
    </section>
  );
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
      <dt className={strong ? "font-bold text-admin-ink" : "text-admin-body"}>
        {label}
      </dt>
      <dd
        className={`m-0 text-right ${strong ? "font-bold" : ""} ${tone === "success" ? "text-admin-success-ink" : "text-admin-ink"}`}
      >
        {value}
      </dd>
    </div>
  );
}

export function GiftPricingPreview({
  nominalCents,
  feeAllocation: requestedFeeAllocation,
  title,
}: {
  nominalCents: number | null;
  feeAllocation?: FeeAllocation;
  title?: string;
}) {
  const context = useContext(PricingContext);
  const feeAllocation =
    requestedFeeAllocation ?? context?.settings?.feeAllocation;
  const [preview, setPreview] = useState<{
    key: string;
    value: z.infer<typeof previewSchema>;
  } | null>(null);
  const key = JSON.stringify([
    context?.siteId,
    context?.settings?.revision,
    feeAllocation,
    nominalCents,
  ]);
  useEffect(() => {
    const abort = new AbortController();
    setPreview(null);
    if (
      !context?.settings ||
      !feeAllocation ||
      nominalCents === null ||
      !context.isCurrent()
    )
      return;
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
        const parsed = parsePricingPreview(
          value,
          siteId,
          nominalCents,
          feeAllocation,
        );
        if (!abort.signal.aborted && isCurrent())
          setPreview({ key, value: parsed });
      })
      .catch(() => {});
    return () => abort.abort();
  }, [key, context, nominalCents, feeAllocation]);
  if (context?.hidden) return null;
  const current =
    context?.settings && context.isCurrent() && preview?.key === key
      ? preview.value
      : null;
  const buyerPays = feeAllocation === "BUYER_GROSS_UP";
  return (
    <div
      aria-live="polite"
      className="grid min-w-0 gap-3 rounded-[14px] bg-admin-canvas p-4 text-sm"
    >
      {title && <p className="m-0 font-bold text-admin-ink">{title}</p>}
      {nominalCents === null ? (
        <p className="m-0 text-admin-muted">
          Informe um valor válido para simular.
        </p>
      ) : (
        (["PIX", "CREDIT_CARD"] as const).map((method) => {
          const item = current?.methods.find((m) => m.method === method);
          const guestTotal =
            feeAllocation === "RECIPIENT_DEDUCTED"
              ? nominalCents
              : (item?.totalCents ?? null);
          return (
            <section
              key={method}
              aria-label={method === "PIX" ? "Pix" : "Cartão à vista"}
              className="grid min-w-0 gap-1.5"
            >
              <h4 className="m-0 text-xs font-bold uppercase tracking-[0.06em] text-admin-muted">
                {method === "PIX" ? "Pix" : "Cartão à vista"}
              </h4>
              <dl className="m-0 grid gap-1.5">
                <PreviewRow
                  label="Valor cadastrado"
                  value={money(nominalCents)}
                />
                <PreviewRow
                  label="Comissão Entrelacos (2%)"
                  value={money(item?.commissionCents ?? null)}
                />
                <PreviewRow
                  label="Processamento Asaas"
                  value={money(item?.processingCents ?? null)}
                />
                <div className="my-0.5 border-t border-admin-line" />
                <PreviewRow
                  label="Total do convidado"
                  value={money(guestTotal)}
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
      <p className="m-0 text-xs leading-[1.5] text-admin-muted">
        Simulação estimada, sem garantia.{" "}
        {buyerPays
          ? context?.settings?.sandboxBuyerGrossUpAvailable
            ? "Homologação Sandbox. Franquias gratuitas não são prometidas; o líquido efetivo será conferido no recebimento."
            : "Novos pagamentos pausados até a validação das tarifas e da política de diferenças."
          : "O convidado paga o valor cadastrado. O líquido do casal depende das tarifas de pagamento."}
      </p>
    </div>
  );
}
