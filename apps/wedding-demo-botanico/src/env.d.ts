/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Money gifts are on unless a build sets this to "false". */
  readonly PUBLIC_GIFT_PAYMENTS_ENABLED?: string;
  /** Pagar.me public key used only to tokenize cards in the browser. */
  readonly PUBLIC_PAGARME_PUBLIC_KEY?: string;
}
