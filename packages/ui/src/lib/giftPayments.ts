declare global {
  interface ImportMetaEnv {
    /** Build-time opt-in for money gifts. Anything but "true" keeps them off. */
    readonly PUBLIC_GIFT_PAYMENTS_ENABLED?: string;
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

/**
 * Frontend switch for receiving money gifts (public checkout and the admin
 * receiving area). Off unless the build sets
 * PUBLIC_GIFT_PAYMENTS_ENABLED=true; the API and its guards are unaffected.
 */
export function giftPaymentsEnabled(): boolean {
  return import.meta.env.PUBLIC_GIFT_PAYMENTS_ENABLED === "true";
}

/** Shown on the public site while money gifts are switched off. */
export const giftPaymentsComingSoonMessage =
  "Os presentes em dinheiro estarão disponíveis em breve.";
