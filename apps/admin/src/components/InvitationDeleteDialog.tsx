import type {
  InvitationDeleteConfirmation,
  InvitationRecord,
} from "@entrelacos/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Input,
} from "@entrelacos/ui";
import { useState } from "react";
import { adminStyles } from "../lib/adminStyles";
import { AdminAlertDialogContent } from "./AdminDialog";

type Props = {
  invitation: InvitationRecord | null;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (confirmation: InvitationDeleteConfirmation) => void;
};

export function InvitationDeleteDialog({
  invitation,
  busy,
  onOpenChange,
  onConfirm,
}: Props) {
  const [confirmationName, setConfirmationName] = useState("");

  function changeOpen(open: boolean) {
    if (!open) setConfirmationName("");
    onOpenChange(open);
  }

  return (
    <AlertDialog open={invitation !== null} onOpenChange={changeOpen}>
      <AdminAlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Excluir convite?</AlertDialogTitle>
          <AlertDialogDescription>
            Esta ação remove definitivamente o convite, os convidados,
            confirmações, histórico, sessão, mensagem e dados de acesso
            associados. Digite a identificação exata para continuar:{" "}
            <strong>{invitation?.name}</strong>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label
          htmlFor="invitation-delete-name"
          className="grid gap-2 text-sm font-semibold text-admin-text"
        >
          Identificação exata do convite
          <Input
            id="invitation-delete-name"
            autoComplete="off"
            value={confirmationName}
            onChange={(event) => setConfirmationName(event.target.value)}
            className="border-admin-border bg-admin-surface"
          />
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} onClick={() => changeOpen(false)}>
            Cancelar
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={
              busy || !invitation || confirmationName !== invitation.name
            }
            onClick={(event) => {
              event.preventDefault();
              if (invitation)
                onConfirm({
                  confirmInvitationId: invitation.id,
                  confirmInvitationName: confirmationName,
                });
            }}
            className={adminStyles.dangerButton}
          >
            {busy ? "Excluindo…" : "Excluir definitivamente"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AdminAlertDialogContent>
    </AlertDialog>
  );
}
