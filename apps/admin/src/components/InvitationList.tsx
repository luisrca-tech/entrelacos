import {
  type InvitationRecord,
  invitationGroupStatus,
} from "@entrelacos/contracts";
import { Badge } from "@entrelacos/ui";
import { Ellipsis, Mail, UsersRound } from "lucide-react";
import { AdminButton } from "./AdminButton";
import { invitationResponseSummary } from "./invitationView";

type Props = {
  invitations: readonly InvitationRecord[];
  onOpen: (invitation: InvitationRecord) => void;
  hasFilters: boolean;
  selectedId?: string | null;
  /** Shown as the first-invitation call to action when the list is empty. */
  onAdd?: () => void;
};

const firstSteps = [
  [
    "Crie o convite",
    "Dê um nome ao convite, informe o telefone e adicione as pessoas, adultos ou crianças.",
  ],
  [
    "Compartilhe",
    "Envie o endereço do site com o telefone e o PIN do convite para os convidados.",
  ],
  [
    "Acompanhe as respostas",
    "Cada pessoa confirma presença no site, e vocês acompanham tudo por aqui.",
  ],
] as const;

const statuses = {
  CONFIRMED: ["Confirmado", "bg-admin-success-subtle text-admin-success-text"],
  PENDING: ["Sem resposta", "bg-admin-pending-subtle text-admin-pending-text"],
  DECLINED: ["Não irão", "bg-admin-danger-subtle text-admin-danger-text"],
  PARTIAL: ["Em parte", "bg-admin-subtle text-admin-text"],
};

export function InvitationList({
  invitations,
  onOpen,
  hasFilters,
  selectedId,
  onAdd,
}: Props) {
  if (invitations.length === 0) {
    return (
      <div className="rounded-2xl border border-admin-border bg-admin-surface px-6 py-12 text-center">
        {hasFilters ? (
          <UsersRound
            aria-hidden="true"
            className="mx-auto mb-4 size-8 text-admin-text-secondary"
          />
        ) : (
          <span className="mx-auto mb-5 grid size-13 place-items-center rounded-full bg-admin-accent-subtle text-admin-accent-hover">
            <Mail aria-hidden="true" className="size-5" />
          </span>
        )}
        <p className="m-0 font-admin-display text-xl text-admin-text">
          {hasFilters ? "Nenhum convite encontrado" : "Ainda não há convites"}
        </p>
        <p className="mx-auto mt-2 max-w-sm text-sm text-admin-text-secondary">
          {hasFilters
            ? "Ajuste a busca ou os filtros para ver outros convites."
            : "Adicione o primeiro convite para começar a organizar os convidados. Um convite pode reunir uma família inteira ou uma pessoa só."}
        </p>
        {!hasFilters && (
          <>
            <ol className="mx-auto mt-6 mb-0 grid max-w-3xl list-none gap-3 p-0 text-left sm:grid-cols-3">
              {firstSteps.map(([title, text], index) => (
                <li
                  key={title}
                  className="grid content-start gap-1.5 rounded-xl bg-admin-canvas p-4"
                >
                  <span
                    aria-hidden="true"
                    className="grid size-7 place-items-center rounded-full bg-admin-accent text-xs font-bold text-admin-on-accent"
                  >
                    {index + 1}
                  </span>
                  <strong className="text-sm text-admin-text">{title}</strong>
                  <span className="text-xs leading-relaxed text-admin-text-secondary">
                    {text}
                  </span>
                </li>
              ))}
            </ol>
            {onAdd && (
              <AdminButton
                tone="primary"
                type="button"
                onClick={onAdd}
                className="mt-6"
              >
                Novo convite
              </AdminButton>
            )}
          </>
        )}
      </div>
    );
  }

  const columns =
    "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 @2xl:grid-cols-[minmax(0,1fr)_minmax(110px,170px)_minmax(150px,230px)_auto]";
  return (
    <section
      className="@container overflow-hidden rounded-2xl border border-admin-border bg-admin-surface"
      aria-label="Lista de convites"
    >
      <div
        className={`${columns} bg-admin-canvas px-5 py-3 text-xs font-semibold text-admin-text-secondary`}
        aria-hidden="true"
      >
        <span>Convite</span>
        <span className="hidden @2xl:block">Pessoas</span>
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
        const answers = invitationResponseSummary(invitation.guests);
        return (
          <button
            key={invitation.id}
            type="button"
            className={`${columns} w-full border-t border-admin-border px-5 py-3.5 text-left hover:bg-admin-canvas ${selectedId === invitation.id ? "bg-admin-accent-subtle" : ""}`}
            aria-label={`Ver convite ${invitation.name}`}
            aria-expanded={selectedId === invitation.id}
            onClick={() => onOpen(invitation)}
          >
            <span className="min-w-0">
              <strong className="block break-words text-sm text-admin-text">
                {invitation.name}
              </strong>
              <span className="mt-0.5 block break-words text-xs text-admin-text-secondary">
                {invitation.guests.map((guest) => guest.fullName).join(", ")}
              </span>
              <span className="mt-1 block text-xs text-admin-text-secondary @2xl:hidden">
                {[people, answers].filter(Boolean).join(" · ")}
              </span>
            </span>
            <span className="hidden text-xs text-admin-text-secondary @2xl:block">
              {people}
            </span>
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <Badge className={`w-fit ${tone}`}>{label}</Badge>
              {answers && (
                <span className="hidden text-xs text-admin-text-secondary @2xl:inline">
                  {answers}
                </span>
              )}
            </span>
            <Ellipsis
              className="hidden size-4 text-admin-text-secondary @2xl:block"
              aria-hidden="true"
            />
          </button>
        );
      })}
      <p className="m-0 border-t border-admin-border px-5 py-3 text-xs text-admin-text-secondary">
        {invitations.length}{" "}
        {invitations.length === 1 ? "convite carregado" : "convites carregados"}
      </p>
    </section>
  );
}
