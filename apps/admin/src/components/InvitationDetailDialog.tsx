import {
  formatInvitationPhoneInput,
  type InvitationRecord,
} from "@entrelacos/contracts";
import { Button, Dialog, DialogTitle, toast } from "@entrelacos/ui";
import { Copy, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useRef } from "react";
import { AdminDialogContent } from "./AdminDialog";
import { InvitationStatus } from "./InvitationStatus";

type Props = {
  invitation: InvitationRecord | null;
  inactive: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onRotatePin: () => void;
  accessPin: string | null;
  pinLoading: boolean;
  onManage: () => void;
};

export function InvitationDetailDialog({
  invitation,
  inactive,
  onOpenChange,
  onEdit,
  onDelete,
  onRotatePin,
  accessPin,
  pinLoading,
  onManage,
}: Props) {
  async function copyPin() {
    if (!accessPin) return;
    try {
      await navigator.clipboard.writeText(accessPin);
      toast.success("PIN copiado.");
    } catch {
      toast.error("Não foi possível copiar o PIN.");
    }
  }

  const heading = useRef<HTMLHeadingElement>(null);
  if (!invitation) return null;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <AdminDialogContent
        aria-labelledby="invitation-detail-title"
        initialFocus={heading}
      >
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="m-0 text-xs font-bold uppercase tracking-wider text-admin-text-secondary">
              Detalhes do convite
            </p>
            <DialogTitle
              id="invitation-detail-title"
              ref={heading}
              tabIndex={-1}
              className="m-0 break-words font-admin-display text-2xl font-normal"
            >
              {invitation.name}
            </DialogTitle>
          </div>
        </div>
        <div className="grid gap-5">
          <section
            className="rounded-xl border border-admin-border bg-admin-canvas p-4"
            aria-label="Dados do convite"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <p className="m-0 text-sm font-bold text-admin-text">
                Como acessam o site
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={onEdit}
                disabled={inactive}
                className="border-admin-border"
              >
                <Pencil aria-hidden="true" className="size-4" />
                Editar
              </Button>
            </div>
            <dl className="mt-5 grid gap-3 border-t border-admin-border pt-4 text-sm">
              <div>
                <dt className="text-admin-text-secondary">
                  Telefone de contato
                </dt>
                <dd className="m-0 mt-1 text-admin-text">
                  {formatInvitationPhoneInput(invitation.phone)}
                </dd>
              </div>
              <div>
                <dt className="text-admin-text-secondary">E-mail de contato</dt>
                <dd className="m-0 mt-1 text-admin-text">
                  {invitation.email ?? "Não informado"}
                </dd>
              </div>
            </dl>
            <div className="mt-4 border-t border-admin-border pt-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <span className="text-xs text-admin-text-secondary">
                    PIN do convite
                  </span>
                  <p
                    className={
                      accessPin
                        ? "m-0 mt-1 font-mono text-lg tracking-[0.18em] text-admin-text"
                        : "m-0 mt-1 text-sm text-admin-text-secondary"
                    }
                  >
                    {accessPin ?? (pinLoading ? "Consultando…" : "—")}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={copyPin}
                    disabled={!accessPin}
                    className="border-admin-border"
                  >
                    <Copy aria-hidden="true" className="size-4" />
                    Copiar
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={onRotatePin}
                    disabled={inactive}
                    aria-label="Gerar novo PIN"
                  >
                    <RotateCcw aria-hidden="true" className="size-4" />
                  </Button>
                </div>
              </div>
              <p className="mb-0 mt-3 text-xs leading-relaxed text-admin-text-secondary">
                O telefone e este PIN permitem acessar as confirmações no site.
                Compartilhe-os somente com os convidados deste convite.
              </p>
            </div>
          </section>
          <section aria-label="Convidados neste convite" className="grid gap-6">
            <h3 className="m-0 font-admin-display text-xl text-admin-text">
              Convidados neste convite ({invitation.guests.length})
            </h3>
            <ul className="grid gap-2.5">
              {invitation.guests.map((guest) => (
                <li
                  key={guest.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-admin-border bg-admin-surface p-3.5"
                >
                  <div className="grid gap-1">
                    <strong className="text-sm text-admin-text">
                      {guest.fullName}
                    </strong>
                    <InvitationStatus state={guest.rsvpState} />
                  </div>
                  <span className="rounded-full bg-admin-canvas px-2.5 py-1 text-xs text-admin-text-secondary">
                    {guest.guestType === "ADULT" ? "Adulto" : "Criança"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <Button
            type="button"
            onClick={onManage}
            className="w-full bg-admin-accent text-admin-on-accent hover:bg-admin-accent-hover"
          >
            Gerenciar confirmações
          </Button>
          <div className="flex flex-wrap justify-between gap-3 border-t border-admin-border pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={onDelete}
              disabled={inactive}
              className="border-admin-danger text-admin-danger"
            >
              <Trash2 aria-hidden="true" className="size-4" />
              Excluir convite
            </Button>
            <Button type="button" onClick={onEdit} disabled={inactive}>
              <Plus aria-hidden="true" className="size-4" />
              Adicionar convidado
            </Button>
          </div>
        </div>
      </AdminDialogContent>
    </Dialog>
  );
}
