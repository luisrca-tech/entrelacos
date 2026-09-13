import type { PublicMuralResponse } from "@entrelacos/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getMessageErrorMessage,
  muralRefreshEventName,
  WeddingMessagesApi,
} from "./messages";

export type MessageMuralProps = {
  siteId: string;
  apiOrigin: string;
  fetcher?: typeof fetch;
  refreshIntervalMs?: number;
};

type MuralMessage = PublicMuralResponse["messages"][number];

export function mergeMuralMessages(
  current: MuralMessage[],
  incoming: MuralMessage[],
  append: boolean,
): MuralMessage[] {
  if (!append) return incoming;
  const ids = new Set(current.map(({ id }) => id));
  return [...current, ...incoming.filter(({ id }) => !ids.has(id))];
}

function formatMessageDate(value: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(new Date(value));
}

export function MessageMural({
  siteId,
  apiOrigin,
  fetcher,
  refreshIntervalMs = 30_000,
}: MessageMuralProps) {
  const apiResult = useMemo(() => {
    try {
      return {
        api: new WeddingMessagesApi({ apiOrigin, siteId, fetcher }),
        error: "",
      };
    } catch {
      return {
        api: null,
        error: "A configuração pública do mural é inválida.",
      };
    }
  }, [apiOrigin, fetcher, siteId]);
  const [messages, setMessages] = useState<MuralMessage[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const refreshVersion = useRef(0);
  const nextCursorRef = useRef<string | null>(null);

  const load = useCallback(
    async (append: boolean) => {
      if (!apiResult.api) {
        setError(apiResult.error);
        setLoading(false);
        return;
      }
      const cursor = append ? nextCursorRef.current : undefined;
      if (append && !cursor) return;
      const version = append
        ? refreshVersion.current
        : ++refreshVersion.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError("");
      try {
        const result = await apiResult.api.getMural({
          ...(cursor ? { cursor } : {}),
          limit: 20,
        });
        if (version !== refreshVersion.current) return;
        setEnabled(result.enabled);
        setMessages((current) =>
          mergeMuralMessages(current, result.messages, append),
        );
        nextCursorRef.current = result.nextCursor;
        setNextCursor(result.nextCursor);
      } catch (cause) {
        if (version === refreshVersion.current) {
          setError(getMessageErrorMessage(cause));
        }
      } finally {
        if (version === refreshVersion.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [apiResult],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }
    const refresh = () => void load(false);
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, refreshIntervalMs);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(muralRefreshEventName(siteId), refresh);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(muralRefreshEventName(siteId), refresh);
    };
  }, [load, refreshIntervalMs, siteId]);

  return (
    <section className="entrelacos-message-mural" aria-labelledby="mural-title">
      <header>
        <div>
          <p className="entrelacos-guest-access__eyebrow">Recados</p>
          <h2 id="mural-title">Mural dos convidados</h2>
        </div>
        <button
          type="button"
          className="entrelacos-message-mural__refresh"
          disabled={loading}
          onClick={() => void load(false)}
        >
          {loading ? "Atualizando…" : "Atualizar"}
        </button>
      </header>

      {error && (
        <p className="entrelacos-message-mural__status" role="alert">
          {error} As mensagens exibidas podem estar desatualizadas.
        </p>
      )}
      {!enabled && !loading ? (
        <p className="entrelacos-message-mural__status" role="status">
          O mural está desativado neste momento.
        </p>
      ) : messages.length === 0 && !loading && !error ? (
        <p className="entrelacos-message-mural__status" role="status">
          Ainda não há mensagens publicadas.
        </p>
      ) : (
        <ul className="entrelacos-message-mural__list">
          {messages.map((message) => (
            <li key={message.id}>
              <blockquote>{message.text}</blockquote>
              <p>
                <strong>{message.authorName}</strong>
                <span>{message.groupName}</span>
                <time dateTime={message.createdAt}>
                  {formatMessageDate(message.createdAt)}
                </time>
              </p>
            </li>
          ))}
        </ul>
      )}

      {enabled && nextCursor && (
        <button
          type="button"
          className="entrelacos-message-mural__more"
          disabled={loadingMore}
          onClick={() => void load(true)}
        >
          {loadingMore ? "Carregando…" : "Ver mais mensagens"}
        </button>
      )}
    </section>
  );
}
