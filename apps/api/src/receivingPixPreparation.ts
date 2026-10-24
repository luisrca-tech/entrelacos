import type { FinancialActor } from "./financialAuthorization";
import {
  createReceivingSetupAsaasObserver,
  type ReceivingSetupAsaasObserverOptions,
  ReceivingSetupProviderError,
  readReceivingSetupBoundedJson,
} from "./receivingSetupAsaas";

export type IncomingPixBinding = ReceivingSetupAsaasObserverOptions["binding"];
export type IncomingPixPreparation = "READY" | "PENDING" | "REVIEW_REQUIRED";
export type IncomingPixOutcome = "SUBMITTED" | "REJECTED" | "UNKNOWN";
export interface IncomingPixPreparationRepository {
  arm(
    actor: FinancialActor,
    binding: IncomingPixBinding,
  ): Promise<string | null>;
  settle(attemptId: string, outcome: IncomingPixOutcome): Promise<void>;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ReceivingSetupProviderError();
  return value as Record<string, unknown>;
}
function reference(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  );
}

// Only private holder commands call this preparer. Public observations remain GET-only.
export function createReceivingPixPreparation(options: {
  repository: IncomingPixPreparationRepository;
  fetch: typeof globalThis.fetch;
  now(): Date;
}) {
  let closed = false;
  const pending = new Map<AbortController, Promise<void>>();
  return Object.freeze({
    async prepare(
      actor: FinancialActor,
      binding: IncomingPixBinding,
      accessToken: string,
    ): Promise<IncomingPixPreparation> {
      if (closed || actor.siteId !== binding.siteId)
        throw new ReceivingSetupProviderError();
      const abort = new AbortController();
      const signal = AbortSignal.any([
        abort.signal,
        AbortSignal.timeout(20000),
      ]);
      const observer = createReceivingSetupAsaasObserver({
        binding,
        accessToken,
        fetch: options.fetch,
        now: options.now,
      });
      let finish = () => {};
      const completion = new Promise<void>((resolve) => {
        finish = resolve;
      });
      pending.set(abort, completion);
      try {
        const observed = await observer.readStatus(signal);
        if (
          observed.commercialInfoExpired === true ||
          !(["commercialInfo", "documentation", "general"] as const).every(
            (key) => observed.status[key] === "APPROVED",
          )
        )
          return "PENDING";
        const base =
          binding.environment === "live"
            ? "https://api.asaas.com/v3"
            : "https://api-sandbox.asaas.com/v3";
        const headers = {
          accept: "application/json",
          "User-Agent": "Entrelacos/1.0",
          access_token: accessToken,
        };
        async function keys() {
          const response = await options.fetch(
            `${base}/pix/addressKeys?limit=100`,
            { method: "GET", redirect: "error", signal, headers },
          );
          if (response.status !== 200 || response.redirected) {
            await response.body?.cancel().catch(() => {});
            throw new ReceivingSetupProviderError();
          }
          const result = object(
            await readReceivingSetupBoundedJson(response, signal),
          );
          if (
            result.hasMore !== false ||
            !Array.isArray(result.data) ||
            result.data.length > 100
          )
            throw new ReceivingSetupProviderError();
          return result.data.map((value) => {
            const key = object(value);
            if (
              !reference(key.id) ||
              !["EVP", "CPF", "CNPJ", "EMAIL", "PHONE"].includes(
                String(key.type),
              ) ||
              ![
                "ACTIVE",
                "AWAITING_ACTIVATION",
                "AWAITING_DELETION",
                "AWAITING_ACCOUNT_DELETION",
                "DELETED",
                "ERROR",
              ].includes(String(key.status))
            )
              throw new ReceivingSetupProviderError();
            return { status: key.status };
          });
        }
        const existing = await keys();
        if (existing.some((key) => key.status === "ACTIVE")) return "READY";
        if (existing.some((key) => key.status !== "DELETED")) return "PENDING";
        if (signal.aborted) throw new ReceivingSetupProviderError();
        // This claim commits before dispatch. A crash or lost response cannot cause a second POST.
        const attempt = await options.repository.arm(actor, binding);
        if (!attempt) return "REVIEW_REQUIRED";
        let outcome: IncomingPixOutcome = "UNKNOWN";
        try {
          if (closed || signal.aborted) throw new ReceivingSetupProviderError();
          const response = await options.fetch(`${base}/pix/addressKeys`, {
            method: "POST",
            redirect: "error",
            signal,
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ type: "EVP" }),
          });
          if (response.redirected) throw new ReceivingSetupProviderError();
          const body = object(
            await readReceivingSetupBoundedJson(response, signal),
          );
          if (
            response.status === 400 &&
            Array.isArray(body.errors) &&
            body.errors.length > 0 &&
            body.errors.length <= 20 &&
            body.errors.every((error) => reference(object(error).code))
          )
            outcome = "REJECTED";
          else if (
            response.status === 200 &&
            reference(body.id) &&
            body.type === "EVP" &&
            ["ACTIVE", "AWAITING_ACTIVATION"].includes(String(body.status))
          )
            outcome = "SUBMITTED";
        } catch {
          // Provider descriptions, keys and credentials never enter logs or public results.
        }
        await options.repository.settle(attempt, outcome);
        if (outcome === "REJECTED") return "PENDING";
        if (outcome === "UNKNOWN") return "REVIEW_REQUIRED";
        try {
          return (await keys()).some((key) => key.status === "ACTIVE")
            ? "READY"
            : "PENDING";
        } catch {
          return "REVIEW_REQUIRED";
        }
      } finally {
        await observer.close();
        pending.delete(abort);
        finish();
      }
    },
    async close() {
      closed = true;
      for (const abort of pending.keys()) abort.abort();
      await Promise.allSettled(pending.values());
    },
  });
}
