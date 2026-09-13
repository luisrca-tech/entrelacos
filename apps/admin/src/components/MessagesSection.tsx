import type { SiteMessageRecord } from "@entrelacos/contracts";
import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "../lib/apiClient";
import { listenForGuestGroupsChanged } from "./guestGroupsRefresh";
import { mergeSiteMessages, messageAdminError } from "./messageAdmin";

type Props = {
  siteId: string;
  lifecycle: "DRAFT" | "IN_REVIEW" | "ACTIVE" | "INACTIVE";
};

type MessagesResponse = {
  groups: SiteMessageRecord[];
  nextCursor: string | null;
};

export function MessagesSection({ siteId, lifecycle }: Props) {
  const base = `/v1/sites/${encodeURIComponent(siteId)}`;
  const [groups, setGroups] = useState<SiteMessageRecord[]>([]);
  const [muralEnabled, setMuralEnabled] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
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
        setGroups((current) =>
          mergeSiteMessages(current, messages.groups, Boolean(cursor)),
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
    () => listenForGuestGroupsChanged(window, siteId, () => void load()),
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
    <section
      className="panel-section messages-admin"
      aria-labelledby="messages-title"
    >
      <div className="guest-groups-heading">
        <div>
          <h2 id="messages-title">Mural de mensagens</h2>
          <p>
            Controle a publicação do mural e modere os recados enviados por cada
            convite. O texto dos convidados não pode ser editado no painel.
          </p>
        </div>
        <label className="mural-toggle">
          <input
            type="checkbox"
            checked={muralEnabled}
            disabled={!mutable || Boolean(pending)}
            onChange={(event) => {
              const enabled = event.target.checked;
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
        <p className="panel-notice" role="status">
          As mensagens podem ser consultadas, mas não moderadas enquanto o site
          estiver inativo.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      {loading ? (
        <p role="status">Carregando mensagens…</p>
      ) : groups.length === 0 ? (
        <p>Nenhum convite encontrado para moderação.</p>
      ) : (
        <div className="message-group-list">
          {groups.map((group) => (
            <article className="message-group-card" key={group.groupId}>
              <header>
                <div>
                  <h3>{group.groupName}</h3>
                  <p>
                    {group.blocked ? "Envios bloqueados" : "Envios permitidos"}
                  </p>
                </div>
                <button
                  type="button"
                  className="secondary-action"
                  disabled={!mutable || Boolean(pending)}
                  onClick={() =>
                    void mutate(
                      `block:${group.groupId}`,
                      `${base}/groups/${encodeURIComponent(group.groupId)}/message-block`,
                      "PATCH",
                      { blocked: !group.blocked },
                      group.blocked
                        ? "Novas mensagens liberadas para o convite."
                        : "Novas mensagens bloqueadas para o convite.",
                    )
                  }
                >
                  {pending === `block:${group.groupId}`
                    ? "Atualizando…"
                    : group.blocked
                      ? "Desbloquear envios"
                      : "Bloquear envios"}
                </button>
              </header>
              {group.message ? (
                <div className="message-admin-copy">
                  <blockquote>{group.message.text}</blockquote>
                  <p>
                    <strong>{group.message.authorName}</strong> · Publicada em{" "}
                    <time dateTime={group.message.createdAt}>
                      {new Intl.DateTimeFormat("pt-BR", {
                        dateStyle: "medium",
                        timeStyle: "short",
                        timeZone: "America/Sao_Paulo",
                      }).format(new Date(group.message.createdAt))}
                    </time>
                  </p>
                  <button
                    type="button"
                    className="danger-action"
                    disabled={!mutable || Boolean(pending)}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Remover a mensagem de ${group.groupName}? O texto não poderá ser recuperado.`,
                        )
                      ) {
                        void mutate(
                          `delete:${group.groupId}`,
                          `${base}/groups/${encodeURIComponent(group.groupId)}/message`,
                          "DELETE",
                          { expectedRevision: group.currentRevision },
                          "Mensagem removida do mural.",
                        );
                      }
                    }}
                  >
                    {pending === `delete:${group.groupId}`
                      ? "Removendo…"
                      : "Remover mensagem"}
                  </button>
                </div>
              ) : (
                <p>Este convite ainda não publicou uma mensagem.</p>
              )}
            </article>
          ))}
        </div>
      )}

      {nextCursor && (
        <button
          type="button"
          className="secondary-action"
          disabled={loading || Boolean(pending)}
          onClick={() => void load(nextCursor)}
        >
          Ver mais convites
        </button>
      )}
    </section>
  );
}
