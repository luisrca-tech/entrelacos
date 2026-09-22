import type { SiteMessageRecord } from "@entrelacos/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
} from "@entrelacos/ui";
import { useCallback, useEffect, useState } from "react";
import { adminStyles, displayHeading } from "../lib/adminStyles";
import { apiRequest } from "../lib/apiClient";
import { listenForInvitationsChanged } from "./invitationsRefresh";
import { mergeSiteMessages, messageAdminError } from "./messageAdmin";

type Props = {
  siteId: string;
  lifecycle: "DRAFT" | "IN_REVIEW" | "ACTIVE" | "INACTIVE";
};

type MessagesResponse = {
  invitations: SiteMessageRecord[];
  nextCursor: string | null;
};

export function MessagesSection({ siteId, lifecycle }: Props) {
  const base = `/v1/sites/${encodeURIComponent(siteId)}`;
  const [invitations, setInvitations] = useState<SiteMessageRecord[]>([]);
  const [muralEnabled, setMuralEnabled] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [removeTarget, setRemoveTarget] = useState<SiteMessageRecord | null>(
    null,
  );
  const mutable = lifecycle !== "INACTIVE";

  const load = useCallback(
    async (cursor?: string) => {
      if (!cursor) setLoading(true);
      setError("");
      try {
        const [messages, mural] = await Promise.all([
          apiRequest<MessagesResponse>(
            `${base}/messages?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          ),
          cursor
            ? Promise.resolve(null)
            : apiRequest<{ siteId: string; enabled: boolean }>(`${base}/mural`),
        ]);
        setInvitations((current) =>
          mergeSiteMessages(current, messages.invitations, Boolean(cursor)),
        );
        setNextCursor(messages.nextCursor);
        if (mural) setMuralEnabled(mural.enabled);
      } catch (cause) {
        setError(messageAdminError(cause));
      } finally {
        setLoading(false);
      }
    },
    [base],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () => listenForInvitationsChanged(window, siteId, () => void load()),
    [load, siteId],
  );

  async function mutate(
    key: string,
    path: string,
    method: "PATCH" | "DELETE",
    body: unknown,
    success: string,
  ) {
    if (!mutable || pending) return;
    setPending(key);
    setError("");
    setNotice("");
    try {
      await apiRequest(path, { method, body });
      setNotice(success);
      await load();
    } catch (cause) {
      const message = messageAdminError(cause);
      await load();
      setError(message);
    } finally {
      setPending("");
    }
  }

  return (
    <section className={adminStyles.card} aria-labelledby="messages-title">
      <div className="flex items-end justify-between gap-3.5 [@media(max-width:760px)]:grid [@media(max-width:760px)]:grid-cols-1">
        <div>
          <h2
            className={`m-0 mb-[18px] text-[clamp(1.8rem,3vw,2.7rem)] ${displayHeading}`}
            id="messages-title"
          >
            Mural de mensagens
          </h2>
          <p className="leading-[1.6]">
            Controle a publicação do mural e modere os recados enviados por cada
            convite. O texto dos convidados não pode ser editado no painel.
          </p>
        </div>
        <label className="flex items-center gap-2.5" htmlFor="mural-enabled">
          <Checkbox
            id="mural-enabled"
            checked={muralEnabled}
            disabled={!mutable || Boolean(pending)}
            onCheckedChange={(checked) => {
              const enabled = checked === true;
              void mutate(
                "mural",
                `${base}/mural`,
                "PATCH",
                { enabled },
                enabled ? "Mural ativado." : "Mural desativado.",
              );
            }}
          />
          Mural público ativo
        </label>
      </div>

      {!mutable && (
        <p className={adminStyles.notice} role="status">
          As mensagens podem ser consultadas, mas não moderadas enquanto o site
          estiver inativo.
        </p>
      )}
      {error && (
        <p className={adminStyles.alert} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="my-3.5 leading-[1.6] text-admin-muted" role="status">
          {notice}
        </p>
      )}

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover mensagem?</AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget
                ? `Remover a mensagem de ${removeTarget.invitationName}? O texto não poderá ser recuperado.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(pending)}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              className="justify-self-start border-admin-terracotta-deep bg-transparent text-admin-terracotta-deep"
              disabled={Boolean(pending)}
              onClick={() => {
                if (removeTarget)
                  void mutate(
                    `delete:${removeTarget.invitationId}`,
                    `${base}/invitations/${encodeURIComponent(removeTarget.invitationId)}/message`,
                    "DELETE",
                    { expectedRevision: removeTarget.currentRevision },
                    "Mensagem removida do mural.",
                  );
                setRemoveTarget(null);
              }}
            >
              Remover mensagem
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {loading ? (
        <p className="leading-[1.6]" role="status">
          Carregando mensagens…
        </p>
      ) : invitations.length === 0 ? (
        <p className="leading-[1.6]">
          Nenhum convite encontrado para moderação.
        </p>
      ) : (
        <div className="mt-6 grid gap-3">
          {invitations.map((invitation) => (
            <Card
              className="items-stretch rounded-[10px] border border-admin-line bg-admin-surface p-5 [@media(max-width:760px)]:grid [@media(max-width:760px)]:grid-cols-1 [&_[data-slot=card-header]]:w-full [&_h3]:mb-2"
              key={invitation.invitationId}
            >
              <CardHeader className="flex w-full flex-row items-start justify-between">
                <div>
                  <CardTitle>{invitation.invitationName}</CardTitle>
                  <CardDescription>
                    {invitation.blocked
                      ? "Envios bloqueados"
                      : "Envios permitidos"}
                  </CardDescription>
                </div>
                <CardAction>
                  <div className="flex flex-wrap items-center gap-3.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={!mutable || Boolean(pending)}
                      onClick={() =>
                        void mutate(
                          `block:${invitation.invitationId}`,
                          `${base}/invitations/${encodeURIComponent(invitation.invitationId)}/message-block`,
                          "PATCH",
                          { blocked: !invitation.blocked },
                          invitation.blocked
                            ? "Novas mensagens liberadas para o convite."
                            : "Novas mensagens bloqueadas para o convite.",
                        )
                      }
                    >
                      {pending === `block:${invitation.invitationId}`
                        ? "Atualizando…"
                        : invitation.blocked
                          ? "Desbloquear envios"
                          : "Bloquear envios"}
                    </Button>
                    {invitation.message && (
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        disabled={!mutable || Boolean(pending)}
                        onClick={() => setRemoveTarget(invitation)}
                      >
                        {pending === `delete:${invitation.invitationId}`
                          ? "Removendo…"
                          : "Remover mensagem"}
                      </Button>
                    )}
                  </div>
                </CardAction>
              </CardHeader>
              <CardContent>
                {invitation.message ? (
                  <div className="grid gap-4">
                    <blockquote className="m-0 break-words whitespace-pre-wrap text-[1.1rem] leading-[1.55]">
                      {invitation.message.text}
                    </blockquote>
                    <p className="leading-[1.6]">
                      Publicada em{" "}
                      <time dateTime={invitation.message.createdAt}>
                        {new Intl.DateTimeFormat("pt-BR", {
                          dateStyle: "medium",
                          timeStyle: "short",
                          timeZone: "America/Sao_Paulo",
                        }).format(new Date(invitation.message.createdAt))}
                      </time>
                    </p>
                  </div>
                ) : (
                  <p className="leading-[1.6]">
                    Este convite ainda não publicou uma mensagem.
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {nextCursor && (
        <Button
          type="button"
          variant="outline"
          disabled={loading || Boolean(pending)}
          onClick={() => void load(nextCursor)}
        >
          Ver mais convites
        </Button>
      )}
    </section>
  );
}
