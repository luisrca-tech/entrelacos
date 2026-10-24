import { Gift, LockKeyhole } from "lucide-react";
import type { ReactNode } from "react";

export function GiftsLocked({
  receivingAction,
  reason,
}: {
  receivingAction?: ReactNode;
  reason?: string;
}) {
  return (
    <section
      className="rounded-2xl border border-admin-line bg-admin-surface p-6 sm:p-8"
      aria-labelledby="gifts-locked-title"
      data-area="gifts"
    >
      <div className="mb-5 flex size-12 items-center justify-center rounded-xl bg-admin-beige">
        <Gift aria-hidden="true" className="size-6 text-admin-terracotta" />
      </div>
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-admin-muted">
        <LockKeyhole aria-hidden="true" className="size-3.5" />
        Lista de presentes
      </p>
      <h2
        id="gifts-locked-title"
        className="font-admin-display text-2xl text-admin-ink"
      >
        Configure os recebimentos primeiro
      </h2>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-admin-muted">
        Sua lista será liberada após a verificação do recebedor e da conta de
        destino. Os presentes são simbólicos e convertidos em dinheiro para o
        casal.
      </p>
      {reason && (
        <p
          role="status"
          className="mt-3 max-w-xl text-sm font-medium text-admin-graphite"
        >
          {reason}
        </p>
      )}
      {receivingAction ? (
        <div className="mt-5">{receivingAction}</div>
      ) : (
        <p className="mt-4 text-sm text-admin-muted">
          Peça ao casal para concluir a configuração dos recebimentos.
        </p>
      )}
    </section>
  );
}
