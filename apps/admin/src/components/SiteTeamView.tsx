import type { SiteTeamResponse } from "@entrelacos/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@entrelacos/ui";
import { Plus } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { adminStyles, displayHeading } from "../lib/adminStyles";
import { getInitials } from "./adminNavigation";
import { PageHeaderActions } from "./PageHeaderActions";

type Props = {
  team: SiteTeamResponse | null;
  canManage: boolean;
  pending: boolean;
  error?: string;
  now?: Date;
  /** Signed-in user, marked with "(você)" in the member list. */
  currentUserId?: string | null;
  inviteOpen: boolean;
  onInviteOpenChange: (open: boolean) => void;
  onInvite: (event: FormEvent<HTMLFormElement>) => void;
  onRevokeMember: (userId: string) => void;
  onRevokeInvitation: (invitationId: string) => void;
  onRetry: () => void;
};

const dateFormatter = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Sao_Paulo",
});

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Data indisponível"
    : dateFormatter.format(date);
}

export function SiteTeamView({
  team,
  canManage,
  pending,
  error,
  now = new Date(),
  currentUserId = null,
  inviteOpen,
  onInviteOpenChange,
  onInvite,
  onRevokeMember,
  onRevokeInvitation,
  onRetry,
}: Props) {
  if (!canManage) {
    return (
      <p role="status" className="m-0 text-admin-muted">
        Você não tem acesso para gerenciar a equipe.
      </p>
    );
  }

  if (!team && error) {
    return (
      <div className="grid min-w-0 gap-3">
        <p role="alert" className="m-0 text-admin-muted">
          Não foi possível carregar a equipe.
        </p>
        <div>
          <Button type="button" variant="outline" onClick={onRetry}>
            Tentar novamente
          </Button>
        </div>
      </div>
    );
  }

  if (!team) {
    return (
      <p role="status" className="m-0 text-admin-muted">
        Carregando equipe…
      </p>
    );
  }

  const activeMembers = team.members.filter(
    (member) => member.revokedAt === null,
  );
  const revokedMembers = team.members.filter(
    (member) => member.revokedAt !== null,
  );
  const pendingInvitations = team.invitations.filter((invitation) =>
    isPendingInvitation(invitation, now),
  );
  const pastInvitations = team.invitations.filter(
    (invitation) => !isPendingInvitation(invitation, now),
  );

  return (
    <div className="grid min-w-0 gap-5">
      {error && (
        <div className="grid min-w-0 gap-3">
          <p role="alert" className="m-0 text-admin-muted">
            Não foi possível concluir a ação da equipe.
          </p>
          <div>
            <Button type="button" variant="outline" onClick={onRetry}>
              Tentar novamente
            </Button>
          </div>
        </div>
      )}
      {pending && (
        <p role="status" className="m-0 text-admin-muted">
          Atualizando equipe…
        </p>
      )}

      <PageHeaderActions>
        <Button
          type="button"
          disabled={pending}
          className="bg-admin-terracotta text-white hover:bg-admin-terracotta-deep"
          onClick={() => onInviteOpenChange(true)}
        >
          <Plus aria-hidden="true" />
          Convidar assessor
        </Button>
      </PageHeaderActions>

      <section
        className="grid gap-3 rounded-2xl border border-admin-line bg-admin-beige p-5"
        aria-label="Quem pode fazer o quê"
      >
        <h2 className="m-0 text-sm font-bold">Quem pode fazer o quê</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <div className={`${adminStyles.surface} p-4`}>
            <p className="m-0 text-sm font-semibold">Titular · Vocês dois</p>
            <p className="m-0 mt-2 text-sm text-admin-body">
              Cuida das áreas do casamento, gerencia a equipe e acompanha os
              recebimentos.
            </p>
          </div>
          <div className={`${adminStyles.surface} p-4`}>
            <p className="m-0 text-sm font-semibold">
              Assessor · Quem ajuda na organização
            </p>
            <p className="m-0 mt-2 text-sm text-admin-body">
              Pode cuidar de Convites, Mensagens e Presentes.
            </p>
          </div>
        </div>
      </section>

      <Dialog
        open={inviteOpen}
        onOpenChange={(open) => {
          if (!pending) onInviteOpenChange(open);
        }}
      >
        <DialogContent className={adminStyles.dialog}>
          <DialogHeader>
            <DialogTitle>Convidar assessor</DialogTitle>
            <DialogDescription>
              Crie um link e compartilhe com a pessoa que vai ajudar no site.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={onInvite} className={`${adminStyles.form} my-0!`}>
            <label htmlFor="site-team-name">
              Nome
              <Input
                id="site-team-name"
                name="name"
                autoComplete="name"
                maxLength={160}
                required
                disabled={pending}
              />
            </label>
            <label htmlFor="site-team-email">
              E-mail
              <Input
                id="site-team-email"
                name="email"
                type="email"
                autoComplete="email"
                maxLength={254}
                required
                disabled={pending}
              />
            </label>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => onInviteOpenChange(false)}
              >
                Cancelar
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Criando convite…" : "Criar convite"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <TeamGroup
        id="site-team-members-heading"
        title="Pessoas com acesso"
        meta={`${activeMembers.length} ${activeMembers.length === 1 ? "pessoa" : "pessoas"}`}
      >
        {activeMembers.length === 0 ? (
          <EmptyGroup>Ainda não há pessoas com acesso.</EmptyGroup>
        ) : (
          <TeamList>
            {activeMembers.map((member) => (
              <MemberRow
                key={member.userId}
                member={member}
                current={member.userId === currentUserId}
                pending={pending}
                onRevoke={onRevokeMember}
              />
            ))}
          </TeamList>
        )}
      </TeamGroup>

      <TeamGroup id="site-team-invitations-heading" title="Convites pendentes">
        <p className="m-0 border-b border-admin-line px-5 py-3 text-sm text-admin-muted">
          Para enviar de novo, revogue o convite e use “Convidar assessor” para
          criar um novo.
        </p>
        {pendingInvitations.length === 0 ? (
          <EmptyGroup>Nenhum convite aguardando resposta.</EmptyGroup>
        ) : (
          <TeamList>
            {pendingInvitations.map((invitation) => (
              <InvitationRow
                key={invitation.id}
                invitation={invitation}
                now={now}
                pending={pending}
                onRevoke={onRevokeInvitation}
              />
            ))}
          </TeamList>
        )}
      </TeamGroup>

      {(revokedMembers.length > 0 || pastInvitations.length > 0) && (
        <TeamGroup id="site-team-history-heading" title="Histórico">
          <p className="m-0 border-b border-admin-line px-5 py-3 text-sm text-admin-muted">
            Acessos revogados e convites utilizados, expirados ou revogados.
          </p>
          <TeamList>
            {revokedMembers.map((member) => (
              <MemberRow
                key={member.userId}
                member={member}
                pending={pending}
                onRevoke={onRevokeMember}
              />
            ))}
            {pastInvitations.map((invitation) => (
              <InvitationRow
                key={invitation.id}
                invitation={invitation}
                now={now}
                pending={pending}
                onRevoke={onRevokeInvitation}
              />
            ))}
          </TeamList>
        </TeamGroup>
      )}
    </div>
  );
}

type Member = SiteTeamResponse["members"][number];
type TeamInvitation = SiteTeamResponse["invitations"][number];

function isPendingInvitation(invitation: TeamInvitation, now: Date) {
  return (
    invitation.consumedAt === null &&
    invitation.revokedAt === null &&
    new Date(invitation.expiresAt).getTime() > now.getTime()
  );
}

function TeamGroup({
  id,
  title,
  meta,
  children,
}: {
  id: string;
  title: string;
  meta?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className={`${adminStyles.surface} min-w-0 overflow-hidden`}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-admin-line p-5">
        <h2 id={id} className={`${displayHeading} m-0 text-xl`}>
          {title}
        </h2>
        {meta && <p className="m-0 text-sm text-admin-muted">{meta}</p>}
      </div>
      {children}
    </section>
  );
}

function TeamList({ children }: { children: ReactNode }) {
  return (
    <ul className="m-0 grid min-w-0 list-none divide-y divide-admin-line p-0">
      {children}
    </ul>
  );
}

function EmptyGroup({ children }: { children: ReactNode }) {
  return <p className="m-0 p-5 text-sm text-admin-muted">{children}</p>;
}

function MemberRow({
  member,
  current = false,
  pending,
  onRevoke,
}: {
  member: Member;
  current?: boolean;
  pending: boolean;
  onRevoke: (userId: string) => void;
}) {
  const active = member.revokedAt === null;
  return (
    <li className="grid min-w-0 gap-3 p-5 sm:flex sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3 break-words">
        <span
          aria-hidden="true"
          className="grid size-10 shrink-0 place-items-center rounded-full bg-admin-terracotta-wash text-xs font-bold text-admin-terracotta-deep"
        >
          {getInitials(member.name)}
        </span>
        <div className="min-w-0">
          <p className="m-0 font-semibold text-admin-graphite">
            {member.name}
            {current && " (você)"}
          </p>
          <p className="mb-0 mt-1 break-all text-sm text-admin-muted">
            {member.email}
          </p>
          <p className="mb-0 mt-2 text-sm text-admin-muted">
            {member.membershipRole === "SITE_ADMIN" ? "Titular" : "Assessor"} ·{" "}
            {active ? "Acesso ativo" : "Acesso revogado"}
            {member.revokedAt && (
              <>
                {" · Revogado em "}
                <time dateTime={member.revokedAt}>
                  {formatDate(member.revokedAt)}
                </time>
              </>
            )}
          </p>
        </div>
      </div>
      {active && member.membershipRole === "SITE_ASSISTANT" && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={`Revogar acesso de ${member.name}`}
          disabled={pending}
          onClick={() => onRevoke(member.userId)}
        >
          Revogar acesso
        </Button>
      )}
    </li>
  );
}

function InvitationRow({
  invitation,
  now,
  pending,
  onRevoke,
}: {
  invitation: TeamInvitation;
  now: Date;
  pending: boolean;
  onRevoke: (invitationId: string) => void;
}) {
  const pendingInvitation = isPendingInvitation(invitation, now);
  const expired =
    !pendingInvitation && !invitation.consumedAt && !invitation.revokedAt;
  const status = invitation.revokedAt
    ? "Revogado"
    : invitation.consumedAt
      ? "Utilizado"
      : expired
        ? "Expirado"
        : "Pendente";
  const dateLabel = invitation.revokedAt
    ? "Revogado em"
    : invitation.consumedAt
      ? "Aceito em"
      : expired
        ? "Expirou em"
        : "Expira em";
  const dateValue =
    invitation.revokedAt ?? invitation.consumedAt ?? invitation.expiresAt;
  return (
    <li className="grid min-w-0 gap-3 p-5 sm:flex sm:items-center sm:justify-between">
      <div className="min-w-0 break-words">
        <p className="m-0 font-semibold text-admin-graphite">
          {invitation.inviteeName}
        </p>
        <p className="mb-0 mt-1 break-all text-sm text-admin-muted">
          {invitation.email}
        </p>
        <p className="mb-0 mt-2 text-sm text-admin-muted">
          {status}
          {" · "}
          {dateLabel} <time dateTime={dateValue}>{formatDate(dateValue)}</time>
        </p>
      </div>
      {pendingInvitation && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={`Revogar convite para ${invitation.inviteeName}`}
          disabled={pending}
          onClick={() => onRevoke(invitation.id)}
        >
          Revogar convite
        </Button>
      )}
    </li>
  );
}
