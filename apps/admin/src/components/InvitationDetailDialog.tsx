import {
  formatInvitationPhoneInput,
  type InvitationRecord,
} from "@entrelacos/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  toast,
} from "@entrelacos/ui";
import { Copy, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { adminStyles } from "../lib/adminStyles";
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

  return (
    <Dialog open={invitation !== null} onOpenChange={onOpenChange}>
      <DialogContent
        className={`${adminStyles.dialog} max-w-[min(680px,calc(100vw-32px))]`}
      >
        <DialogTitle className="font-admin-display text-3xl text-admin-graphite">
          {invitation ? `Convite de ${invitation.name}` : "Convite"}
        </DialogTitle>
        <DialogDescription className="text-admin-muted">
          Dados do convite e respostas individuais dos convidados.
        </DialogDescription>
        {invitation && (
          <div className="mt-5 grid gap-5">
            <section
              className="rounded-xl border border-admin-line bg-admin-canvas p-4"
              aria-label="Dados do convite"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <span className="text-xs font-semibold uppercase tracking-[0.08em] text-admin-muted">
                    Identificação do convite
                  </span>
                  <p className="m-0 mt-1 font-semibold text-admin-ink">
                    {invitation.name}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={onEdit}
                  disabled={inactive}
                  className="border-admin-line"
                >
                  <Pencil aria-hidden="true" className="size-4" />
                  Editar
                </Button>
              </div>
              <dl className="mt-5 grid gap-3 border-t border-admin-line pt-4 text-sm">
                <div>
                  <dt className="text-admin-muted">Telefone de contato</dt>
                  <dd className="m-0 mt-1 text-admin-ink">
                    {formatInvitationPhoneInput(invitation.phone)}
                  </dd>
                </div>
                <div>
                  <dt className="text-admin-muted">E-mail de contato</dt>
                  <dd className="m-0 mt-1 text-admin-ink">
                    {invitation.email ?? "Não informado"}
                  </dd>
                </div>
              </dl>
              <div className="mt-4 border-t border-admin-line pt-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <span className="text-xs text-admin-muted">
                      PIN do convite
                    </span>
                    <p
                      className={
                        accessPin
                          ? "m-0 mt-1 font-mono text-lg tracking-[0.18em] text-admin-ink"
                          : "m-0 mt-1 text-sm text-admin-muted"
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
                      className="border-admin-line"
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
                <p className="mb-0 mt-3 text-xs leading-relaxed text-admin-muted">
                  O telefone e este PIN permitem acessar as confirmações no
                  site. Compartilhe-os somente com os convidados deste convite.
                </p>
              </div>
            </section>
            <section
              aria-label="Convidados neste convite"
              className="grid gap-6"
            >
              <h3 className="m-0 font-admin-display text-xl text-admin-graphite">
                Convidados neste convite ({invitation.guests.length})
              </h3>
              <ul className="grid gap-2.5">
                {invitation.guests.map((guest) => (
                  <li
                    key={guest.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-admin-line bg-admin-surface p-3.5"
                  >
                    <div className="grid gap-1">
                      <strong className="text-sm text-admin-ink">
                        {guest.fullName}
                      </strong>
                      <InvitationStatus state={guest.rsvpState} />
                    </div>
                    <span className="rounded-full bg-admin-canvas px-2.5 py-1 text-xs text-admin-muted">
                      {guest.guestType === "ADULT" ? "Adulto" : "Criança"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
            <div className="flex flex-wrap justify-between gap-3 border-t border-admin-line pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={onDelete}
                disabled={inactive}
                className="border-admin-status-declined text-admin-status-declined"
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
        )}
      </DialogContent>
    </Dialog>
  );
}
