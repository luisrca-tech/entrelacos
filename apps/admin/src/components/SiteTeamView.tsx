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
import type { FormEvent } from "react";
import { adminStyles, displayHeading } from "../lib/adminStyles";

type Props = {
  team: SiteTeamResponse | null;
  canManage: boolean;
  pending: boolean;
  error?: string;
  now?: Date;
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

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 text-sm text-admin-muted">
          Gerencie quem ajuda a cuidar do casamento.
        </p>
        <Button
          type="button"
          disabled={pending}
          onClick={() => onInviteOpenChange(true)}
        >
          <Plus aria-hidden="true" />
          Convidar assessor
        </Button>
      </div>

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

      <section
        aria-labelledby="site-team-members-heading"
        className={`${adminStyles.surface} min-w-0 overflow-hidden`}
      >
        <h2
          id="site-team-members-heading"
          className={`${displayHeading} m-0 border-b border-admin-line p-5 text-xl`}
        >
          Assessores com acesso
        </h2>
        {team.members.length === 0 ? (
          <p className="m-0 p-5 text-sm text-admin-muted">
            Ainda não há assessores com acesso.
          </p>
        ) : (
          <ul className="m-0 grid min-w-0 list-none divide-y divide-admin-line p-0">
            {team.members.map((member) => {
              const active = member.revokedAt === null;
              return (
                <li
                  key={member.userId}
                  className="grid min-w-0 gap-3 p-5 sm:flex sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 break-words">
                    <p className="m-0 font-semibold text-admin-graphite">
                      {member.name}
                    </p>
                    <p className="mb-0 mt-1 break-all text-sm text-admin-muted">
                      {member.email}
                    </p>
                    <p className="mb-0 mt-2 text-sm text-admin-muted">
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
                  {active && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label={`Revogar acesso de ${member.name}`}
                      disabled={pending}
                      onClick={() => onRevokeMember(member.userId)}
                    >
                      Revogar acesso
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section
        aria-labelledby="site-team-invitations-heading"
        className={`${adminStyles.surface} min-w-0 overflow-hidden`}
      >
        <h2
          id="site-team-invitations-heading"
          className={`${displayHeading} m-0 border-b border-admin-line p-5 text-xl`}
        >
          Convites da equipe
        </h2>
        {team.invitations.length === 0 ? (
          <p className="m-0 p-5 text-sm text-admin-muted">
            Ainda não há convites para assessores.
          </p>
        ) : (
          <ul className="m-0 grid min-w-0 list-none divide-y divide-admin-line p-0">
            {team.invitations.map((invitation) => {
              const unconsumedAndUnrevoked =
                invitation.consumedAt === null && invitation.revokedAt === null;
              const expired =
                unconsumedAndUnrevoked &&
                new Date(invitation.expiresAt).getTime() <= now.getTime();
              const pendingInvitation = unconsumedAndUnrevoked && !expired;
              const status = invitation.revokedAt
                ? "Revogado"
                : invitation.consumedAt
                  ? "Utilizado"
                  : expired
                    ? "Expirado"
                    : "Pendente";
              const eventDate = invitation.revokedAt ?? invitation.consumedAt;
              const dateLabel = invitation.revokedAt
                ? "Revogado em"
                : invitation.consumedAt
                  ? "Aceito em"
                  : expired
                    ? "Expirou em"
                    : "Expira em";
              const dateValue = eventDate ?? invitation.expiresAt;

              return (
                <li
                  key={invitation.id}
                  className="grid min-w-0 gap-3 p-5 sm:flex sm:items-center sm:justify-between"
                >
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
                      {dateLabel}{" "}
                      <time dateTime={dateValue}>{formatDate(dateValue)}</time>
                    </p>
                  </div>
                  {pendingInvitation && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label={`Revogar convite para ${invitation.inviteeName}`}
                      disabled={pending}
                      onClick={() => onRevokeInvitation(invitation.id)}
                    >
                      Revogar convite
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
