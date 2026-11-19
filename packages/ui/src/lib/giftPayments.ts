declare global {
  interface ImportMetaEnv {
    /** Build-time kill switch for money gifts. Only "false" turns them off. */
    readonly PUBLIC_GIFT_PAYMENTS_ENABLED?: string;
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

/**
 * Frontend switch for receiving money gifts (public checkout and the admin
 * receiving area). On by default; a build can pause the feature with
 * PUBLIC_GIFT_PAYMENTS_ENABLED=false. Whether money actually moves is decided
 * by the API (PAGARME_MODE and its guards), never by this flag.
 */
export function giftPaymentsEnabled(): boolean {
  return import.meta.env.PUBLIC_GIFT_PAYMENTS_ENABLED !== "false";
}

/** Shown on the public site while money gifts are switched off. */
export const giftPaymentsComingSoonMessage =
  "Os presentes em dinheiro estarão disponíveis em breve.";
