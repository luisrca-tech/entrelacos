import type { GiftCheckoutPix } from "@entrelacos/contracts";
import { type ReactNode, useId, useState } from "react";

const expiryFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "America/Sao_Paulo",
});

const copyButtonClass =
  "min-h-11 cursor-pointer rounded-full border border-template-ink bg-template-ink px-5 py-2.5 text-sm font-medium text-template-ivory focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-template-ink";

/** Pix QR code, copy-and-paste code and deadline of an open Pix charge. */
export function GiftPixPayment({
  pix,
  children,
}: {
  pix: GiftCheckoutPix;
  /** Extra actions shown beside "Copiar código". */
  children?: ReactNode;
}) {
  const codeId = useId();
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <section
      aria-label="Pix"
      className="grid min-w-0 justify-items-center gap-4"
    >
      <img
        src={pix.qrCodeUrl}
        alt="QR Code do Pix"
        width={200}
        height={200}
        referrerPolicy="no-referrer"
        className="block size-44 max-w-full rounded-xl border border-template-line bg-white p-2 sm:size-[200px]"
      />
      <p className="m-0 text-center text-sm text-template-muted">
        Pague até{" "}
        <time dateTime={pix.expiresAt}>
          {expiryFormatter.format(new Date(pix.expiresAt))}
        </time>
        . A confirmação aparece aqui assim que o pagamento for identificado.
      </p>
      <div className="grid w-full min-w-0 gap-2">
        <label htmlFor={codeId} className="font-medium">
          Pix copia e cola
        </label>
        <textarea
          id={codeId}
          readOnly
          rows={3}
          value={pix.qrCode}
          onFocus={(event) => event.currentTarget.select()}
          className="w-full min-w-0 resize-none break-all rounded-xl border border-template-line bg-[var(--template-paper,#fffdf8)] p-3 font-mono text-xs text-template-ink"
        />
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={copyButtonClass}
            onClick={() => {
              void navigator.clipboard
                ?.writeText(pix.qrCode)
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
          >
            Copiar código
          </button>
          {children}
          {copied !== null && (
            <span role="status" className="text-sm text-template-muted">
              {copied
                ? "Código copiado."
                : "Não foi possível copiar. Selecione o código acima."}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
