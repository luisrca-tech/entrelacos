import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@entrelacos/ui";
import { useState } from "react";
import { adminStyles } from "../lib/adminStyles";
import type { InvitationExportFormat } from "./invitationExport";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onExport: (
    format: InvitationExportFormat,
    options: { includePhone: boolean; includeEmail: boolean },
  ) => void;
  busy: boolean;
  invitationCount: number;
};

export function InvitationExportDialog({
  open,
  onOpenChange,
  onExport,
  busy,
  invitationCount,
}: Props) {
  const [includePhone, setIncludePhone] = useState(false);
  const [includeEmail, setIncludeEmail] = useState(false);

  function changeOpen(next: boolean) {
    if (!next) {
      setIncludePhone(false);
      setIncludeEmail(false);
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className={adminStyles.dialog}>
        <DialogTitle className="font-admin-display text-3xl text-admin-graphite">
          Exportar convidados
        </DialogTitle>
        <DialogDescription className="leading-relaxed text-admin-muted">
          O arquivo terá uma linha por convidado, considerando a busca e os
          filtros ativos em {invitationCount}{" "}
          {invitationCount === 1 ? "convite" : "convites"}.
        </DialogDescription>
        <div className="my-5 grid gap-3 rounded-xl border border-admin-line bg-admin-canvas p-4">
          <p className="m-0 text-sm font-semibold text-admin-graphite">
            Dados de contato opcionais
          </p>
          <label className="flex min-h-10 cursor-pointer items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={includePhone}
              onChange={(event) => setIncludePhone(event.target.checked)}
              className="accent-admin-terracotta"
            />
            Incluir telefone do convite
          </label>
          <label className="flex min-h-10 cursor-pointer items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={includeEmail}
              onChange={(event) => setIncludeEmail(event.target.checked)}
              className="accent-admin-terracotta"
            />
            Incluir e-mail do convite
          </label>
          <p className="m-0 text-xs leading-relaxed text-admin-muted">
            PIN, identificadores técnicos e tokens de sessão nunca entram na
            exportação.
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2.5">
          <Button
            type="button"
            variant="outline"
            onClick={() => changeOpen(false)}
            disabled={busy}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => onExport("csv", { includePhone, includeEmail })}
            disabled={busy}
          >
            Baixar CSV
          </Button>
          <Button
            type="button"
            onClick={() => onExport("pdf", { includePhone, includeEmail })}
            disabled={busy}
          >
            Baixar PDF
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
