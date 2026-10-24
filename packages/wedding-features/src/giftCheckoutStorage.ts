import {
  checkoutCreateInputSchema,
  checkoutRecoveryTokenSchema,
  checkoutStatusSchema,
  giftPaymentMethodSchema,
  receivingModeSchema,
  siteIdSchema,
} from "@entrelacos/contracts";

export const pendingGiftCheckoutSchema = checkoutCreateInputSchema
  .extend({
    method: giftPaymentMethodSchema,
    mode: receivingModeSchema,
    terminalStatus: checkoutStatusSchema.optional(),
    lastStatus: checkoutStatusSchema.optional(),
  })
  .strict()
  .refine((value) => {
    if (value.mode === "disabled") return false;
    const { terminalStatus: terminal, lastStatus: latest } = value;
    if (!terminal || !latest)
      return terminal === undefined && latest === undefined;
    return (
      ["RECEIVED", "REFUNDED"].includes(terminal.state) &&
      ["RECEIVED", "REFUNDED", "OUTCOME_UNKNOWN"].includes(latest.state) &&
      !(terminal.state === "REFUNDED" && latest.state === "RECEIVED") &&
      terminal.observedAt !== null &&
      latest.observedAt !== null &&
      Date.parse(latest.observedAt) >= Date.parse(terminal.observedAt) &&
      (latest.state === "OUTCOME_UNKNOWN" ||
        (latest.state === terminal.state &&
          Date.parse(latest.observedAt) === Date.parse(terminal.observedAt))) &&
      latest.siteId === terminal.siteId &&
      latest.orderId === terminal.orderId &&
      latest.attemptId === terminal.attemptId &&
      [terminal, latest].every(
        (status) =>
          status.quoteId === value.quoteId &&
          status.requestId === value.requestId &&
          status.method === value.method &&
          status.mode === value.mode,
      )
    );
  });
export type PendingGiftCheckout = typeof pendingGiftCheckoutSchema._output;

export function createGiftCheckoutRecoveryToken(
  random: Pick<Crypto, "getRandomValues"> = crypto,
): string {
  const bytes = new Uint8Array(32);
  random.getRandomValues(bytes);
  return checkoutRecoveryTokenSchema.parse(
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, ""),
  );
}

export function giftPendingStorageKey(siteId: string): string {
  return `entrelacos:pending-gift-checkout:${encodeURIComponent(siteIdSchema.parse(siteId))}`;
}
export function readPendingGiftCheckout(
  storage: Pick<Storage, "getItem">,
  siteId: string,
): PendingGiftCheckout | null {
  const value = storage.getItem(giftPendingStorageKey(siteId));
  return value === null ? null : parsePendingForSite(siteId, JSON.parse(value));
}
export function loadPendingGiftCheckout(
  getStorage: () => Pick<Storage, "getItem">,
  siteId: string,
): PendingGiftCheckout | null {
  try {
    return readPendingGiftCheckout(getStorage(), siteId);
  } catch {
    throw new Error("Checkout recovery could not be read.");
  }
}
export function hasUnresolvedGiftCheckout(
  getStorage: () => Pick<Storage, "getItem">,
  siteId: string,
): boolean {
  try {
    return loadPendingGiftCheckout(getStorage, siteId) !== null;
  } catch {
    // Unreadable history cannot establish that an earlier attempt is absent.
    return true;
  }
}
export function clearPendingGiftCheckout(
  getStorage: () => Pick<Storage, "getItem" | "removeItem">,
  siteId: string,
  expected: PendingGiftCheckout,
): void {
  try {
    const storage = getStorage();
    const current = readPendingGiftCheckout(storage, siteId);
    if (
      !current ||
      current.terminalStatus !== undefined ||
      current.quoteId !== expected.quoteId ||
      current.requestId !== expected.requestId ||
      current.recoveryToken !== expected.recoveryToken ||
      current.method !== expected.method ||
      current.mode !== expected.mode
    )
      throw new Error("Checkout recovery identity changed.");
    storage.removeItem(giftPendingStorageKey(siteId));
  } catch {
    throw new Error("Checkout recovery could not be cleared.");
  }
}
export function writePendingGiftCheckout(
  storage: Pick<Storage, "setItem">,
  siteId: string,
  input: PendingGiftCheckout,
): void {
  storage.setItem(
    giftPendingStorageKey(siteId),
    JSON.stringify(parsePendingForSite(siteId, input)),
  );
}

export function retainPendingGiftCheckout(
  getStorage: () => Pick<Storage, "getItem" | "setItem">,
  siteId: string,
  expected: PendingGiftCheckout,
  next: PendingGiftCheckout,
): void {
  try {
    const storage = getStorage();
    const current = readPendingGiftCheckout(storage, siteId);
    const parsed = parsePendingForSite(siteId, next);
    if (
      !current ||
      JSON.stringify(current) !==
        JSON.stringify(parsePendingForSite(siteId, expected)) ||
      current.quoteId !== parsed.quoteId ||
      current.requestId !== parsed.requestId ||
      current.recoveryToken !== parsed.recoveryToken ||
      current.method !== parsed.method ||
      current.mode !== parsed.mode ||
      !parsed.terminalStatus ||
      !parsed.lastStatus ||
      parsed.terminalStatus.observedAt === null ||
      parsed.lastStatus.observedAt === null
    )
      throw new Error("Checkout recovery identity changed.");
    if (current.terminalStatus && current.lastStatus) {
      if (
        current.terminalStatus.observedAt === null ||
        current.lastStatus.observedAt === null
      )
        throw new Error("Checkout recovery history has no observation.");
      if (
        parsed.terminalStatus.orderId !== current.terminalStatus.orderId ||
        parsed.terminalStatus.attemptId !== current.terminalStatus.attemptId ||
        (current.terminalStatus.state === "REFUNDED" &&
          parsed.terminalStatus.state !== "REFUNDED") ||
        Date.parse(parsed.terminalStatus.observedAt) <
          Date.parse(current.terminalStatus.observedAt) ||
        Date.parse(parsed.lastStatus.observedAt) <
          Date.parse(current.lastStatus.observedAt) ||
        (current.lastStatus.state === "OUTCOME_UNKNOWN" &&
          parsed.lastStatus.state !== "OUTCOME_UNKNOWN" &&
          Date.parse(parsed.lastStatus.observedAt) ===
            Date.parse(current.lastStatus.observedAt))
      )
        throw new Error("Checkout recovery history regressed.");
    }
    writePendingGiftCheckout(storage, siteId, parsed);
  } catch {
    throw new Error("Checkout recovery could not be retained.");
  }
}

function parsePendingForSite(
  siteId: string,
  input: unknown,
): PendingGiftCheckout {
  const pending = pendingGiftCheckoutSchema.parse(input);
  if (pending.terminalStatus && pending.terminalStatus.siteId !== siteId)
    throw new Error("Checkout recovery site changed.");
  return pending;
}
