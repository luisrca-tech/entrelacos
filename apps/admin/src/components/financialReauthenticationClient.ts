import {
  financialReauthenticationActionSchema,
  financialReauthenticationInputSchema,
  financialReauthenticationResponseSchema,
  type SiteAccess,
  siteAccessSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import { ApiError, apiRequest } from "../lib/apiClient";
import { panelActorOwner } from "./panelActor";

export type FinancialReauthenticationAction =
  typeof financialReauthenticationActionSchema._output;
export type FinancialReauthenticationProof =
  typeof financialReauthenticationResponseSchema._output;
export type FinancialReauthenticationScope = {
  siteId: string;
  access: SiteAccess | null;
  action: FinancialReauthenticationAction;
  sessionEpoch: number | null;
};
export type FinancialReauthenticationGuard = {
  isCurrent(): boolean;
  validate(): Promise<boolean>;
  subscribeInvalidation(listener: () => void): () => void;
};
export type FinancialReauthenticationState =
  | {
      status:
        | "idle"
        | "loading"
        | "denied"
        | "unavailable"
        | "error"
        | "expired"
        | "consumed"
        | "session_expired"
        | "rate_limited";
    }
  | { status: "verified"; expiresAt: string };
type Request = (
  path: string,
  options: { method: string; body: unknown },
) => Promise<unknown>;

export function financialReauthenticationScopeKey(
  scope: FinancialReauthenticationScope,
): string | null {
  const access = siteAccessSchema.safeParse(scope.access);
  const site = siteIdSchema.safeParse(scope.siteId);
  const action = financialReauthenticationActionSchema.safeParse(scope.action);
  if (
    !access.success ||
    !site.success ||
    !action.success ||
    scope.sessionEpoch === null ||
    !Number.isSafeInteger(scope.sessionEpoch) ||
    scope.sessionEpoch < 0 ||
    access.data.siteId !== site.data ||
    access.data.membershipRole !== "SITE_ADMIN" ||
    access.data.membershipId === null ||
    !(action.data === "CONFIGURE_RECEIVING"
      ? access.data.capabilities.configureReceiving
      : access.data.capabilities.readFinance)
  )
    return null;
  return JSON.stringify([
    site.data,
    access.data,
    action.data,
    scope.sessionEpoch,
  ]);
}

class ExpiredFinancialProofError extends Error {}
export async function requestFinancialReauthentication(
  scope: FinancialReauthenticationScope,
  password: string,
  request: Request = apiRequest,
  now: () => number = () => Date.now(),
): Promise<FinancialReauthenticationProof> {
  if (!financialReauthenticationScopeKey(scope))
    throw new Error("Financial access denied");
  const body = financialReauthenticationInputSchema.parse({
    action: scope.action,
    password,
  });
  const proof = financialReauthenticationResponseSchema.parse(
    await request(
      `/v1/sites/${encodeURIComponent(scope.siteId)}/financial-reauthentication`,
      { method: "POST", body },
    ),
  );
  const current = now();
  const expires = Date.parse(proof.expiresAt);
  if (
    !Number.isSafeInteger(current) ||
    current < 0 ||
    expires - current > 301000
  )
    throw new Error("Invalid financial proof lifetime");
  if (expires <= current)
    throw new ExpiredFinancialProofError("Financial proof expired");
  // Bound small server clock lead without extending the server or local lifetime.
  return {
    ...proof,
    expiresAt: new Date(Math.min(expires, current + 300000)).toISOString(),
  };
}

export function createFinancialReauthenticationController(
  scope: FinancialReauthenticationScope,
  onState: (state: FinancialReauthenticationState) => void,
  options: {
    request?: Request;
    now?: () => number;
    guard?: FinancialReauthenticationGuard;
    owner?: typeof panelActorOwner;
  } = {},
) {
  const scopeKey = financialReauthenticationScopeKey(scope);
  const now = options.now ?? (() => Date.now());
  const owner = options.owner ?? panelActorOwner;
  const capturedOwner = owner.getSnapshot();
  let state: FinancialReauthenticationState = {
    status: scopeKey ? "idle" : "denied",
  };
  let proof: FinancialReauthenticationProof | null = null;
  let quarantine: FinancialReauthenticationProof | null = null;
  let installedAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let revision = 0;
  let invalidated = scopeKey === null;
  function clearProof() {
    proof = null;
    quarantine = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  function publish(next: FinancialReauthenticationState) {
    state = next;
    if (!disposed) onState({ ...next });
  }
  function current() {
    if (disposed || invalidated) return false;
    if (
      !scopeKey ||
      financialReauthenticationScopeKey(scope) !== scopeKey ||
      options.guard?.isCurrent() === false
    ) {
      invalidate();
      return false;
    }
    return true;
  }
  function invalidate() {
    if (disposed || invalidated) return;
    invalidated = true;
    revision++;
    clearProof();
    publish({ status: "denied" });
  }
  function checkExpiry() {
    if (!proof) return;
    const time = now();
    if (
      !Number.isSafeInteger(time) ||
      time < installedAt ||
      time >= Date.parse(proof.expiresAt)
    ) {
      clearProof();
      publish({ status: "expired" });
    }
  }
  const unsubscribe =
    options.guard?.subscribeInvalidation(invalidate) ?? (() => {});
  return {
    async submit(password: string) {
      if (
        !current() ||
        state.status === "loading" ||
        state.status === "session_expired" ||
        state.status === "denied"
      )
        return;
      clearProof();
      const requestRevision = ++revision;
      publish({ status: "loading" });
      if (!current() || revision !== requestRevision) return;
      try {
        let validatedAt = 0;
        quarantine = await requestFinancialReauthentication(
          scope,
          password,
          options.request,
          () => {
            validatedAt = now();
            return validatedAt;
          },
        );
        if (!current() || revision !== requestRevision) {
          clearProof();
          return;
        }
        if (options.guard && !(await options.guard.validate())) {
          invalidate();
          return;
        }
        if (!current() || revision !== requestRevision || !quarantine) {
          clearProof();
          return;
        }
        installedAt = now();
        if (
          !Number.isSafeInteger(installedAt) ||
          installedAt < validatedAt ||
          Date.parse(quarantine.expiresAt) - installedAt > 300000
        )
          throw new Error("Invalid financial proof installation time");
        if (Date.parse(quarantine.expiresAt) <= installedAt)
          throw new ExpiredFinancialProofError("Financial proof expired");
        proof = quarantine;
        quarantine = null;
        timer = setTimeout(() => {
          clearProof();
          if (current()) publish({ status: "expired" });
        }, Date.parse(proof.expiresAt) - installedAt);
        publish({ status: "verified", expiresAt: proof.expiresAt });
      } catch (error) {
        if (!current() || revision !== requestRevision) return;
        clearProof();
        if (
          error instanceof ApiError &&
          error.status === 401 &&
          error.code === "UNAUTHORIZED" &&
          owner.getSnapshot() === capturedOwner &&
          capturedOwner.status === "verified" &&
          capturedOwner.sessionEpoch === scope.sessionEpoch &&
          capturedOwner.actor?.user.id === scope.access?.userId &&
          JSON.stringify(
            capturedOwner.actor?.memberships?.find(
              (access) => access.siteId === scope.siteId,
            ),
          ) === JSON.stringify(scope.access)
        ) {
          owner.reportFailure(error, scope.sessionEpoch);
          if (!current() || revision !== requestRevision) return;
        }
        publish({
          status:
            error instanceof ExpiredFinancialProofError
              ? "expired"
              : error instanceof ApiError && error.status === 401
                ? "session_expired"
                : error instanceof ApiError &&
                    error.status === 403 &&
                    error.code !== "RECENT_AUTH_REQUIRED"
                  ? "denied"
                  : error instanceof ApiError && error.status === 429
                    ? "rate_limited"
                    : error instanceof ApiError &&
                        ((error.status === 409 &&
                          error.code === "PROVIDER_MODE_UNAVAILABLE") ||
                          (error.status === 503 &&
                            error.code === "REAUTHENTICATION_UNAVAILABLE"))
                      ? "unavailable"
                      : "error",
        });
      }
    },
    consumeProof(): string | null {
      if (!current()) return null;
      checkExpiry();
      if (!proof) return null;
      const token = proof.reauthenticationToken;
      clearProof();
      publish({ status: "consumed" });
      return token;
    },
    getState(): FinancialReauthenticationState {
      if (disposed) return { status: "idle" };
      if (current()) checkExpiry();
      return { ...state };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      revision++;
      clearProof();
      state = { status: "idle" };
    },
  };
}
