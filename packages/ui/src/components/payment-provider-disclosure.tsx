import { LockKeyhole } from "lucide-react";

/**
 * Names the payment processor. Text only: Pagar.me publishes no partner badge
 * or usage terms for its marks, so this seal never imitates a logo. Colors come
 * from the surrounding text, so it fits every site theme and the admin panel.
 */
export function PaymentProviderDisclosure() {
  return (
    <p
      data-payment-seal
      className="m-0 inline-flex max-w-full items-center gap-2 rounded-full border border-current/25 px-3.5 py-1.5 text-sm leading-snug text-current opacity-80"
    >
      <LockKeyhole aria-hidden="true" className="size-4 shrink-0" />
      Pagamentos processados por Pagar.me, uma empresa Stone.
    </p>
  );
}
