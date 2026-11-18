import { giftCheckoutCardTokenSchema } from "@entrelacos/contracts";

declare global {
  interface ImportMetaEnv {
    /** Pagar.me public key (pk_…); it can only tokenize cards. */
    readonly PUBLIC_PAGARME_PUBLIC_KEY?: string;
  }
}

export const pagarmeTokensUrl = "https://api.pagar.me/core/v5/tokens";

/** Card data typed by the guest. It lives only in memory until tokenized. */
export type PagarmeCardInput = {
  number: string;
  holderName: string;
  expMonth: number;
  expYear: number;
  cvv: string;
};

export type PagarmeCardTokenErrorCode =
  | "CARD_INVALID"
  | "TOKENIZATION_UNAVAILABLE";

/** Carries only a code: card data never reaches messages or logs. */
export class PagarmeCardTokenError extends Error {
  constructor(readonly code: PagarmeCardTokenErrorCode) {
    super(code);
    this.name = "PagarmeCardTokenError";
  }
}

const publicKeyPattern = /^pk_[A-Za-z0-9_]{1,128}$/;

/** Build-time public key of the platform account, shared by all couple sites. */
export function pagarmePublicKey(): string | undefined {
  return import.meta.env.PUBLIC_PAGARME_PUBLIC_KEY || undefined;
}

/** Reads "MM/AA", "MM/AAAA" or "MMAA" into a month and a four-digit year. */
export function parseCardExpiry(
  value: string,
): { expMonth: number; expYear: number } | null {
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length !== 4 && digits.length !== 6) return null;
  const expMonth = Number(digits.slice(0, 2));
  const year = Number(digits.slice(2));
  if (expMonth < 1 || expMonth > 12) return null;
  return { expMonth, expYear: digits.length === 4 ? 2000 + year : year };
}

/**
 * Tokenizes a card straight from the browser with the public key, so the card
 * number and CVV never reach the Entrelaços API. Returns the token id.
 */
export async function createPagarmeCardToken(
  card: PagarmeCardInput,
  options: { publicKey: string | undefined; fetcher?: typeof fetch },
): Promise<string> {
  const { publicKey, fetcher = fetch } = options;
  if (!publicKey || !publicKeyPattern.test(publicKey))
    throw new PagarmeCardTokenError("TOKENIZATION_UNAVAILABLE");
  let response: Response;
  try {
    response = await fetcher(
      `${pagarmeTokensUrl}?appId=${encodeURIComponent(publicKey)}`,
      {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "card",
          card: {
            number: card.number,
            holder_name: card.holderName,
            exp_month: card.expMonth,
            exp_year: card.expYear,
            cvv: card.cvv,
          },
        }),
      },
    );
  } catch {
    throw new PagarmeCardTokenError("TOKENIZATION_UNAVAILABLE");
  }
  if (response.status >= 400 && response.status < 500)
    throw new PagarmeCardTokenError("CARD_INVALID");
  if (!response.ok) throw new PagarmeCardTokenError("TOKENIZATION_UNAVAILABLE");
  const value: unknown = await response.json().catch(() => null);
  const id = giftCheckoutCardTokenSchema.safeParse(
    value && typeof value === "object" && "id" in value ? value.id : null,
  );
  if (!id.success) throw new PagarmeCardTokenError("TOKENIZATION_UNAVAILABLE");
  return id.data;
}
