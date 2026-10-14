import {
  receivingNominationInputSchema,
  receivingNominationResponseSchema,
  type SiteAccess,
} from "@entrelacos/contracts";
import { ApiError, apiRequest } from "../lib/apiClient";
import {
  type FinancialReauthenticationGuard,
  type FinancialReauthenticationScope,
  financialReauthenticationScopeKey,
} from "./financialReauthenticationClient";

export type ReceivingNominationScope = {
  siteId: string;
  access: SiteAccess | null;
  sessionEpoch: number | null;
  requestId: string | null;
  policyVersion: string | null;
};
export type ReceivingNominationProofSource = {
  scope: FinancialReauthenticationScope;
  consumeProof(): string | null;
};
export type ReceivingNominationState = {
  status:
    | "idle"
    | "loading"
    | "pending"
    | "unknown"
    | "unavailable"
    | "denied"
    | "session_expired"
    | "reauthentication_required";
  uncertain: boolean;
  nomination?: typeof receivingNominationResponseSchema._output.nomination;
};
type Request = (
  path: string,
  options: { method: string; body: unknown },
) => Promise<unknown>;
export function receivingNominationScopeKey(
  scope: ReceivingNominationScope,
): string | null {
  const authorization = financialReauthenticationScopeKey({
    ...scope,
    action: "CONFIGURE_RECEIVING",
  });
  const request = receivingNominationInputSchema.shape.requestId.safeParse(
    scope.requestId,
  );
  const policy = receivingNominationInputSchema.shape.policyVersion.safeParse(
    scope.policyVersion,
  );
  return authorization && request.success && policy.success
    ? JSON.stringify([authorization, request.data, policy.data])
    : null;
}
class NominationAccessError extends Error {}
class NominationProofError extends Error {}

export async function requestReceivingNomination(
  scope: ReceivingNominationScope,
  confirmed: boolean,
  proof: ReceivingNominationProofSource,
  request: Request = apiRequest,
  guard?: FinancialReauthenticationGuard,
  isCurrent: () => boolean = () => true,
) {
  const key = receivingNominationScopeKey(scope);
  const authorization = financialReauthenticationScopeKey({
    ...scope,
    action: "CONFIGURE_RECEIVING",
  });
  if (
    !key ||
    !isCurrent() ||
    !confirmed ||
    financialReauthenticationScopeKey(proof.scope) !== authorization
  )
    throw new NominationAccessError("Receiving nomination access denied");
  if (
    guard &&
    (!guard.isCurrent() || !(await guard.validate()) || !guard.isCurrent())
  )
    throw new NominationAccessError("Receiving nomination context unavailable");
  if (!isCurrent() || receivingNominationScopeKey(scope) !== key)
    throw new NominationAccessError("Receiving nomination access changed");
  const token =
    receivingNominationInputSchema.shape.reauthenticationToken.safeParse(
      proof.consumeProof(),
    );
  if (!token.success)
    throw new NominationProofError("Current password confirmation required");
  if (
    receivingNominationScopeKey(scope) !== key ||
    !isCurrent() ||
    guard?.isCurrent() === false ||
    financialReauthenticationScopeKey(proof.scope) !== authorization
  )
    throw new NominationAccessError("Receiving nomination access changed");
  const body = receivingNominationInputSchema.parse({
    requestId: scope.requestId,
    policyVersion: scope.policyVersion,
    confirmSelfAsRecipient: true,
    reauthenticationToken: token.data,
  });
  const siteId = scope.siteId;
  const response = receivingNominationResponseSchema.parse(
    await request(
      `/v1/sites/${encodeURIComponent(siteId)}/receiving/nomination`,
      { method: "POST", body },
    ),
  );
  if (
    receivingNominationScopeKey(scope) !== key ||
    !isCurrent() ||
    guard?.isCurrent() === false ||
    response.nomination.siteId !== siteId ||
    response.nomination.requestId !== body.requestId
  )
    throw new Error("Receiving nomination response unavailable");
  return response;
}

// The reviewed caller owns requestId across uncertainty, reauthentication and
// session replacement; this consumer never creates another operation identity.
export function createReceivingNominationController(
  scope: ReceivingNominationScope,
  onState: (state: ReceivingNominationState) => void,
  options: {
    request?: Request;
    guard?: FinancialReauthenticationGuard;
    initialUncertainty?: boolean;
  } = {},
) {
  const key = receivingNominationScopeKey(scope);
  let state: ReceivingNominationState = {
    status: key ? "idle" : "denied",
    uncertain: options.initialUncertainty ?? false,
  };
  let disposed = false;
  let invalidated = key === null;
  function publish(next: ReceivingNominationState) {
    state = next;
    if (!disposed) onState(structuredClone(next));
  }
  function current() {
    if (disposed || invalidated) return false;
    if (
      !key ||
      receivingNominationScopeKey(scope) !== key ||
      options.guard?.isCurrent() === false
    ) {
      invalidated = true;
      publish({ status: "denied", uncertain: state.uncertain });
      return false;
    }
    return true;
  }
  const unsubscribe =
    options.guard?.subscribeInvalidation(() => {
      if (disposed || invalidated) return;
      invalidated = true;
      publish({ status: "denied", uncertain: state.uncertain });
    }) ?? (() => {});
  return {
    async submit(confirmed: boolean, proof: ReceivingNominationProofSource) {
      if (
        !current() ||
        !confirmed ||
        ["loading", "pending", "denied", "session_expired"].includes(
          state.status,
        )
      )
        return;
      const priorUncertainty = state.uncertain;
      publish({ status: "loading", uncertain: priorUncertainty });
      try {
        const response = await requestReceivingNomination(
          scope,
          confirmed,
          proof,
          options.request,
          options.guard,
          current,
        );
        if (current())
          publish({
            status: "pending",
            uncertain: false,
            nomination: response.nomination,
          });
      } catch (error) {
        if (!current()) return;
        const status =
          error instanceof NominationAccessError
            ? "denied"
            : error instanceof NominationProofError
              ? "reauthentication_required"
              : error instanceof ApiError && error.status === 401
                ? "session_expired"
                : error instanceof ApiError &&
                    error.status === 403 &&
                    error.code === "RECENT_AUTH_REQUIRED"
                  ? "reauthentication_required"
                  : error instanceof ApiError && error.status === 403
                    ? "denied"
                    : error instanceof ApiError &&
                        error.status === 409 &&
                        error.code === "PROVIDER_MODE_UNAVAILABLE"
                      ? "unavailable"
                      : "unknown";
        publish({
          status,
          uncertain: priorUncertainty || status === "unknown",
        });
      }
    },
    getState(): ReceivingNominationState {
      current();
      return structuredClone(state);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      state = { status: "idle", uncertain: false };
    },
  };
}
