import type { ReceivingReadiness } from "@entrelacos/contracts";
import { giftPaymentsEnabled } from "@entrelacos/ui";
import { useEffect, useSyncExternalStore } from "react";

/**
 * What the API says about money gifts, learned from the `mode` field of the
 * receiving readiness response (PAGARME_MODE on the server).
 *
 * - `unknown`: nothing learned yet (also the server-render value).
 * - `available`: the API runs in sandbox or live mode.
 * - `unavailable`: the API reports `disabled` (the pre-accreditation default).
 * - `unreachable`: the last check failed, so nothing was learned; retried on
 *   the next mount.
 *
 * `PUBLIC_GIFT_PAYMENTS_ENABLED=false` stays the manual pause: it closes the
 * payment areas whatever the API reports.
 */
export type PaymentsAvailability =
  | "unknown"
  | "available"
  | "unavailable"
  | "unreachable";

let current: PaymentsAvailability = "unknown";
const listeners = new Set<() => void>();

function set(next: PaymentsAvailability) {
  if (next === current) return;
  current = next;
  for (const listener of [...listeners]) listener();
}

export const paymentsAvailabilityStore = {
  get: () => current,
  getServerSnapshot: (): PaymentsAvailability => "unknown",
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Records the API mode from a readiness response. */
  reportMode(mode: ReceivingReadiness["mode"]) {
    set(mode === "disabled" ? "unavailable" : "available");
  },
  /** Records a failed check without overriding what the API already said. */
  reportFailure() {
    if (current === "unknown") set("unreachable");
  },
  reset() {
    set("unknown");
  },
};

/** True when the receiving and gift-payment areas should be offered. */
export function paymentsAreaOpen(
  availability: PaymentsAvailability = current,
): boolean {
  return giftPaymentsEnabled() && availability === "available";
}

/**
 * True while a deep link to a payment area should wait for the API instead of
 * being sent home: the build allows payments and nothing was learned yet.
 */
export function paymentsAreaPending(
  availability: PaymentsAvailability = current,
): boolean {
  return giftPaymentsEnabled() && availability === "unknown";
}

export function usePaymentsAvailability(): PaymentsAvailability {
  return useSyncExternalStore(
    paymentsAvailabilityStore.subscribe,
    paymentsAvailabilityStore.get,
    paymentsAvailabilityStore.getServerSnapshot,
  );
}

/**
 * Subscribes to the availability and, when it is not known yet, asks the API
 * once through the given probe (a readiness read for any one site: the mode is
 * the same for every site).
 */
export function usePaymentsProbe(
  siteId: string | undefined,
  probe: (siteId: string) => Promise<unknown>,
): PaymentsAvailability {
  const availability = usePaymentsAvailability();
  const needsProbe =
    availability === "unknown" || availability === "unreachable";
  useEffect(() => {
    if (!siteId || !giftPaymentsEnabled() || !needsProbe) return;
    let active = true;
    probe(siteId).catch(() => {
      if (active) paymentsAvailabilityStore.reportFailure();
    });
    return () => {
      active = false;
    };
  }, [siteId, needsProbe, probe]);
  return availability;
}
