import {
  meResponseSchema,
  type SiteAccess,
  type WithdrawalIntent,
  type WithdrawalPreviewInput,
  type WithdrawalRequestContext,
  type WithdrawalRequestStatus,
} from "@entrelacos/contracts";
import { Button, showSandboxNotice, toast } from "@entrelacos/ui";
import { type FormEvent, useLayoutEffect, useRef, useState } from "react";
import { ApiError, apiRequest } from "../lib/apiClient";
import {
  FinancialReauthenticationForm,
  type FinancialReauthenticationHandle,
} from "./FinancialReauthenticationForm";
import {
  type FinancialReauthenticationGuard,
  financialReauthenticationScopeKey,
} from "./financialReauthenticationClient";
import { parseGiftPriceToCents } from "./GiftEditorView";
import { type createPanelActorOwner, panelActorOwner } from "./panelActor";
import {
  compareWithdrawalContexts,
  compareWithdrawalObservations,
  loadWithdrawalContext,
  loadWithdrawalRequest,
  postWithdrawalAction,
  previewWithdrawal,
  readWithdrawalMarker,
  removeWithdrawalMarker,
  sealWithdrawalRequest,
  type WithdrawalMarker,
  type WithdrawalStorage,
  type WithdrawalTransport,
  writeWithdrawalMarker,
} from "./withdrawalClient";

export type WithdrawalSetupScope = {
  siteId: string;
  access: SiteAccess | null;
  sessionEpoch: number | null;
};
export type WithdrawalSetupPorts = {
  owner?: ReturnType<typeof createPanelActorOwner>;
  request?: WithdrawalTransport;
  storage?: WithdrawalStorage;
  now?: () => number;
  newRequestId?: () => string;
};
export type WithdrawalSetupState = {
  status:
    | "idle"
    | "loading"
    | "ready"
    | "denied"
    | "unavailable"
    | "storage_unavailable";
  context: WithdrawalRequestContext | null;
  request: WithdrawalRequestStatus | null;
  acknowledgment: WithdrawalIntent | null;
  uncertain: boolean;
  busy: boolean;
  proofRevision: number;
  discovery: Discovery;
};
type Action = "CONFIRM_NEW" | "RECOVER_EXISTING" | "SEAL";
type Discovery = {
  status: "idle" | "loading" | "ready" | "unavailable";
  requests: WithdrawalRequestStatus[];
  nextCursor: string | null;
  error: string;
};
type PageReadSlot = { pending: object | null };
function emptyDiscovery(): Discovery {
  return { status: "idle", requests: [], nextCursor: null, error: "" };
}

export function createWithdrawalSetupController(
  scope: WithdrawalSetupScope,
  onState: (state: WithdrawalSetupState) => void,
  ports: WithdrawalSetupPorts = {},
  pageSlot: PageReadSlot = { pending: null },
  onFinancialChange?: () => void,
) {
  const capturedPorts = {
    owner: ports.owner,
    request: ports.request,
    storage: ports.storage,
    now: ports.now,
  };
  const nativeFetch = globalThis.fetch;
  const owner = capturedPorts.owner ?? panelActorOwner;
  const now = ports.now ?? (() => Date.now());
  const captured = owner.getSnapshot();
  const scopeKey = financialReauthenticationScopeKey({
    ...scope,
    action: "REQUEST_WITHDRAWAL",
  });
  let state: WithdrawalSetupState = {
    status: "idle",
    context: null,
    request: null,
    acknowledgment: null,
    uncertain: false,
    busy: false,
    proofRevision: 0,
    discovery: emptyDiscovery(),
  };
  let disposed = false;
  let invalidated = false;
  let revision = 0;
  let busy = false;
  let refreshing: Promise<void> | null = null;
  let validation: Promise<boolean> | null = null;
  let selectedId: string | null = null;
  let mode: "sandbox" | "live" | null = null;
  let marker: WithdrawalMarker | null = null;
  let floor: WithdrawalRequestStatus | null = null;
  const latestRequests = new Map<string, WithdrawalRequestStatus>();
  const knownRequests = new Map<string, WithdrawalRequestStatus>();
  let discoveryAnchor: WithdrawalRequestContext | null = null;
  let discoveryGeneration = 0;
  let discoveryObservedAt = 0;
  const usedCursors = new Set<string>();
  let pageAbort: AbortController | null = null;
  let selecting = false;
  const acknowledgedRequests = new Map<string, WithdrawalIntent>();
  let storageReady = false;
  let observedClock = 0;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let deadlineKey: string | null = null;
  let expiredKey: string | null = null;
  const listeners = new Set<() => void>();
  function clockCurrent(time: number) {
    return (
      Number.isSafeInteger(time) &&
      time >= observedClock &&
      time >= 0 &&
      !!captured.actor &&
      Date.parse(captured.actor.session.expiresAt) > time
    );
  }
  function frame(sampleClock = true) {
    try {
      const livePorts = {
        owner: ports.owner,
        request: ports.request,
        storage: ports.storage,
        now: ports.now,
      };
      const time = sampleClock ? now() : observedClock;
      const selected = captured.actor?.memberships?.find(
        (value) =>
          value.siteId === scope.siteId &&
          value.userId === captured.actor?.user.id,
      );
      const liveKey = financialReauthenticationScopeKey({
        ...scope,
        access: selected ?? null,
        action: "REQUEST_WITHDRAWAL",
      });
      const finalPorts = {
        now: ports.now,
        storage: ports.storage,
        request: ports.request,
        owner: ports.owner,
      };
      const native = owner.getSnapshot();
      const actualOwner = ports.owner ?? panelActorOwner;
      const valid =
        !disposed &&
        !invalidated &&
        !!scopeKey &&
        livePorts.owner === capturedPorts.owner &&
        livePorts.request === capturedPorts.request &&
        livePorts.storage === capturedPorts.storage &&
        livePorts.now === capturedPorts.now &&
        finalPorts.owner === capturedPorts.owner &&
        finalPorts.request === capturedPorts.request &&
        finalPorts.storage === capturedPorts.storage &&
        finalPorts.now === capturedPorts.now &&
        actualOwner === owner &&
        captured.status === "verified" &&
        captured.actor !== null &&
        captured.sessionEpoch === scope.sessionEpoch &&
        native === captured &&
        clockCurrent(time) &&
        liveKey === scopeKey &&
        !disposed &&
        !invalidated;
      if (valid) observedClock = time;
      return valid;
    } catch {
      return false;
    }
  }
  function publish(next: WithdrawalSetupState) {
    state = next;
    if (!disposed) onState(structuredClone(next));
  }
  function discard() {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {}
    }
  }
  function invalidate() {
    if (disposed || invalidated) return;
    invalidated = true;
    pageAbort?.abort();
    revision++;
    validation = null;
    refreshing = null;
    if (deadline !== null) clearTimeout(deadline);
    deadline = null;
    discard();
    publish({
      ...state,
      status: "denied",
      discovery: emptyDiscovery(),
      context: null,
      request: null,
      acknowledgment: null,
      busy: false,
      proofRevision: state.proofRevision + 1,
    });
  }
  function current() {
    try {
      if (frame()) {
        const time = now();
        if (clockCurrent(time)) {
          observedClock = time;
          if (frame() && !disposed && !invalidated) return true;
        }
      }
    } catch {
      // A failed clock sample cannot lower the accepted observation floor.
    }
    invalidate();
    return false;
  }
  function storage(): WithdrawalStorage {
    return ports.storage ?? window.localStorage;
  }
  function fail(cause: unknown, authentication = false) {
    if (!current()) return;
    if (cause instanceof ApiError && [401, 403].includes(cause.status))
      owner.reportFailure(cause, scope.sessionEpoch);
    else if (authentication) owner.invalidate();
    if (!current()) return;
    discard();
    publish({
      ...state,
      status: "unavailable",
      busy: false,
      proofRevision: state.proofRevision + 1,
    });
  }
  function storageFailure() {
    if (!current()) return;
    storageReady = false;
    discard();
    publish({
      ...state,
      status: "storage_unavailable",
      busy: false,
      proofRevision: state.proofRevision + 1,
    });
  }
  function notifyResult(
    action: Action | "PREVIEW" | "REFRESH",
    succeeded: boolean,
    cause?: unknown,
    expectedRevision = revision,
  ) {
    if (!current() || revision !== expectedRevision) return;
    if (succeeded && action !== "PREVIEW") {
      try {
        onFinancialChange?.();
      } catch {
        // Read invalidation cannot change the acknowledged financial outcome.
      }
      if (!current() || revision !== expectedRevision) return;
    }
    if (!succeeded) {
      const errors: Record<string, string> = {
        RECENT_AUTH_REQUIRED: "Confirme sua senha antes de continuar.",
        FEE_QUOTE_UNAVAILABLE:
          "Não foi possível consultar a taxa. Consulte a situação antes de tentar novamente.",
        PROVIDER_BALANCE_UNAVAILABLE:
          "Não foi possível verificar o saldo. Consulte a situação novamente.",
        INSUFFICIENT_FUNDS:
          "Saldo insuficiente para o valor solicitado e a taxa.",
        DESTINATION_UNVERIFIED:
          "Confira o destino em Recebimento antes de solicitar o saque.",
        FINANCIAL_EVENTS_UNRESOLVED:
          "Existem movimentações em verificação. Aguarde e consulte a situação.",
        REQUEST_CONFLICT:
          "Os termos mudaram. Consulte a solicitação original antes de continuar.",
      };
      toast.error(
        state.status === "storage_unavailable"
          ? "Não foi possível preservar a referência. As ações estão bloqueadas."
          : (cause instanceof ApiError && errors[cause.code]) ||
              (action === "PREVIEW"
                ? "Não foi possível consultar a prévia. Consulte a situação antes de tentar novamente."
                : action === "REFRESH"
                  ? "Não foi possível verificar a situação do saque. Consulte novamente."
                  : "Não foi possível confirmar o resultado. Consulte a solicitação original antes de tentar novamente."),
      );
      return;
    }
    if (action === "PREVIEW" && state.request?.state === "OPEN") {
      toast.success(
        "Prévia pronta. Confira o destino, os valores e a validade antes de confirmar.",
      );
      return;
    }
    if (state.request?.state === "SEALED_NOT_CREATED") {
      toast.success("Solicitação encerrada sem reserva.");
      return;
    }
    const withdrawal =
      state.acknowledgment ??
      (state.request?.state === "EXISTING" ? state.request.withdrawal : null);
    if (
      withdrawal?.state === "UNKNOWN" ||
      state.request?.state === "UNRESOLVED"
    )
      toast.warning(
        "Resultado em verificação. Consulte a solicitação original antes de qualquer nova tentativa.",
      );
    else if (
      withdrawal?.state === "FAILED" ||
      withdrawal?.state === "CANCELLED"
    )
      toast.error(
        "O saque não foi concluído. Consulte a solicitação original.",
      );
    else if (withdrawal?.state === "COMPLETED")
      toast.success("Saque concluído pelo provedor.");
    else if (withdrawal)
      toast.success(
        "Solicitação registrada. A transferência ainda não foi concluída.",
      );
    else if (state.request?.state === "OPEN")
      toast.success("Prévia disponível. Confira os termos antes de confirmar.");
    else if (state.uncertain)
      toast.warning(
        "A referência foi preservada. Consulte a situação antes de qualquer nova tentativa.",
      );
    else if (state.context?.newRequestAllowed)
      toast.success("Situação atualizada. Você pode consultar uma prévia.");
    else
      toast.warning(
        "Saque indisponível. Confira o recebimento e consulte a situação novamente.",
      );
  }
  function validateContext(next: WithdrawalRequestContext) {
    if (Date.parse(next.observedAt) > now())
      throw new Error("Future withdrawal context");
    if (mode && next.mode !== mode)
      throw new Error("Withdrawal environment changed");
    if (
      state.context &&
      ["older", "incomparable"].includes(
        compareWithdrawalContexts(state.context, next),
      )
    )
      throw new Error("Withdrawal context changed");
    if (!current()) throw new Error("Withdrawal context owner changed");
  }
  function installContext(
    next: WithdrawalRequestContext,
    restart = false,
    validated = false,
  ) {
    const active = revision;
    if (!validated) validateContext(next);
    const same =
      discoveryAnchor &&
      compareWithdrawalContexts(discoveryAnchor, next) === "same";
    if (restart || !same) {
      let validRows = true;
      try {
        if (!validated) validateRows(next.recoverableRequests, null);
      } catch {
        validRows = false;
      }
      if (!validated && (!current() || active !== revision))
        throw new Error("Withdrawal discovery owner changed");
      discoveryGeneration++;
      discoveryAnchor = structuredClone(next);
      usedCursors.clear();
      if (validRows) {
        rememberRows(next.recoverableRequests);
        state = {
          ...state,
          discovery: {
            status: "ready",
            requests: structuredClone(next.recoverableRequests),
            nextCursor: next.nextCursor,
            error: "",
          },
        };
      } else {
        state = {
          ...state,
          discovery: {
            ...emptyDiscovery(),
            status: "unavailable",
            error: "Não foi possível verificar o histórico de solicitações.",
          },
        };
      }
    }
    discoveryObservedAt = Math.max(
      discoveryObservedAt,
      Date.parse(next.observedAt),
    );
    mode = next.mode;
    state = { ...state, context: next };
  }
  function validateObservation(next: WithdrawalRequestStatus) {
    const time = now();
    if (!current()) throw new Error("Withdrawal observation owner changed");
    if (Date.parse(next.observedAt) > time)
      throw new Error("Future withdrawal observation");

    const acknowledgment = acknowledgedRequests.get(next.requestId);
    if (
      acknowledgment &&
      (next.state === "OPEN" ||
        next.state === "SEALED_NOT_CREATED" ||
        (next.state === "EXISTING" &&
          [
            "id",
            "siteId",
            "mode",
            "amountCents",
            "feeCents",
            "feeSemantics",
            "netCents",
            "destinationVersion",
            "createdAt",
          ].some(
            (field) =>
              next.withdrawal[field as keyof WithdrawalIntent] !==
              acknowledgment[field as keyof WithdrawalIntent],
          )))
    )
      throw new Error("Acknowledged withdrawal history changed");
    const latest = latestRequests.get(next.requestId);
    if (
      latest &&
      ["older", "incomparable"].includes(
        compareWithdrawalObservations(latest, next),
      )
    )
      throw new Error("Latest withdrawal observation changed");
    if (
      floor &&
      floor.requestId === next.requestId &&
      ["older", "incomparable"].includes(
        compareWithdrawalObservations(floor, next),
      )
    )
      throw new Error("Withdrawal observation changed");
    const known = knownRequests.get(next.requestId);
    if (
      known &&
      next.state !== "UNRESOLVED" &&
      ((known.state === "EXISTING" && next.state !== "EXISTING") ||
        (known.state === "SEALED_NOT_CREATED" &&
          next.state !== "SEALED_NOT_CREATED") ||
        ["older", "incomparable"].includes(
          compareWithdrawalObservations(known, next),
        ))
    )
      throw new Error("Known withdrawal history changed");
  }
  function rememberRows(rows: WithdrawalRequestStatus[]) {
    for (const next of rows) {
      latestRequests.set(next.requestId, structuredClone(next));
      if (next.state !== "UNRESOLVED")
        knownRequests.set(next.requestId, structuredClone(next));
    }
  }
  function validateRows(
    rows: WithdrawalRequestStatus[],
    boundary: string | null,
  ) {
    let previous = boundary;
    for (const row of rows) {
      if (
        row.state === "OPEN" ||
        (previous !== null && row.requestId <= previous)
      )
        throw new Error("Withdrawal discovery order changed");
      validateObservation(row);
      previous = row.requestId;
    }
  }
  function installRequest(next: WithdrawalRequestStatus, validated = false) {
    if (next.requestId !== selectedId || next.mode !== mode)
      throw new Error("Withdrawal request changed");
    if (!validated) validateObservation(next);
    rememberRows([next]);
    floor = structuredClone(next);
    state = {
      ...state,
      request: next,
      acknowledgment: null,
      uncertain:
        next.state === "UNRESOLVED" ||
        (next.state === "EXISTING" && next.withdrawal.state === "UNKNOWN"),
    };
    const nextKey = next.state === "OPEN" ? JSON.stringify(next.preview) : null;
    if (nextKey !== deadlineKey) {
      if (deadline !== null) clearTimeout(deadline);
      deadline = null;
      deadlineKey = nextKey;
      if (next.state === "OPEN") {
        const expires = Date.parse(next.preview.expiresAt);
        const expire = () => {
          if (!current() || deadlineKey !== nextKey) return;
          if (now() < expires) {
            deadline = setTimeout(
              expire,
              Math.min(expires - now(), 2147483647),
            );
            return;
          }
          deadline = null;
          expiredKey = nextKey;
          discard();
          publish({ ...state, proofRevision: state.proofRevision + 1 });
        };
        if (now() >= expires) expiredKey = nextKey;
        else
          deadline = setTimeout(expire, Math.min(expires - now(), 2147483647));
      }
    }
  }
  function scopedMarker(requestId: string): WithdrawalMarker {
    if (!mode || !captured.actor)
      throw new Error("Withdrawal scope unavailable");
    return {
      version: 1,
      siteId: scope.siteId,
      operatorUserId: captured.actor.user.id,
      mode,
      requestId,
    };
  }
  function persist(requestId: string, previewInput?: WithdrawalPreviewInput) {
    const next: WithdrawalMarker = previewInput
      ? { ...scopedMarker(requestId), version: 2, previewInput }
      : marker?.requestId === requestId
        ? marker
        : scopedMarker(requestId);
    writeWithdrawalMarker(storage(), next);
    marker = next;
    storageReady = true;
  }
  function canNew() {
    return (
      current() &&
      storageReady &&
      state.status === "ready" &&
      !!state.context?.newRequestAllowed &&
      !state.uncertain &&
      state.request?.state !== "OPEN" &&
      state.request?.state !== "UNRESOLVED" &&
      !(
        state.request?.state === "EXISTING" &&
        state.request.withdrawal.state === "UNKNOWN"
      )
    );
  }
  function termsCurrent() {
    const preview =
      state.request?.state === "OPEN" ? state.request.preview : null;
    const time = now();
    return (
      preview !== null &&
      JSON.stringify(preview) !== expiredKey &&
      time >= Date.parse(preview.issuedAt) &&
      time < Date.parse(preview.expiresAt)
    );
  }
  async function compareServer(): Promise<boolean> {
    if (!current()) return false;
    const active = revision;
    let authentication = true;
    try {
      const fresh = meResponseSchema.parse(
        await (ports.request ?? apiRequest)("/v1/me"),
      );
      if (!current() || revision !== active) return false;
      if (
        JSON.stringify(fresh) !== JSON.stringify(captured.actor) ||
        Date.parse(fresh.session.expiresAt) <= now()
      )
        throw new Error("Administrative session changed");
      authentication = false;
      const context = await loadWithdrawalContext(scope.siteId, ports.request);
      if (!current() || revision !== active) return false;
      installContext(context);
      if (selectedId) {
        const next = await loadWithdrawalRequest(
          scope.siteId,
          selectedId,
          ports.request,
        );
        if (!current() || revision !== active) return false;
        if (next.scopeRevision !== context.scopeRevision)
          throw new Error("Withdrawal scope observation changed");
        installRequest(next);
        if (
          next.state === "OPEN" &&
          context.openRequest?.requestId !== selectedId
        )
          throw new Error("Withdrawal preview no longer current");
      }
      return current();
    } catch (cause) {
      if (revision === active) fail(cause, authentication);
      return false;
    }
  }
  const guard: FinancialReauthenticationGuard = {
    isCurrent() {
      return (
        frame() &&
        storageReady &&
        state.status === "ready" &&
        !!state.request &&
        state.request.state !== "SEALED_NOT_CREATED" &&
        (state.request.state === "EXISTING" || !state.uncertain)
      );
    },
    validate() {
      if (!guard.isCurrent()) return Promise.resolve(false);
      if (validation) return validation;
      const active = revision;
      const work = Promise.resolve()
        .then(async () => {
          if (!guard.isCurrent() || active !== revision) return false;
          const valid = await compareServer();
          if (disposed || invalidated || active !== revision) return false;
          const stillCurrent = guard.isCurrent();
          if (disposed || invalidated || active !== revision) return false;
          if (!valid || !stillCurrent) {
            discard();
            return false;
          }
          publish({ ...state });
          return true;
        })
        .finally(() => {
          if (validation === work) validation = null;
        });
      validation = work;
      return work;
    },
    subscribeInvalidation(listener) {
      listeners.add(listener);
      if (!guard.isCurrent()) listener();
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const unsubscribe = owner.subscribe(() => {
    if (!frame()) invalidate();
  });
  function refresh(requestId?: string, feedback = false): Promise<void> {
    if (!current() || busy) return Promise.resolve();
    if (refreshing) return refreshing;
    const active = ++revision;
    validation = null;
    let failure: unknown;
    const work = Promise.resolve()
      .then(async () => {
        if (!current() || active !== revision) return;
        try {
          const context = await loadWithdrawalContext(
            scope.siteId,
            ports.request,
          );
          if (!current() || active !== revision) return;
          installContext(context, true);
          try {
            marker = readWithdrawalMarker(
              storage(),
              scope.siteId,
              captured.actor?.user.id ?? "",
            );
            if (marker && marker.mode !== mode)
              throw new Error("Withdrawal marker scope changed");
            if (marker) state = { ...state, uncertain: true };
            storageReady = true;
          } catch {
            storageFailure();
            return;
          }
          if (!current() || active !== revision) return;
          const id =
            requestId ??
            marker?.requestId ??
            selectedId ??
            context.openRequest?.requestId ??
            null;
          if (marker && id !== marker.requestId) {
            if (selectedId !== marker.requestId) {
              selectedId = marker.requestId;
              floor = latestRequests.get(marker.requestId) ?? null;
              state = { ...state, request: null };
            }
            if (!(await compareServer()) || !current() || active !== revision)
              return;
            if (
              !state.request ||
              state.uncertain ||
              !["EXISTING", "SEALED_NOT_CREATED"].includes(state.request.state)
            )
              throw new Error("Retained withdrawal differs");
            if (!removeWithdrawalMarker(storage(), marker)) {
              storageFailure();
              return;
            }
            marker = null;
            if (!current() || active !== revision) return;
          }
          if (id) {
            if (selectedId !== id) {
              floor = latestRequests.get(id) ?? null;
              selectedId = id;
            }
            const next = await loadWithdrawalRequest(
              scope.siteId,
              id,
              ports.request,
            );
            if (!current() || active !== revision) return;
            if (next.scopeRevision !== context.scopeRevision)
              throw new Error("Withdrawal scope observation changed");
            installRequest(next);
          }
          publish({ ...state, status: "ready", busy: false });
        } catch (cause) {
          failure = cause;
          if (active === revision) fail(cause);
        }
      })
      .finally(() => {
        if (refreshing === work) refreshing = null;
        if (feedback && current() && active === revision)
          notifyResult("REFRESH", state.status === "ready", failure, active);
      });
    refreshing = work;
    pageAbort?.abort();
    if (!current() || active !== revision) return work;
    discard();
    publish({
      ...state,
      status: "loading",
      acknowledgment: null,
      busy: false,
      proofRevision: state.proofRevision + 1,
    });
    return work;
  }
  function pageCurrent(
    active: number,
    generation: number,
    operation: object,
    allowAborted = false,
  ) {
    const valid = current();
    return (
      valid &&
      !disposed &&
      !invalidated &&
      revision === active &&
      discoveryGeneration === generation &&
      pageSlot.pending === operation &&
      pageAbort !== null &&
      (allowAborted || !pageAbort.signal.aborted)
    );
  }
  function loadMore(issuedCursor?: string): Promise<boolean> {
    if (
      !current() ||
      busy ||
      refreshing ||
      selecting ||
      pageSlot.pending ||
      state.status !== "ready" ||
      !discoveryAnchor ||
      !state.discovery.nextCursor
    )
      return Promise.resolve(false);
    const cursor = state.discovery.nextCursor;
    if (
      (issuedCursor !== undefined && issuedCursor !== cursor) ||
      usedCursors.has(cursor)
    )
      return Promise.resolve(false);
    const active = revision;
    const generation = discoveryGeneration;
    const anchor = structuredClone(discoveryAnchor);
    const operation = {};
    const lifetime = new AbortController();
    pageSlot.pending = operation;
    pageAbort = lifetime;
    function valid() {
      return pageCurrent(active, generation, operation);
    }
    async function read(
      path: string,
      options?: Parameters<WithdrawalTransport>[1],
    ) {
      const child = new AbortController();
      const abort = () => child.abort();
      lifetime.signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => {
        if (valid()) {
          child.abort();
          lifetime.abort();
          if (!pageCurrent(active, generation, operation, true)) return;
          publish({
            ...state,
            discovery: {
              ...state.discovery,
              status: "unavailable",
              error:
                "A consulta demorou demais. Consulte novamente após o término da leitura.",
            },
          });
          if (valid())
            toast.error(
              "A consulta demorou demais. Aguarde o término da leitura para consultar novamente.",
            );
        } else child.abort();
      }, 45000);
      try {
        if (!valid()) throw new Error("Withdrawal reader no longer current");
        const result = capturedPorts.request
          ? await capturedPorts.request(path, {
              ...options,
              signal: child.signal,
            })
          : await apiRequest(path, options, (url, init) =>
              nativeFetch(url, { ...init, signal: child.signal }),
            );
        if (!valid() || child.signal.aborted)
          throw new Error("Withdrawal read expired");
        return result;
      } finally {
        clearTimeout(timeout);
        lifetime.signal.removeEventListener("abort", abort);
      }
    }
    // Reserve before notifying consumers; no subsequent click is queued.
    const work = Promise.resolve()
      .then(async () => {
        try {
          if (!valid()) return false;
          const fresh = meResponseSchema.parse(await read("/v1/me"));
          if (!valid()) return false;
          const time = now();
          if (!valid()) return false;
          if (
            JSON.stringify(fresh) !== JSON.stringify(captured.actor) ||
            Date.parse(fresh.session.expiresAt) <= time
          ) {
            const revoke = owner.invalidate;
            if (valid()) revoke.call(owner);
            return false;
          }
          const page = await loadWithdrawalContext(scope.siteId, read, cursor);
          if (!valid()) return false;
          const head = await loadWithdrawalContext(scope.siteId, read);
          if (!valid()) return false;
          if (
            compareWithdrawalContexts(state.context ?? anchor, head) !==
              "same" ||
            page.siteId !== anchor.siteId ||
            page.mode !== anchor.mode ||
            page.scopeRevision !== anchor.scopeRevision ||
            JSON.stringify(page.observationOrder) !==
              JSON.stringify(anchor.observationOrder) ||
            page.newRequestAllowed !== anchor.newRequestAllowed ||
            page.reason !== anchor.reason ||
            Date.parse(page.observedAt) < discoveryObservedAt ||
            Date.parse(head.observedAt) < Date.parse(page.observedAt) ||
            Date.parse(head.observedAt) > now() ||
            (anchor.openRequest === null
              ? page.openRequest !== null
              : page.openRequest === null ||
                compareWithdrawalObservations(
                  anchor.openRequest,
                  page.openRequest,
                ) !== "same" ||
                head.openRequest === null ||
                compareWithdrawalObservations(
                  page.openRequest,
                  head.openRequest,
                ) !== "same") ||
            (page.nextCursor !== null &&
              (page.nextCursor === cursor ||
                usedCursors.has(page.nextCursor))) ||
            (page.recoverableRequests.length === 0 && page.nextCursor !== null)
          )
            throw new Error("Withdrawal discovery confirmation changed");
          for (const value of [page, head]) {
            if (value.openRequest) {
              validateObservation(value.openRequest);
              if (
                Date.parse(value.openRequest.observedAt) >
                Date.parse(value.observedAt)
              )
                throw new Error("Withdrawal OPEN time changed");
            }
            if (
              value.recoverableRequests.some(
                (row) =>
                  Date.parse(row.observedAt) > Date.parse(value.observedAt),
              )
            )
              throw new Error("Withdrawal discovery time changed");
          }
          validateRows(head.recoverableRequests, null);
          const rows = state.discovery.requests;
          const boundary = rows.at(-1)?.requestId ?? null;
          const ids = new Set(rows.map((row) => row.requestId));
          if (page.recoverableRequests.some((row) => ids.has(row.requestId)))
            throw new Error("Withdrawal discovery overlaps");
          validateRows(page.recoverableRequests, boundary);
          if (!valid()) return false;
          rememberRows(page.recoverableRequests);
          usedCursors.add(cursor);
          discoveryObservedAt = Date.parse(head.observedAt);
          publish({
            ...state,
            discovery: {
              status: "ready",
              requests: [...rows, ...structuredClone(page.recoverableRequests)],
              nextCursor: page.nextCursor,
              error: "",
            },
          });
          return valid();
        } catch (cause) {
          if (!valid()) return false;
          if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
            const report = owner.reportFailure;
            if (valid()) report.call(owner, cause, scope.sessionEpoch);
            if (current()) invalidate();
            return false;
          }
          publish({
            ...state,
            discovery: {
              ...state.discovery,
              status: "unavailable",
              error:
                "Não foi possível verificar outras solicitações. Consulte novamente.",
            },
          });
          if (valid())
            toast.error(
              "Não foi possível consultar outras solicitações. Consulte novamente.",
            );
          return false;
        }
      })
      .finally(() => {
        if (pageSlot.pending === operation) pageSlot.pending = null;
        if (pageAbort === lifetime) pageAbort = null;
      });
    publish({
      ...state,
      discovery: { ...state.discovery, status: "loading", error: "" },
    });
    return work;
  }
  async function selectDiscoveredRequest(requestId: string): Promise<boolean> {
    if (
      !current() ||
      busy ||
      refreshing ||
      selecting ||
      pageSlot.pending ||
      state.status !== "ready" ||
      !state.discovery.requests.some((row) => row.requestId === requestId) ||
      (state.uncertain && selectedId !== requestId)
    )
      return false;
    selecting = true;
    const admission = revision;
    let active = admission;
    let quarantined = false;
    try {
      const retainedStorage = storage();
      const retained = readWithdrawalMarker(
        retainedStorage,
        scope.siteId,
        captured.actor?.user.id ?? "",
      );
      if (
        !current() ||
        admission !== revision ||
        (retained &&
          (retained.mode !== mode || retained.requestId !== requestId))
      )
        return false;
      if (!current() || admission !== revision) return false;
      active = ++revision;
      validation = null;
      quarantined = true;
      discard();
      if (!current() || active !== revision) return false;
      publish({
        ...state,
        status: "loading",
        acknowledgment: null,
        proofRevision: state.proofRevision + 1,
      });
      if (!current() || active !== revision) return false;
      const context = await loadWithdrawalContext(
        scope.siteId,
        capturedPorts.request,
      );
      if (!current() || active !== revision) return false;
      if (
        !state.context ||
        ["older", "incomparable"].includes(
          compareWithdrawalContexts(state.context, context),
        )
      )
        throw new Error("Withdrawal context changed");
      const next = await loadWithdrawalRequest(
        scope.siteId,
        requestId,
        capturedPorts.request,
      );
      if (!current() || active !== revision) return false;
      if (
        next.state === "OPEN" ||
        next.scopeRevision !== context.scopeRevision ||
        next.mode !== context.mode
      )
        throw new Error("Discovered withdrawal scope changed");
      validateObservation(next);
      if (!current() || active !== revision) return false;
      validateContext(context);
      if (context.openRequest) validateObservation(context.openRequest);
      validateRows(context.recoverableRequests, null);
      const canonicalRow = context.recoverableRequests.find(
        (row) => row.requestId === requestId,
      );
      if (
        canonicalRow &&
        ["older", "incomparable"].includes(
          compareWithdrawalObservations(canonicalRow, next),
        )
      )
        throw new Error("Exact withdrawal predates its canonical observation");
      if (!current() || active !== revision) return false;
      const latestMarker = readWithdrawalMarker(
        retainedStorage,
        scope.siteId,
        captured.actor?.user.id ?? "",
      );
      if (!current() || active !== revision) return false;
      // Repeat after clock/owner callbacks, then finish with private admission checks.
      const finalMarker = readWithdrawalMarker(
        retainedStorage,
        scope.siteId,
        captured.actor?.user.id ?? "",
      );
      if (
        !frame(false) ||
        disposed ||
        invalidated ||
        active !== revision ||
        JSON.stringify(retained) !== JSON.stringify(latestMarker) ||
        JSON.stringify(retained) !== JSON.stringify(finalMarker)
      )
        throw new Error("Retained withdrawal changed during selection");
      const committedMarker = readWithdrawalMarker(
        retainedStorage,
        scope.siteId,
        captured.actor?.user.id ?? "",
      );
      // This final native fence intentionally does not call the clock port again.
      const native = owner.getSnapshot();
      const actualOwner = ports.owner ?? panelActorOwner;
      if (
        disposed ||
        invalidated ||
        active !== revision ||
        native !== captured ||
        actualOwner !== owner ||
        JSON.stringify(retained) !== JSON.stringify(committedMarker)
      )
        throw new Error("Retained withdrawal changed after owner comparison");
      installContext(context, false, true);
      selectedId = requestId;
      floor = latestRequests.get(requestId) ?? null;
      installRequest(next, true);
      publish({ ...state, status: "ready" });
      return current() && active === revision;
    } catch (cause) {
      if (active === revision) {
        if (quarantined) fail(cause);
        else if (current()) storageFailure();
      }
      return false;
    } finally {
      selecting = false;
      if (current() && active === revision && quarantined)
        notifyResult("REFRESH", state.status === "ready", undefined, active);
    }
  }
  async function preview(amount: string): Promise<boolean> {
    const amountCents = parseGiftPriceToCents(amount);
    if (!current() || busy) return false;
    if (amountCents === null) {
      toast.error("Informe um valor válido para o saque.");
      return false;
    }
    if (!canNew()) {
      toast.warning("Consulte a situação antes de solicitar uma nova prévia.");
      return false;
    }
    busy = true;
    publish({ ...state, busy: true });
    let dispatched = false;
    let succeeded = false;
    let failure: unknown;
    const active = revision;
    try {
      if (
        !(await compareServer()) ||
        !current() ||
        active !== revision ||
        !canNew()
      )
        return false;
      const context = state.context;
      if (!context) return false;
      const requestId = (ports.newRequestId ?? (() => crypto.randomUUID()))();
      if (
        requestId === selectedId ||
        latestRequests.has(requestId) ||
        knownRequests.has(requestId) ||
        context.recoverableRequests.some(
          (value) => value.requestId === requestId,
        )
      )
        throw new Error("New withdrawal identity repeats history");
      if (marker) {
        if (
          !state.request ||
          state.request.state === "UNRESOLVED" ||
          state.uncertain ||
          !removeWithdrawalMarker(storage(), marker)
        )
          throw new Error("Retained withdrawal cannot retire");
        marker = null;
      }
      const input = {
        requestId,
        amountCents,
        scopeRevision: context.scopeRevision,
      };
      try {
        persist(requestId, input);
      } catch {
        storageFailure();
        return false;
      }
      selectedId = requestId;
      floor = null;
      discard();
      publish({
        ...state,
        request: null,
        acknowledgment: null,
        uncertain: true,
        proofRevision: state.proofRevision + 1,
      });
      if (!current() || active !== revision) return false;
      dispatched = true;
      const result = await previewWithdrawal(
        scope.siteId,
        input,
        ports.request,
      );
      if (!current() || active !== revision) return false;
      installRequest(result);
      if (result.state === "OPEN" && result.preview.amountCents !== amountCents)
        throw new Error("Withdrawal amount changed");
      publish({ ...state, status: "ready" });
      succeeded = true;
      return true;
    } catch (cause) {
      failure = cause;
      if (current() && revision === active) {
        if (dispatched) publish({ ...state, uncertain: true });
        fail(cause);
      }
      return false;
    } finally {
      busy = false;
      if (current() && revision === active) {
        publish({ ...state, busy: false });
        notifyResult("PREVIEW", succeeded, failure, active);
      }
    }
  }
  function canResumePreview(ownsBusy = false) {
    const request = state.request;
    return (
      frame() &&
      storageReady &&
      (!busy || ownsBusy) &&
      !refreshing &&
      !validation &&
      !selecting &&
      !pageSlot.pending &&
      state.status === "ready" &&
      state.uncertain &&
      marker?.version === 2 &&
      marker.mode === mode &&
      marker.requestId === selectedId &&
      request?.requestId === selectedId &&
      request.state === "UNRESOLVED" &&
      request.command === null &&
      request.requestRevision === null &&
      request.observationOrder.recordUpdatedAtMicroseconds === null &&
      !knownRequests.has(request.requestId) &&
      state.context?.newRequestAllowed === true &&
      state.context.scopeRevision === marker.previewInput.scopeRevision &&
      request.scopeRevision === state.context.scopeRevision
    );
  }
  async function resumePreview(): Promise<boolean> {
    if (!current() || !canResumePreview() || marker?.version !== 2)
      return false;
    const retained = structuredClone(marker);
    const serialized = JSON.stringify(retained);
    const active = revision;
    busy = true;
    publish({ ...state, busy: true });
    let succeeded = false;
    let failure: unknown;
    try {
      if (!(await compareServer()) || !current() || active !== revision)
        return false;
      if (!canResumePreview(true) || !current() || active !== revision)
        return false;
      const stored = readWithdrawalMarker(
        storage(),
        scope.siteId,
        captured.actor?.user.id ?? "",
      );
      if (!current() || active !== revision) return false;
      const native = owner.getSnapshot();
      const actualOwner = ports.owner ?? panelActorOwner;
      const finalMarker = readWithdrawalMarker(
        storage(),
        scope.siteId,
        captured.actor?.user.id ?? "",
      );
      if (
        disposed ||
        invalidated ||
        actualOwner !== owner ||
        native !== captured ||
        active !== revision ||
        JSON.stringify(stored) !== serialized ||
        JSON.stringify(finalMarker) !== serialized ||
        JSON.stringify(marker) !== serialized
      ) {
        storageFailure();
        return false;
      }
      discard();
      publish({
        ...state,
        acknowledgment: null,
        proofRevision: state.proofRevision + 1,
      });
      if (!current() || active !== revision) return false;
      if (
        JSON.stringify(
          readWithdrawalMarker(
            storage(),
            scope.siteId,
            captured.actor?.user.id ?? "",
          ),
        ) !== serialized ||
        disposed ||
        invalidated ||
        active !== revision
      ) {
        storageFailure();
        return false;
      }
      const result = await previewWithdrawal(
        scope.siteId,
        retained.previewInput,
        capturedPorts.request,
      );
      if (!current() || active !== revision) return false;
      if (
        JSON.stringify(
          readWithdrawalMarker(
            storage(),
            scope.siteId,
            captured.actor?.user.id ?? "",
          ),
        ) !== serialized ||
        disposed ||
        invalidated ||
        active !== revision
      ) {
        storageFailure();
        return false;
      }
      installRequest(result);
      publish({ ...state, status: "ready" });
      succeeded = true;
      return true;
    } catch (cause) {
      failure = cause;
      if (current() && active === revision) fail(cause);
      return false;
    } finally {
      busy = false;
      if (current() && active === revision) {
        publish({ ...state, busy: false });
        notifyResult("PREVIEW", succeeded, failure, active);
      }
    }
  }
  async function act(
    action: Action,
    consumeProof: () => string | null,
    confirmed: boolean,
  ): Promise<boolean> {
    if (
      !confirmed ||
      busy ||
      !current() ||
      !guard.isCurrent() ||
      (action === "CONFIRM_NEW" && !termsCurrent()) ||
      (action === "RECOVER_EXISTING" && state.request?.state !== "EXISTING")
    ) {
      if (current() && !busy)
        toast.error(
          action === "CONFIRM_NEW" && !termsCurrent()
            ? "A prévia expirou. Encerre a solicitação original antes de consultar novos termos."
            : "Confira os termos e confirme sua senha antes de continuar.",
        );
      return false;
    }
    busy = true;
    publish({ ...state, busy: true });
    let dispatched = false;
    let succeeded = false;
    let failure: unknown;
    const active = revision;
    try {
      if (
        !(await guard.validate()) ||
        !current() ||
        active !== revision ||
        !state.request ||
        (action === "CONFIRM_NEW" &&
          (!termsCurrent() || state.request.state !== "OPEN")) ||
        (action === "RECOVER_EXISTING" && state.request.state !== "EXISTING")
      )
        return false;
      const retained = structuredClone(state.request);
      try {
        persist(retained.requestId);
      } catch {
        storageFailure();
        return false;
      }
      if (!current() || active !== revision) return false;
      const token = consumeProof();
      if (!token) {
        failure = new ApiError(403, "RECENT_AUTH_REQUIRED");
        return false;
      }
      if (!current() || active !== revision) return false;
      publish({
        ...state,
        uncertain: true,
        acknowledgment: null,
        proofRevision: state.proofRevision + 1,
      });
      discard();
      if (!current() || active !== revision) return false;
      if (
        JSON.stringify(
          readWithdrawalMarker(
            storage(),
            scope.siteId,
            captured.actor?.user.id ?? "",
          ),
        ) !== JSON.stringify(marker)
      ) {
        storageFailure();
        return false;
      }
      if (!current() || active !== revision) return false;
      dispatched = true;
      if (action === "SEAL") {
        const result = await sealWithdrawalRequest(
          scope.siteId,
          retained.requestId,
          token,
          ports.request,
        );
        if (!current() || active !== revision) return false;
        installRequest(result);
        if (result.state === "SEALED_NOT_CREATED") {
          if (!marker || !removeWithdrawalMarker(storage(), marker))
            throw new Error("Withdrawal marker changed");
          marker = null;
        }
        if (!current() || active !== revision) return false;
        publish({ ...state, status: "ready" });
      } else {
        const withdrawal = await postWithdrawalAction(
          scope.siteId,
          {
            action,
            requestId: retained.requestId,
            reauthenticationToken: token,
          },
          ports.request,
        );
        if (!current() || active !== revision) return false;
        const terms =
          retained.state === "OPEN"
            ? retained.preview
            : retained.state === "EXISTING"
              ? retained.withdrawal
              : null;
        if (
          !terms ||
          withdrawal.mode !== retained.mode ||
          withdrawal.amountCents !== terms.amountCents ||
          withdrawal.feeCents !== terms.feeCents ||
          withdrawal.feeSemantics !== terms.feeSemantics ||
          withdrawal.netCents !== terms.netCents ||
          withdrawal.destinationVersion !== terms.destinationVersion ||
          (retained.state === "EXISTING" &&
            withdrawal.id !== retained.withdrawal.id)
        )
          throw new Error("Withdrawal acknowledgment changed");
        acknowledgedRequests.set(
          retained.requestId,
          structuredClone(withdrawal),
        );
        publish({
          ...state,
          status: "ready",
          acknowledgment: withdrawal,
          uncertain: true,
        });
      }
      succeeded = true;
      return true;
    } catch (cause) {
      failure = cause;
      if (current() && revision === active) {
        if (dispatched) publish({ ...state, uncertain: true });
        fail(cause);
      }
      return false;
    } finally {
      busy = false;
      if (current() && active === revision) {
        publish({ ...state, busy: false });
        notifyResult(action, succeeded, failure, active);
      }
    }
  }
  if (!frame()) {
    invalidated = true;
    state = { ...state, status: "denied" };
  }
  return {
    guard,
    isBoundTo(
      renderedScope: WithdrawalSetupScope,
      renderedPorts: WithdrawalSetupPorts,
    ) {
      return (
        renderedPorts === ports &&
        financialReauthenticationScopeKey({
          ...renderedScope,
          action: "REQUEST_WITHDRAWAL",
        }) === scopeKey
      );
    },
    getState: (): WithdrawalSetupState =>
      structuredClone(
        frame()
          ? state
          : {
              ...state,
              status: "denied",
              context: null,
              request: null,
              acknowledgment: null,
              discovery: emptyDiscovery(),
            },
      ),
    loadMore,
    selectDiscoveredRequest,
    refresh,
    preview,
    canResumePreview: () => canResumePreview(),
    resumePreview,
    act,
    resetConsent() {
      if (!current()) return;
      discard();
      publish({ ...state, proofRevision: state.proofRevision + 1 });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pageAbort?.abort();
      revision++;
      if (deadline !== null) clearTimeout(deadline);
      deadline = null;
      unsubscribe();
      discard();
      listeners.clear();
      latestRequests.clear();
      knownRequests.clear();
      acknowledgedRequests.clear();
      floor = null;
      marker = null;
      state = {
        ...state,
        context: null,
        request: null,
        acknowledgment: null,
        discovery: emptyDiscovery(),
      };
    },
  };
}

const money = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});
export function WithdrawalSetup(
  props: WithdrawalSetupScope & {
    ports?: WithdrawalSetupPorts;
    onFinancialChange?: () => void;
  },
) {
  const pageSlot = useRef<PageReadSlot>({ pending: null });
  const key = financialReauthenticationScopeKey({
    ...props,
    action: "REQUEST_WITHDRAWAL",
  });
  return key ? (
    <WithdrawalSetupRuntime key={key} {...props} pageSlot={pageSlot.current} />
  ) : (
    <WithdrawalSetupView
      scope={props}
      state={{
        status: "denied",
        context: null,
        request: null,
        acknowledgment: null,
        uncertain: false,
        busy: false,
        proofRevision: 0,
        discovery: emptyDiscovery(),
      }}
      controller={null}
    />
  );
}
function WithdrawalSetupRuntime({
  siteId,
  access,
  sessionEpoch,
  ports,
  pageSlot,
  onFinancialChange,
}: WithdrawalSetupScope & {
  ports?: WithdrawalSetupPorts;
  pageSlot: PageReadSlot;
  onFinancialChange?: () => void;
}) {
  const defaultPorts = useRef<WithdrawalSetupPorts>({});
  const activePorts = ports ?? defaultPorts.current;
  const controller = useRef<ReturnType<
    typeof createWithdrawalSetupController
  > | null>(null);
  const [state, setState] = useState<WithdrawalSetupState>({
    status: "idle",
    context: null,
    request: null,
    acknowledgment: null,
    uncertain: false,
    busy: false,
    proofRevision: 0,
    discovery: emptyDiscovery(),
  });
  useLayoutEffect(() => {
    const next = createWithdrawalSetupController(
      { siteId, access, sessionEpoch },
      setState,
      activePorts,
      pageSlot,
      onFinancialChange,
    );
    controller.current = next;
    setState(next.getState());
    void next.refresh();
    return () => {
      next.dispose();
      if (controller.current === next) controller.current = null;
    };
  }, [siteId, access, sessionEpoch, activePorts, pageSlot, onFinancialChange]);
  const bound = controller.current?.isBoundTo(
    { siteId, access, sessionEpoch },
    activePorts,
  );
  const projected = bound
    ? (controller.current?.getState() ?? state)
    : {
        ...state,
        status: "denied" as const,
        context: null,
        request: null,
        acknowledgment: null,
        discovery: emptyDiscovery(),
      };
  return (
    <WithdrawalSetupView
      state={projected}
      scope={{ siteId, access, sessionEpoch }}
      controller={bound ? controller.current : null}
      ports={ports}
    />
  );
}

function WithdrawalSetupView({
  state,
  scope,
  controller,
  ports,
}: {
  state: WithdrawalSetupState;
  scope: WithdrawalSetupScope;
  controller: ReturnType<typeof createWithdrawalSetupController> | null;
  ports?: WithdrawalSetupPorts;
}) {
  const [amount, setAmount] = useState("");
  const preview =
    state.request?.state === "OPEN"
      ? state.request.preview
      : state.request?.state === "EXISTING"
        ? state.request.preview
        : null;
  const current = state.status === "ready" && !state.busy;
  const withdrawal =
    state.acknowledgment ??
    (state.request?.state === "EXISTING" ? state.request.withdrawal : null);
  return (
    <section
      className="grid gap-4 rounded-xl border border-admin-line bg-admin-surface p-6"
      aria-labelledby="withdrawal-setup-title"
    >
      <h2
        id="withdrawal-setup-title"
        className="m-0 font-admin-display text-2xl"
      >
        Solicitação de saque
      </h2>
      {(state.request?.mode ?? state.context?.mode) === "live" && (
        <p>Live — valores reais.</p>
      )}
      {showSandboxNotice(state.request?.mode ?? state.context?.mode) && (
        <p>Sandbox — valores de teste.</p>
      )}
      {state.status === "denied" && <p>Acesso financeiro restrito.</p>}
      {state.status === "storage_unavailable" && (
        <p>Ações bloqueadas: a referência não pôde ser preservada.</p>
      )}
      {state.uncertain && !withdrawal && (
        <p>Resultado em verificação. Consulte a situação.</p>
      )}
      {preview && (
        <dl>
          {[
            [
              preview.feeSemantics === "MAXIMUM"
                ? "Débito máximo aprovado"
                : "Valor solicitado",
              money.format(preview.amountCents / 100),
            ],
            [
              preview.feeSemantics === "MAXIMUM" ? "Taxa máxima" : "Taxa",
              money.format(preview.feeCents / 100),
            ],
            ["Valor líquido", money.format(preview.netCents / 100)],
            ["Destino verificado", preview.maskedDestination],
            ...(preview.payoutRecipientName
              ? [["Recebedor Pix", preview.payoutRecipientName]]
              : []),
            ["Nome no perfil", preview.operatorDisplayName],
            ["Validade da prévia", preview.expiresAt],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {preview?.feeSemantics === "MAXIMUM" && (
        <p>
          O valor líquido é fixo. A taxa efetiva pode ser menor que o limite; a
          reserva não utilizada volta ao saldo após a confirmação.
        </p>
      )}
      {!preview && state.request?.state === "EXISTING" && (
        <dl>
          {[
            [
              state.request.withdrawal.settlement
                ? "Valor debitado"
                : state.request.withdrawal.feeSemantics === "MAXIMUM"
                  ? "Débito máximo aprovado"
                  : "Valor solicitado",
              money.format(
                (state.request.withdrawal.settlement?.totalDebitCents ??
                  state.request.withdrawal.amountCents) / 100,
              ),
            ],
            [
              state.request.withdrawal.settlement
                ? "Taxa efetiva"
                : state.request.withdrawal.feeSemantics === "MAXIMUM"
                  ? "Taxa máxima"
                  : "Taxa",
              money.format(
                (state.request.withdrawal.settlement?.feeCents ??
                  state.request.withdrawal.feeCents) / 100,
              ),
            ],
            [
              "Valor líquido",
              money.format(state.request.withdrawal.netCents / 100),
            ],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {withdrawal && (
        <p>
          {withdrawal.state === "UNKNOWN"
            ? "Resultado em verificação. Consulte a solicitação original."
            : withdrawal.state === "COMPLETED"
              ? "Concluído pelo provedor."
              : withdrawal.state === "FAILED"
                ? "Saque não concluído."
                : withdrawal.state === "CANCELLED"
                  ? "Saque cancelado."
                  : "Solicitação original registrada. Transferência em acompanhamento."}
        </p>
      )}
      {state.request?.state === "EXISTING" &&
        state.request.preview === null && (
          <p>Os dados do destino original não estão disponíveis.</p>
        )}
      {state.request?.state === "SEALED_NOT_CREATED" && (
        <p>Solicitação encerrada sem reserva.</p>
      )}
      {state.status === "ready" &&
        state.context?.newRequestAllowed &&
        !state.uncertain &&
        state.request?.state !== "OPEN" && (
          <form
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              void controller?.preview(amount);
            }}
          >
            <label htmlFor="withdrawal-amount">
              Valor total solicitado, incluindo a taxa
            </label>
            <input
              id="withdrawal-amount"
              inputMode="decimal"
              value={amount}
              disabled={state.busy}
              onChange={(event) => {
                setAmount(event.target.value);
                controller?.resetConsent();
              }}
            />
            <Button type="submit" disabled={state.busy}>
              {state.busy ? "Consultando prévia…" : "Consultar prévia do saque"}
            </Button>
          </form>
        )}
      {(controller?.canResumePreview() ||
        (state.busy && state.request?.state === "UNRESOLVED")) && (
        <Button
          type="button"
          disabled={state.busy}
          onClick={() => void controller?.resumePreview()}
        >
          {state.busy ? "Retomando prévia…" : "Retomar prévia"}
        </Button>
      )}
      {state.request && controller?.guard.isCurrent() && (
        <WithdrawalActions
          key={state.proofRevision}
          controller={controller}
          scope={scope}
          ports={ports}
          state={state}
        />
      )}
      {!!scope.sessionEpoch && state.status !== "denied" && (
        <Button
          type="button"
          variant="outline"
          disabled={state.busy || state.status === "loading"}
          onClick={() => void controller?.refresh(undefined, true)}
        >
          {state.status === "loading"
            ? "Consultando…"
            : state.busy
              ? "Processando…"
              : "Consultar situação"}
        </Button>
      )}
      {state.discovery.requests.map((request) => (
        <Button
          key={request.requestId}
          type="button"
          variant="outline"
          disabled={state.busy}
          onClick={() =>
            void controller?.selectDiscoveredRequest(request.requestId)
          }
        >
          Consultar solicitação {request.requestId}
        </Button>
      ))}
      {state.context?.openRequest &&
        state.context.openRequest.requestId !== state.request?.requestId && (
          <Button
            type="button"
            variant="outline"
            disabled={state.busy}
            onClick={() =>
              void controller?.refresh(
                state.context?.openRequest?.requestId,
                true,
              )
            }
          >
            Consultar solicitação aberta {state.context.openRequest.requestId}
          </Button>
        )}
      {state.discovery.nextCursor !== null && (
        <div>
          <p>
            Existem outras solicitações. Esta página não confirma ausência de
            operações anteriores.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={!current || state.discovery.status === "loading"}
            onClick={() => void controller?.loadMore()}
          >
            {state.discovery.status === "loading"
              ? "Consultando solicitações…"
              : "Carregar mais solicitações"}
          </Button>
        </div>
      )}
    </section>
  );
}
function WithdrawalActions({
  controller,
  scope,
  ports,
  state,
}: {
  controller: ReturnType<typeof createWithdrawalSetupController>;
  scope: WithdrawalSetupScope;
  ports?: WithdrawalSetupPorts;
  state: WithdrawalSetupState;
}) {
  const proof = useRef<FinancialReauthenticationHandle | null>(null);
  const terms = useRef<HTMLFormElement | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const request = state.request;
  if (!request) return null;
  const action: Action =
    request.state === "OPEN" ? "CONFIRM_NEW" : "RECOVER_EXISTING";
  const expired =
    request.state === "OPEN" &&
    (ports?.now?.() ?? Date.now()) >= Date.parse(request.preview.expiresAt);
  return (
    <div className="grid gap-3">
      <FinancialReauthenticationForm
        {...scope}
        action="REQUEST_WITHDRAWAL"
        feedback="toast"
        dialog
        ref={proof}
        guard={controller.guard}
        request={ports?.request}
        now={ports?.now}
      />
      <form
        ref={terms}
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!event.currentTarget.reportValidity() || !confirmed) return;
          setConfirmed(false);
          void controller.act(
            action,
            () => proof.current?.consumeProof() ?? null,
            confirmed,
          );
        }}
      >
        <label>
          <input
            type="checkbox"
            required
            aria-required="true"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          Confirmo os termos originais exibidos desta solicitação.
        </label>
        <Button
          type="submit"
          disabled={
            !confirmed ||
            state.busy ||
            expired ||
            request.state === "UNRESOLVED"
          }
        >
          {state.busy
            ? "Processando…"
            : expired
              ? "Prévia expirada — encerre a solicitação"
              : action === "CONFIRM_NEW"
                ? "Confirmar solicitação de saque"
                : "Recuperar solicitação original"}
        </Button>
        {request.state === "OPEN" && (
          <Button
            type="button"
            variant="outline"
            disabled={!confirmed || state.busy}
            onClick={() => {
              if (!terms.current?.reportValidity()) return;
              setConfirmed(false);
              void controller.act(
                "SEAL",
                () => proof.current?.consumeProof() ?? null,
                confirmed,
              );
            }}
          >
            {state.busy ? "Encerrando…" : "Encerrar solicitação sem reserva"}
          </Button>
        )}
      </form>
    </div>
  );
}
