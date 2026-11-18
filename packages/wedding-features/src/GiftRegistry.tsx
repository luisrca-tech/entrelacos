import type {
  GiftCheckoutStatus,
  GiftQuote,
  PublicGiftCatalogPageResponse,
  PublicGiftItem,
} from "@entrelacos/contracts";
import {
  giftCheckoutCreateInputSchema,
  publicGiftCatalogQuerySchema,
} from "@entrelacos/contracts";
import { giftPaymentsEnabled } from "@entrelacos/ui";
import { toast } from "@entrelacos/ui/toast";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { GiftCatalogView } from "./GiftCatalogView";
import { GiftQuoteView } from "./GiftQuoteView";
import { GiftRecoveryView } from "./GiftRecoveryView";
import type { GiftCheckoutFormInput } from "./giftCheckoutForm";
import { recoverGiftCheckout } from "./giftCheckoutRecovery";
import {
  createGiftCheckoutState,
  giftCheckoutReducer,
} from "./giftCheckoutState";
import {
  createGiftCheckoutRecoveryToken,
  discardPendingGiftCheckout,
  loadPendingGiftCheckout,
  writePendingGiftCheckout,
} from "./giftCheckoutStorage";
import {
  giftCheckoutRequest,
  submitGiftCheckout,
} from "./giftCheckoutSubmission";
import {
  getGiftErrorMessage,
  WeddingGiftsApi,
  type WeddingGiftsApiOptions,
} from "./gifts";
import {
  createPagarmeCardToken,
  PagarmeCardTokenError,
  pagarmePublicKey,
} from "./pagarmeCardToken";
import { SiteDialog } from "./SiteDialog";

type Catalog = PublicGiftCatalogPageResponse;
type CatalogOwner = {
  active: boolean;
  controller: AbortController | null;
  pending: (() => void) | null;
};
export type GiftRegistryProps = WeddingGiftsApiOptions & {
  /** Overrides the build-time PUBLIC_PAGARME_PUBLIC_KEY (local preview). */
  pagarmePublicKey?: string;
};

const finalPaymentStates = new Set(["RECEIVED", "REFUNDED", "CLOSED_UNPAID"]);
/** Status checks per opening of the payment dialog. */
const maxPaymentChecks = 10;
/** 3s, 6s, 12s… between checks while the payment dialog stays open. */
export function paymentCheckDelay(completedChecks: number): number {
  return Math.min(3000 * 2 ** (completedChecks - 1), 60000);
}
const paymentConfirmedMessage = "Pagamento confirmado. Obrigado pelo presente!";
const paymentRefundedMessage = "Este pagamento foi reembolsado.";
const paymentClosedMessage =
  "O pagamento não foi concluído. Você pode tentar novamente.";
const paymentUnknownMessage =
  "Pagamento em verificação. Acompanhe pelo botão “Ver pagamento”.";
const paymentFallbackButtonClass =
  "cursor-pointer border-0 bg-transparent p-0 font-[inherit] font-medium text-template-ink underline underline-offset-[0.2rem] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-template-ink";

const fetcherIds = new WeakMap<typeof fetch, number>();
let nextFetcherId = 1;

function fetcherIdentity(fetcher?: typeof fetch): number {
  if (!fetcher) return 0;
  let id = fetcherIds.get(fetcher);
  if (id === undefined) {
    id = nextFetcherId++;
    fetcherIds.set(fetcher, id);
  }
  return id;
}

export function GiftRegistry(props: GiftRegistryProps) {
  return (
    <GiftRegistryCatalogOwner
      runtimeKey={JSON.stringify([
        props.apiOrigin,
        props.siteId,
        props.demo === true,
        props.liveDemoSiteId ?? null,
        fetcherIdentity(props.fetcher),
      ])}
      {...props}
    />
  );
}

function GiftRegistryCatalogOwner({
  runtimeKey,
  ...props
}: GiftRegistryProps & { runtimeKey: string }) {
  const owner = useRef<CatalogOwner>({
    active: false,
    controller: null,
    pending: null,
  });
  return (
    <GiftRegistryRuntime key={runtimeKey} {...props} catalogOwner={owner} />
  );
}

function GiftRegistryRuntime({
  siteId,
  apiOrigin,
  fetcher,
  demo = false,
  liveDemoSiteId,
  pagarmePublicKey: publicKeyOverride,
  catalogOwner,
}: GiftRegistryProps & { catalogOwner: { current: CatalogOwner } }) {
  const publicKey = publicKeyOverride ?? pagarmePublicKey();
  const api = useMemo(() => {
    try {
      return new WeddingGiftsApi({
        siteId,
        apiOrigin,
        fetcher,
        demo,
        liveDemoSiteId,
      });
    } catch {
      return null;
    }
  }, [siteId, apiOrigin, fetcher, demo, liveDemoSiteId]);
  const root = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const recoveryInFlight = useRef(false);
  const recoveryEpoch = useRef(0);
  const recoveryAction = useRef<() => Promise<string | undefined>>(
    async () => undefined,
  );
  const mounted = useRef(true);
  const activeApi = useRef(api);
  activeApi.current = api;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      recoveryEpoch.current++;
    };
  }, []);
  const [catalog, setCatalog] = useState<{
    api: WeddingGiftsApi;
    value: Catalog;
    generation: number;
  } | null>(null);
  const catalogGeneration = useRef(0);
  const catalogFailureNotified = useRef(false);
  const catalogActions = useRef<{
    page: (page: number) => void;
  } | null>(null);
  const [catalogPage, setCatalogPage] = useState(1);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState(false);
  const [catalogShown, setCatalogShown] = useState(false);
  const [state, dispatch] = useReducer(
    giftCheckoutReducer,
    undefined,
    createGiftCheckoutState,
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [operationError, setOperationError] = useState("");
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [recoveryError, setRecoveryError] = useState(false);
  // Build-time switch: when off, gifts stay listed but no checkout starts or resumes.
  const paymentsEnabled = giftPaymentsEnabled();
  const recovering = state.phase === "UNKNOWN";
  const currentCatalog = catalog?.api === api ? catalog.value : null;
  const pendingGiftId = recovering ? (state.pending?.giftId ?? null) : null;
  const pendingGift =
    (pendingGiftId &&
      currentCatalog?.mode !== "demonstration" &&
      currentCatalog?.gifts.find((gift) => gift.id === pendingGiftId)) ||
    null;
  const [preparing, setPreparing] = useState(false);
  const outcomePending = recovering || state.phase === "CREATING";
  const visible =
    (catalogShown && currentCatalog?.mode !== "disabled") ||
    recovering ||
    state.checkoutStatus !== null;

  useEffect(() => {
    const surface = root.current?.closest<HTMLElement>("[data-gift-section]");
    if (surface) surface.hidden = !visible;
    return () => {
      if (surface) surface.hidden = true;
    };
  }, [visible]);

  useEffect(() => {
    // The saved attempt stays untouched so it resumes once payments return.
    if (!paymentsEnabled) return;
    try {
      const pending = loadPendingGiftCheckout(
        () => window.sessionStorage,
        siteId,
      );
      if (pending) dispatch({ type: "RESTORE_UNKNOWN", siteId, pending });
    } catch {
      dispatch({ type: "RESTORE_UNKNOWN" });
    }
  }, [siteId, paymentsEnabled]);

  useEffect(() => {
    setCatalog(null);
    dispatch({ type: "CLOSE" });
    setDialogOpen(false);
  }, []);

  useEffect(() => {
    let active = true;
    let query = { page: 1, q: "" };
    const owner = catalogOwner.current;
    if (!api) return;
    const invalidate = () => {
      const generation = ++catalogGeneration.current;
      setCatalogLoading(true);
      setCatalogError(false);
      owner.pending = null;
      owner.controller?.abort();
      return generation;
    };
    const intentCurrent = (generation: number) =>
      active &&
      mounted.current &&
      activeApi.current === api &&
      generation === catalogGeneration.current;
    const run = () => {
      if (!active || !mounted.current || activeApi.current !== api) return;
      if (owner.active) {
        owner.pending = run;
        return;
      }
      owner.active = true;
      const controller = new AbortController();
      owner.controller = controller;
      const generation = catalogGeneration.current;
      const requested = { ...query };
      const current = () =>
        active &&
        mounted.current &&
        activeApi.current === api &&
        generation === catalogGeneration.current &&
        !controller.signal.aborted;
      void (async () => {
        try {
          const value = await api.getCatalog(requested, controller.signal);
          if (current()) {
            setCatalog({ api, value, generation });
            if (value.gifts.length && value.mode !== "disabled")
              setCatalogShown(true);
            setCatalogLoading(false);
            setCatalogError(false);
            catalogFailureNotified.current = false;
          }
        } catch {
          if (current()) {
            setCatalogLoading(false);
            setCatalogError(true);
            if (!catalogFailureNotified.current) {
              catalogFailureNotified.current = true;
              toast.error("Não foi possível carregar os presentes agora.");
            }
          }
        } finally {
          owner.active = false;
          owner.controller = null;
          const latest = owner.pending;
          owner.pending = null;
          latest?.();
        }
      })();
    };
    catalogActions.current = {
      page: (page) => {
        if (!active) return;
        const parsed = publicGiftCatalogQuerySchema.safeParse({
          ...query,
          page,
        });
        if (!parsed.success) return;
        const generation = invalidate();
        if (!intentCurrent(generation)) return;
        query = parsed.data;
        setCatalogPage(page);
        run();
      },
    };
    const refresh = () => {
      if (!owner.active) run();
    };
    run();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      catalogGeneration.current++;
      catalogActions.current = null;
      if (owner.pending === run) owner.pending = null;
      owner.controller?.abort();
      window.removeEventListener("focus", refresh);
    };
  }, [api, catalogOwner]);

  useEffect(() => {
    if (!api || !state.gift || !state.method || state.phase !== "QUOTING")
      return;
    let active = true;
    const revision = state.revision;
    void api
      .quoteGift({
        giftId: state.gift.id,
        method: state.method,
        ...(state.method === "CREDIT_CARD" && state.installmentCount > 1
          ? { installmentCount: state.installmentCount }
          : {}),
      })
      .then((quote) => {
        if (active) dispatch({ type: "QUOTE_RESOLVED", quote, revision });
      })
      .catch((error) => {
        if (active)
          dispatch({
            type: "QUOTE_FAILED",
            message: getGiftErrorMessage(error),
            revision,
          });
      });
    return () => {
      active = false;
    };
  }, [
    api,
    state.gift,
    state.method,
    state.installmentCount,
    state.phase,
    state.revision,
  ]);

  function chooseGift(gift: PublicGiftItem) {
    if (
      !paymentsEnabled ||
      outcomePending ||
      catalogLoading ||
      catalogError ||
      catalog?.generation !== catalogGeneration.current
    )
      return;
    dispatch({ type: "SELECT_GIFT", gift });
    setOperationError("");
    setDialogOpen(true);
  }
  function chooseMethod(
    method: GiftQuote["method"],
    installmentCount?: number,
  ) {
    setOperationError("");
    dispatch({ type: "SELECT_METHOD", method, installmentCount });
  }
  async function recover(manual = false) {
    if (!api || !recovering || !state.pending || recoveryInFlight.current)
      return;
    recoveryInFlight.current = true;
    setRecoveryLoading(true);
    if (manual) setRecoveryError(false);
    const requestApi = api;
    const pending = state.pending;
    const epoch = recoveryEpoch.current;
    const current = () =>
      mounted.current &&
      activeApi.current === requestApi &&
      recoveryEpoch.current === epoch;
    try {
      const event = await recoverGiftCheckout(
        api,
        state,
        () => window.sessionStorage,
        current,
      );
      if (!current()) return;
      if (event?.type === "STATUS_RESOLVED") {
        dispatch(event);
        setRecoveryError(false);
        settle(event.status, pending);
        return event.status.state;
      }
      setRecoveryError(true);
    } catch {
      if (current()) setRecoveryError(true);
    } finally {
      recoveryInFlight.current = false;
      if (current()) setRecoveryLoading(false);
    }
  }

  // A final outcome leaves the list: forget the attempt and say so once.
  function settle(
    status: GiftCheckoutStatus,
    pending: NonNullable<typeof state.pending>,
  ) {
    if (!finalPaymentStates.has(status.state)) return;
    setPaymentOpen(false);
    if (status.state === "CLOSED_UNPAID") {
      // The recovery step already removed the marker.
      toast.warning(paymentClosedMessage);
      return;
    }
    try {
      discardPendingGiftCheckout(() => window.sessionStorage, siteId, pending);
    } catch {
      // A stale marker is checked once more on the next visit.
    }
    dispatch({ type: "SETTLED" });
    if (status.state === "REFUNDED") toast.warning(paymentRefundedMessage);
    else toast.success(paymentConfirmedMessage);
  }

  recoveryAction.current = recover;
  const pendingRequestId = state.pending?.requestId;
  useEffect(() => {
    if (state.phase === "UNKNOWN") setDialogOpen(false);
    else setPaymentOpen(false);
  }, [state.phase]);
  // One check when an attempt becomes pending: page load with a saved
  // attempt, a created checkout, or an unknown creation outcome.
  useEffect(() => {
    if (!api || state.phase !== "UNKNOWN" || !pendingRequestId) return;
    void recoveryAction.current();
  }, [api, state.phase, pendingRequestId]);
  // Further checks only while the guest keeps the payment dialog open.
  useEffect(() => {
    if (!api || !paymentOpen || state.phase !== "UNKNOWN" || !pendingRequestId)
      return;
    let active = true;
    let timer: number | undefined;
    let checks = 0;
    const check = async () => {
      const status = await recoveryAction.current();
      if (!active) return;
      checks++;
      if (checks < maxPaymentChecks && !finalPaymentStates.has(status ?? ""))
        timer = window.setTimeout(
          () => void check(),
          paymentCheckDelay(checks),
        );
    };
    void check();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [api, paymentOpen, state.phase, pendingRequestId]);

  async function checkout(input: GiftCheckoutFormInput) {
    if (!api || state.phase !== "READY" || !state.quote || inFlight.current)
      return;
    inFlight.current = true;
    setOperationError("");
    const quote = state.quote;
    const requestApi = api;
    const current = () => mounted.current && activeApi.current === requestApi;
    // Until the create request is sent, a failure returns to the form.
    let started = false;
    let sent = false;
    const backToForm = (message: string) => {
      if (!current()) return;
      dispatch({ type: "CHECKOUT_FAILED", message, unknown: false });
      setDialogOpen(true);
    };
    try {
      const requestId = state.requestId ?? crypto.randomUUID();
      const recoveryToken =
        state.recoveryToken ?? createGiftCheckoutRecoveryToken();
      const event = {
        type: "CHECKOUT_STARTED",
        requestId,
        recoveryToken,
        now: new Date().toISOString(),
      } as const;
      if (giftCheckoutReducer(state, event).phase !== "CREATING") {
        dispatch(event);
        return;
      }
      if ((quote.method === "CREDIT_CARD") !== (input.card !== undefined))
        return;
      // Lock the attempt before tokenizing: closing the dialog can no longer
      // reset it, so an order created afterwards is always shown.
      dispatch(event);
      started = true;
      // Tokenize first: nothing is reserved or charged if the card is refused
      // here, and only the token travels on to the Entrelaços API.
      let cardToken: string | undefined;
      if (input.card) {
        setPreparing(true);
        try {
          cardToken = await createPagarmeCardToken(input.card, {
            publicKey,
          });
        } catch (error) {
          backToForm(
            error instanceof PagarmeCardTokenError &&
              error.code === "CARD_INVALID"
              ? "Confira os dados do cartão."
              : "Não foi possível validar o cartão agora. Tente novamente ou use Pix.",
          );
          return;
        } finally {
          if (current()) setPreparing(false);
        }
        if (!current()) return;
      }
      const pending = {
        quoteId: quote.id,
        requestId,
        recoveryToken,
        giftId: quote.giftId,
        method: quote.method,
        mode: quote.mode,
      };
      const payment = { buyer: input.buyer, cardToken };
      if (
        !giftCheckoutCreateInputSchema.safeParse(
          giftCheckoutRequest(quote, pending, payment),
        ).success
      ) {
        backToForm("Confira os seus dados e tente novamente.");
        return;
      }
      writePendingGiftCheckout(window.sessionStorage, siteId, pending);
      sent = true;
      const result = await submitGiftCheckout(
        api,
        quote,
        pending,
        () => window.sessionStorage,
        current,
        payment,
      );
      if (result && current()) {
        dispatch(result);
        if (result.type === "CHECKOUT_RESOLVED") setPaymentOpen(true);
        else if (result.type === "CHECKOUT_FAILED" && result.rejected) {
          setDialogOpen(false);
          toast.error(result.message);
        } else if (result.type === "CHECKOUT_FAILED" && result.unknown)
          toast.warning(paymentUnknownMessage);
        else if (result.type === "CHECKOUT_FAILED") setDialogOpen(true);
      }
    } catch {
      const message =
        "Não foi possível preparar o pagamento com segurança. Tente novamente neste navegador.";
      if (started && !sent) backToForm(message);
      else setOperationError(message);
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <div ref={root} data-gift-runtime className="grid min-w-0 gap-5">
      {recovering && !pendingGift && (
        <p
          data-gift-payment-fallback
          className="m-0 text-sm text-template-muted"
        >
          Há um pagamento em andamento neste navegador.{" "}
          <button
            type="button"
            className={paymentFallbackButtonClass}
            aria-haspopup="dialog"
            onClick={() => setPaymentOpen(true)}
          >
            Ver pagamento
          </button>
        </p>
      )}
      {currentCatalog && (
        <GiftCatalogView
          recoveryOnly={recovering}
          paymentGiftId={pendingGift?.id ?? null}
          onViewPayment={() => setPaymentOpen(true)}
          gifts={currentCatalog.gifts}
          mode={currentCatalog.mode}
          busy={outcomePending || catalogLoading || catalogError}
          paymentsDisabled={!paymentsEnabled}
          onSelect={chooseGift}
          paging={
            catalogShown
              ? {
                  page: catalogPage,
                  total: currentCatalog.total,
                  totalPages: currentCatalog.totalPages,
                  loading: catalogLoading,
                  error: catalogError,
                  onPage: (page) => catalogActions.current?.page(page),
                }
              : undefined
          }
        />
      )}
      <SiteDialog
        open={dialogOpen && !!state.gift && state.phase !== "UNKNOWN"}
        labelledBy="gift-quote-heading"
        locked={state.phase === "CREATING" || preparing}
        className="overflow-hidden p-0 [@media(max-width:760px)]:fixed [@media(max-width:760px)]:inset-0 [@media(max-width:760px)]:m-0 [@media(max-width:760px)]:h-dvh [@media(max-width:760px)]:max-h-dvh [@media(max-width:760px)]:w-full [@media(max-width:760px)]:max-w-none [@media(max-width:760px)]:rounded-none"
        onClose={() => {
          setDialogOpen(false);
          dispatch({ type: "CLOSE" });
        }}
      >
        {(requestClose) =>
          !dialogOpen || state.phase === "UNKNOWN" ? null : (
            <GiftQuoteView
              quote={state.quote}
              method={state.method}
              installmentCount={state.installmentCount}
              loading={state.phase === "QUOTING"}
              pending={state.phase === "CREATING" || preparing}
              error={operationError || state.error || undefined}
              notice={state.notice ?? undefined}
              onSelectMethod={chooseMethod}
              onConfirm={(input) => void checkout(input)}
              onCancel={requestClose}
            />
          )
        }
      </SiteDialog>
      <SiteDialog
        open={paymentOpen && recovering}
        labelledBy="gift-payment-heading"
        className="w-[min(32rem,calc(100vw-2rem))] [@media(max-width:560px)]:m-auto [@media(max-width:560px)]:h-auto [@media(max-width:560px)]:max-h-[calc(100dvh-2rem)] [@media(max-width:560px)]:w-[calc(100vw-2rem)] [@media(max-width:560px)]:rounded-2xl"
        onClose={() => setPaymentOpen(false)}
      >
        {(requestClose) =>
          paymentOpen && recovering ? (
            <GiftRecoveryView
              siteId={siteId}
              status={state.checkoutStatus}
              pix={state.checkout?.pix ?? null}
              loading={recoveryLoading}
              error={!api || !state.pending || recoveryError}
              canRetry={!!api && !!state.pending}
              onRetry={() => void recover(true)}
              headingId="gift-payment-heading"
              giftTitle={pendingGift?.title}
              onClose={requestClose}
            />
          ) : null
        }
      </SiteDialog>
    </div>
  );
}
