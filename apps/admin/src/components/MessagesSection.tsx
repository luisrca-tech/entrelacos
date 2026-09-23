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
  Checkbox,
  toast,
} from "@entrelacos/ui";
import { useCallback, useEffect, useState } from "react";
import { adminStyles } from "../lib/adminStyles";
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
    try {
      await apiRequest(path, { method, body });
      toast.success(success);
      await load();
    } catch (cause) {
      const message = messageAdminError(cause);
      await load();
      toast.error(message);
    } finally {
      setPending("");
    }
  }

  return (
    <section className="grid gap-4" aria-label="Mensagens">
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

      <div className={`${adminStyles.surface} overflow-hidden`}>
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-admin-line p-5 [@media(max-width:760px)]:grid">
          <div className="min-w-0">
            <h2 className="m-0 font-admin-display text-[1.35rem] text-admin-graphite">
              Mural de mensagens
            </h2>
            <p className="mb-0 mt-1 max-w-[62ch] text-sm leading-[1.6] text-admin-muted">
              Controle a publicação do mural e modere os recados enviados por
              cada convite. O texto dos convidados não pode ser editado no
              painel.
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

        {loading ? (
          <p className="m-0 p-5 leading-[1.6] text-admin-muted" role="status">
            Carregando mensagens…
          </p>
        ) : invitations.length === 0 ? (
          <p className="m-0 p-5 leading-[1.6] text-admin-muted">
            Nenhum convite encontrado para moderação.
          </p>
        ) : (
          invitations.map((invitation) => (
            <article
              key={invitation.invitationId}
              className="border-b border-admin-line p-5 last:border-b-0 [@media(max-width:600px)]:p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="m-0 break-words font-admin-display text-[1.3rem] text-admin-graphite">
                    {invitation.invitationName}
                  </h3>
                  <p className="mb-0 mt-1 text-xs text-admin-muted">
                    {invitation.blocked
                      ? "Envios bloqueados"
                      : "Envios permitidos"}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
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
              </div>
              {invitation.message ? (
                <div className="mt-4 grid gap-2">
                  <blockquote className="m-0 break-words whitespace-pre-wrap text-sm leading-[1.55] text-admin-ink">
                    {invitation.message.text}
                  </blockquote>
                  <p className="m-0 text-xs text-admin-muted">
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
                <p className="mb-0 mt-4 text-sm text-admin-muted">
                  Este convite ainda não publicou uma mensagem.
                </p>
              )}
            </article>
          ))
        )}
      </div>

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
