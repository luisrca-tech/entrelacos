import type { ReactNode } from "react";

export function GiftsLocked({
  receivingAction,
}: {
  receivingAction?: ReactNode;
}) {
  return (
    <section
      className="grid gap-4 rounded-xl border border-admin-line bg-admin-surface p-6 sm:p-8"
      aria-labelledby="gifts-locked-title"
      data-area="gifts"
    >
      <p className="m-0 text-xs font-bold uppercase tracking-wider text-admin-muted">
        Presentes simbólicos
      </p>
      <h2
        id="gifts-locked-title"
        className="m-0 font-admin-display text-2xl text-admin-graphite"
      >
        Configure os recebimentos primeiro
      </h2>
      <p className="m-0 max-w-2xl leading-relaxed text-admin-muted">
        O cadastro, as imagens e a publicação de presentes ficam disponíveis
        após a verificação do recebedor e da conta de destino. Assim, os
        convidados só podem presentear quando o casamento estiver pronto para
        receber.
      </p>
      <p className="m-0 max-w-2xl text-sm leading-relaxed text-admin-muted">
        Os presentes são simbólicos e convertidos em dinheiro para o casal, sem
        entrega de produtos. Se você é assessor, peça ao casal para concluir a
        configuração dos recebimentos.
      </p>
      {receivingAction}
    </section>
  );
}
