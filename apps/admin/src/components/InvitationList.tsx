import type { InvitationRecord } from "@entrelacos/contracts";
import { Button } from "@entrelacos/ui";
import { ArrowRight, UsersRound } from "lucide-react";
import { InvitationStatus } from "./InvitationStatus";

type Props = {
  invitations: readonly InvitationRecord[];
  onOpen: (invitation: InvitationRecord) => void;
  hasFilters: boolean;
};

export function InvitationList({ invitations, onOpen, hasFilters }: Props) {
  if (invitations.length === 0) {
    return (
      <div className="rounded-2xl border border-admin-line bg-admin-surface px-6 py-12 text-center">
        <UsersRound
          aria-hidden="true"
          className="mx-auto mb-4 size-8 text-admin-muted"
        />
        <p className="m-0 font-admin-display text-xl text-admin-graphite">
          {hasFilters ? "Nenhum convite encontrado" : "Ainda não há convites"}
        </p>
        <p className="mx-auto mt-2 max-w-sm text-sm text-admin-muted">
          {hasFilters
            ? "Ajuste a busca ou os filtros para ver outros convites."
            : "Adicione o primeiro convite para começar a organizar os convidados."}
        </p>
      </div>
    );
  }

  return (
    <section
      className="overflow-hidden rounded-2xl border border-admin-line bg-admin-surface"
      aria-label="Lista de convites"
    >
      {invitations.map((invitation) => (
        <article
          key={invitation.id}
          className="border-b border-admin-line p-5 last:border-b-0 [@media(max-width:600px)]:p-4"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="m-0 break-words font-admin-display text-[1.3rem] text-admin-graphite">
                {invitation.name}
              </h3>
              <p className="mb-0 mt-1 text-xs text-admin-muted">
                {invitation.guests.length}{" "}
                {invitation.guests.length === 1 ? "convidado" : "convidados"}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpen(invitation)}
              className="shrink-0 border-admin-line bg-admin-canvas"
              aria-label={`Ver convite ${invitation.name}`}
            >
              Ver convite
              <ArrowRight aria-hidden="true" className="size-4" />
            </Button>
          </div>
          <ul className="mt-4 grid gap-2.5">
            {invitation.guests.map((guest) => (
              <li
                key={guest.id}
                className="flex flex-wrap items-center justify-between gap-x-5 gap-y-1.5 text-sm"
              >
                <span className="min-w-0 break-words font-medium text-admin-ink">
                  {guest.fullName}
                </span>
                <span className="flex items-center gap-3">
                  <InvitationStatus state={guest.rsvpState} />
                  <span className="rounded-full bg-admin-canvas px-2.5 py-1 text-xs text-admin-muted">
                    {guest.guestType === "ADULT" ? "Adulto" : "Criança"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </article>
      ))}
    </section>
  );
}
