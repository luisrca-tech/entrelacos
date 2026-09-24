import type { PublicMuralResponse } from "@entrelacos/contracts";
import { toast } from "@entrelacos/ui/toaster";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getMessageErrorMessage,
  muralRefreshEventName,
  WeddingMessagesApi,
  WeddingMessagesApiError,
} from "./messages";
import { PublicMessageDialog } from "./PublicMessageDialog";

export type MessageMuralProps = {
  siteId: string;
  apiOrigin: string;
  fetcher?: typeof fetch;
  refreshIntervalMs?: number;
};

type MuralMessage = PublicMuralResponse["messages"][number];

const muralSectionClass =
  "grid min-w-0 gap-6 bg-[var(--template-paper,#fffdf8)] px-[clamp(2rem,5vw,4rem)] py-[clamp(2rem,5vw,4rem)] text-template-ink [@media(max-width:560px)]:px-4 [@media(max-width:560px)]:py-8";
const muralEyebrowClass =
  "m-0 mb-[0.8rem] text-template-muted text-[0.72rem] font-bold tracking-[0.16em] uppercase";
const muralHeadingClass =
  "m-0 font-template-serif text-[clamp(2.3rem,6vw,4.8rem)] font-normal leading-[0.96] tracking-[-0.05em]";
const muralHeaderClass =
  "flex items-end justify-between gap-6 [@media(max-width:560px)]:items-stretch [@media(max-width:560px)]:flex-col";
const muralActionsClass = "flex flex-wrap items-center gap-2";
const muralButtonClass =
  "min-h-11 cursor-pointer border border-template-ink bg-transparent px-4 py-[0.65rem] text-template-ink font-[inherit] font-bold disabled:cursor-not-allowed disabled:opacity-50";
const muralPrimaryButtonClass =
  "min-h-11 cursor-pointer border border-template-ink bg-template-ink px-4 py-[0.65rem] text-template-ivory font-[inherit] font-bold disabled:cursor-not-allowed disabled:opacity-50";
const muralMoreButtonClass =
  "min-h-11 cursor-pointer justify-self-center border border-template-ink bg-transparent px-4 py-[0.65rem] text-template-ink font-[inherit] font-bold disabled:cursor-not-allowed disabled:opacity-50";
const muralStatusClass = "m-0 border border-template-line p-4";

export function mergeMuralMessages(
  current: MuralMessage[],
  incoming: MuralMessage[],
  append: boolean,
): MuralMessage[] {
  if (!append) return incoming;
  const ids = new Set(current.map(({ id }) => id));
  return [...current, ...incoming.filter(({ id }) => !ids.has(id))];
}

export function getMuralVisibility(
  enabled: boolean,
  messageCount: number,
  hasNextPage: boolean,
) {
  return {
    showComposer: enabled,
    showMessages: messageCount > 0,
    showEmptyState: enabled && messageCount === 0,
    showPausedStatus: !enabled,
    showMore: hasNextPage,
  };
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
  const [enabled, setEnabled] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const refreshVersion = useRef(0);
  const nextCursorRef = useRef<string | null>(null);
  const [messageOpen, setMessageOpen] = useState(false);

  const load = useCallback(
    async (append: boolean, notify = false) => {
      if (!apiResult.api) {
        setError(apiResult.error);
        if (notify) toast.error(apiResult.error);
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
        if (!result.enabled) setMessageOpen(false);
        setMessages((current) =>
          mergeMuralMessages(current, result.messages, append),
        );
        nextCursorRef.current = result.nextCursor;
        setNextCursor(result.nextCursor);
      } catch (cause) {
        if (version === refreshVersion.current) {
          if (
            cause instanceof WeddingMessagesApiError &&
            (cause.code === "MURAL_DISABLED" || cause.code === "SITE_INACTIVE")
          ) {
            setEnabled(false);
            setMessageOpen(false);
            if (cause.code === "SITE_INACTIVE") {
              setMessages([]);
              nextCursorRef.current = null;
              setNextCursor(null);
            }
          }
          const message = getMessageErrorMessage(cause);
          setError(message);
          if (notify) {
            toast.error(
              `${message} As mensagens exibidas podem estar desatualizadas.`,
            );
          }
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

  const visibility = getMuralVisibility(
    enabled,
    messages.length,
    Boolean(nextCursor),
  );

  useEffect(() => {
    void load(false, true);
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
    <section className={muralSectionClass} aria-labelledby="mural-title">
      <header className={muralHeaderClass}>
        <div>
          <p className={muralEyebrowClass}>Recados</p>
          <h2 className={muralHeadingClass} id="mural-title">
            Mural dos convidados
          </h2>
        </div>
        <div className={muralActionsClass}>
          {visibility.showComposer && (
            <button
              type="button"
              className={muralPrimaryButtonClass}
              onClick={() => setMessageOpen(true)}
            >
              Deixar uma mensagem
            </button>
          )}
          <button
            type="button"
            className={muralButtonClass}
            disabled={loading}
            onClick={() => void load(false, true)}
          >
            {loading ? "Atualizando…" : "Atualizar"}
          </button>
        </div>
      </header>

      {error && !loading && (
        <p className={muralStatusClass} role="alert">
          {error}
        </p>
      )}
      {visibility.showPausedStatus && !loading && !error && (
        <p className={muralStatusClass} role="status">
          O mural está pausado para novas mensagens. As mensagens já publicadas
          continuam disponíveis.
        </p>
      )}
      {visibility.showEmptyState && !loading && !error && (
        <p className={muralStatusClass} role="status">
          Ainda não há mensagens publicadas.
        </p>
      )}
      {visibility.showMessages && (
        <ul className="m-0 grid list-none grid-cols-2 gap-4 p-0 [@media(max-width:560px)]:grid-cols-1">
          {messages.map((message) => (
            <li
              className="flex min-h-56 flex-col justify-between border border-template-line bg-template-ivory p-[1.35rem]"
              key={message.id}
            >
              <blockquote className="m-0 whitespace-pre-wrap break-words font-template-serif text-[1.2rem] leading-[1.5] [overflow-wrap:anywhere]">
                {message.text}
              </blockquote>
              <p className="mt-8 mb-0 grid gap-[0.2rem] text-template-muted text-[0.78rem]">
                <strong className="text-template-ink">
                  {message.authorName}
                </strong>
                <time dateTime={message.createdAt}>
                  {formatMessageDate(message.createdAt)}
                </time>
              </p>
            </li>
          ))}
        </ul>
      )}

      {visibility.showMore && (
        <button
          type="button"
          className={muralMoreButtonClass}
          disabled={loadingMore}
          onClick={() => void load(true, true)}
        >
          {loadingMore ? "Carregando…" : "Ver mais mensagens"}
        </button>
      )}
      <PublicMessageDialog
        open={messageOpen && visibility.showComposer}
        siteId={siteId}
        api={apiResult.api}
        apiError={apiResult.error}
        onClose={() => setMessageOpen(false)}
      />
    </section>
  );
}
