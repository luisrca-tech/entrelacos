import {
  type InvitationRecord,
  invitationGroupStatus,
} from "@entrelacos/contracts";
import { Badge } from "@entrelacos/ui";
import { Ellipsis, UsersRound } from "lucide-react";

type Props = {
  invitations: readonly InvitationRecord[];
  onOpen: (invitation: InvitationRecord) => void;
  hasFilters: boolean;
  selectedId?: string | null;
};

const statuses = {
  CONFIRMED: ["Confirmado", "bg-admin-success-wash text-admin-success-ink"],
  PENDING: ["Sem resposta", "bg-admin-pending-wash text-admin-pending-ink"],
  DECLINED: ["Não irão", "bg-admin-danger-wash text-admin-danger-ink"],
  PARTIAL: ["Em parte", "bg-admin-beige text-admin-body"],
};

export function InvitationList({
  invitations,
  onOpen,
  hasFilters,
  selectedId,
}: Props) {
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

  const columns =
    "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(100px,0.42fr)_minmax(105px,0.4fr)_auto]";
  return (
    <section
      className="overflow-hidden rounded-2xl border border-admin-line bg-admin-surface"
      aria-label="Lista de convites"
    >
      <div
        className={`${columns} bg-admin-canvas px-5 py-3 text-xs font-semibold text-admin-muted`}
        aria-hidden="true"
      >
        <span>Convite</span>
        <span className="hidden sm:block">Pessoas</span>
        <span>Situação</span>
      </div>
      {invitations.map((invitation) => {
        const [label, tone] =
          statuses[invitationGroupStatus(invitation.guests)];
        const adults = invitation.guests.filter(
          (guest) => guest.guestType === "ADULT",
        ).length;
        const children = invitation.guests.length - adults;
        const people = [
          adults ? `${adults} ${adults === 1 ? "adulto" : "adultos"}` : "",
          children
            ? `${children} ${children === 1 ? "criança" : "crianças"}`
            : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <button
            key={invitation.id}
            type="button"
            className={`${columns} w-full border-t border-admin-line px-5 py-3.5 text-left hover:bg-admin-canvas ${selectedId === invitation.id ? "bg-admin-terracotta-wash" : ""}`}
            aria-label={`Ver convite ${invitation.name}`}
            aria-expanded={selectedId === invitation.id}
            onClick={() => onOpen(invitation)}
          >
            <span className="min-w-0">
              <strong className="block break-words text-sm text-admin-ink">
                {invitation.name}
              </strong>
              <span className="mt-0.5 block break-words text-xs text-admin-muted">
                {invitation.guests.map((guest) => guest.fullName).join(", ")}
              </span>
              <span className="mt-1 block text-xs text-admin-muted sm:hidden">
                {people}
              </span>
            </span>
            <span className="hidden text-xs text-admin-muted sm:block">
              {people}
            </span>
            <Badge className={`w-fit ${tone}`}>{label}</Badge>
            <Ellipsis
              className="hidden size-4 text-admin-muted sm:block"
              aria-hidden="true"
            />
          </button>
        );
      })}
      <p className="m-0 border-t border-admin-line px-5 py-3 text-xs text-admin-muted">
        {invitations.length}{" "}
        {invitations.length === 1 ? "convite carregado" : "convites carregados"}
      </p>
    </section>
  );
}
