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
  Input,
  toast,
} from "@entrelacos/ui";
import { Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { adminStyles } from "../lib/adminStyles";
import { apiRequest } from "../lib/apiClient";
import { mergeSiteMessages, messageAdminError } from "./messageAdmin";
import { messagesQuery } from "./messageSearch";

type Props = {
  siteId: string;
  lifecycle: "DRAFT" | "IN_REVIEW" | "ACTIVE" | "INACTIVE";
};

type MessagesResponse = {
  messages: SiteMessageRecord[];
  nextCursor: string | null;
};

export function MessagesSection({ siteId, lifecycle }: Props) {
  const base = `/v1/sites/${encodeURIComponent(siteId)}`;
  const [messages, setMessages] = useState<SiteMessageRecord[]>([]);
  const [muralEnabled, setMuralEnabled] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [muralLoaded, setMuralLoaded] = useState(false);
  const [retryCursor, setRetryCursor] = useState<string | undefined>();
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [removeTarget, setRemoveTarget] = useState<SiteMessageRecord | null>(
    null,
  );
  const requestVersion = useRef(0);
  const searchInputRef = useRef("");
  const mutable = lifecycle !== "INACTIVE";

  const load = useCallback(
    async (cursor: string | undefined, search: string) => {
      const requestVersionForLoad = ++requestVersion.current;
      if (!cursor) setLoading(true);
      setLoadingMore(Boolean(cursor));
      setError("");
      try {
        const [response, mural] = await Promise.all([
          apiRequest<MessagesResponse>(
            `${base}/messages?${messagesQuery(search, cursor)}`,
          ),
          cursor
            ? Promise.resolve(null)
            : apiRequest<{ siteId: string; enabled: boolean }>(`${base}/mural`),
        ]);
        if (requestVersionForLoad !== requestVersion.current) return;
        setMessages((current) =>
          mergeSiteMessages(current, response.messages, Boolean(cursor)),
        );
        setNextCursor(response.nextCursor);
        if (mural) {
          setMuralEnabled(mural.enabled);
          setMuralLoaded(true);
        }
      } catch {
        if (requestVersionForLoad !== requestVersion.current) return;
        setRetryCursor(cursor);
        setError("Não foi possível carregar as mensagens. Tente novamente.");
      } finally {
        if (requestVersionForLoad === requestVersion.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [base],
  );

  useEffect(() => {
    const timeout = setTimeout(
      () => void load(undefined, searchInput),
      searchInput ? 250 : 0,
    );
    return () => {
      clearTimeout(timeout);
      requestVersion.current += 1;
    };
  }, [load, searchInput]);

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
      await load(undefined, searchInputRef.current);
    } catch (cause) {
      const message = messageAdminError(cause);
      await load(undefined, searchInputRef.current);
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
      <div
        className={`${adminStyles.surface} flex flex-wrap items-center justify-between gap-4 p-5`}
      >
        <div>
          <h2 className="m-0 font-admin-display text-xl text-admin-graphite">
            Mural de mensagens
          </h2>
          <p className="mb-0 mt-1 text-sm text-admin-muted">
            {loading
              ? "Carregando mural…"
              : !muralLoaded
                ? "Configuração indisponível"
                : muralEnabled
                  ? "Visitantes podem enviar mensagens pelo site."
                  : "Novos envios pausados. As mensagens continuam no site."}
          </p>
        </div>
        <label
          className="flex items-center gap-2.5 text-sm"
          htmlFor="mural-enabled"
        >
          <Checkbox
            id="mural-enabled"
            checked={muralEnabled}
            disabled={
              !mutable ||
              !muralLoaded ||
              loading ||
              Boolean(error) ||
              Boolean(pending)
            }
            onCheckedChange={(checked) => {
              const enabled = checked === true;
              void mutate(
                "mural",
                `${base}/mural`,
                "PATCH",
                { enabled },
                enabled
                  ? "Mural ativado. Visitantes podem publicar novas mensagens."
                  : "Mural desativado para novos envios. As mensagens existentes continuam visíveis.",
              );
            }}
          />
          Receber mensagens
        </label>
      </div>

      <div className={`${adminStyles.surface} overflow-hidden`}>
        <div className="grid gap-3 border-b border-admin-line p-5 sm:flex sm:items-center sm:justify-between">
          <h2 className="m-0 shrink-0 font-admin-display text-xl text-admin-graphite">
            Mensagens recebidas
          </h2>
          <label
            className="relative block w-full sm:max-w-sm"
            htmlFor="message-author-search"
          >
            <Search
              aria-hidden="true"
              className="absolute left-3 top-3.5 size-4 text-admin-muted"
            />
            <span className="sr-only">Buscar pelo nome de quem publicou</span>
            <Input
              id="message-author-search"
              type="search"
              value={searchInput}
              onChange={(event) => {
                requestVersion.current += 1;
                const value = event.target.value;
                searchInputRef.current = value;
                setSearchInput(value);
                setMessages([]);
                setNextCursor(null);
                setLoading(true);
                setError("");
              }}
              placeholder="Buscar por nome"
              className="min-h-11 border-admin-line bg-admin-surface pl-10"
            />
          </label>
        </div>

        {error && (
          <div className="grid gap-3 border-b border-admin-line p-5">
            <p className="m-0 text-sm text-admin-muted" role="alert">
              {error}
            </p>
            <Button
              className="w-fit"
              type="button"
              variant="outline"
              disabled={loading || loadingMore}
              onClick={() => void load(retryCursor, searchInput)}
            >
              Tentar novamente
            </Button>
          </div>
        )}
        {loading ? (
          <p className="m-0 p-5 leading-[1.6] text-admin-muted" role="status">
            Carregando mensagens…
          </p>
        ) : messages.length === 0 && !error ? (
          <p className="m-0 p-5 leading-[1.6] text-admin-muted">
            {searchInput.trim()
              ? "Nenhuma mensagem encontrada para esse nome."
              : "As mensagens dos visitantes aparecerão aqui."}
          </p>
        ) : (
          messages.map((message) => (
            <article
              key={message.id}
              className="border-b border-admin-line p-5 last:border-b-0 [@media(max-width:600px)]:p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <h3 className="m-0 break-words font-admin-display text-[1.3rem] text-admin-graphite">
                  {message.authorName}
                </h3>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={!mutable || loading || Boolean(pending)}
                  aria-label={`Remover mensagem de ${message.authorName}`}
                  onClick={() => setRemoveTarget(message)}
                >
                  {pending === `delete:${message.id}`
                    ? "Removendo…"
                    : "Remover mensagem"}
                </Button>
              </div>
              <blockquote className="mb-0 mt-4 break-words whitespace-pre-wrap text-sm leading-[1.55] text-admin-ink">
                {message.text}
              </blockquote>
              <p className="mb-0 mt-2 text-xs text-admin-muted">
                Publicada em{" "}
                <time dateTime={message.createdAt}>
                  {new Intl.DateTimeFormat("pt-BR", {
                    dateStyle: "medium",
                    timeStyle: "short",
                    timeZone: "America/Sao_Paulo",
                  }).format(new Date(message.createdAt))}
                </time>
              </p>
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
                ? `Remover a mensagem de ${removeTarget.authorName}? O texto não poderá ser recuperado.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(pending)}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={Boolean(pending)}
              onClick={() => {
                if (removeTarget)
                  void mutate(
                    `delete:${removeTarget.id}`,
                    `${base}/messages/${encodeURIComponent(removeTarget.id)}`,
                    "DELETE",
                    undefined,
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
          className="justify-self-center"
          disabled={loading || loadingMore || Boolean(pending)}
          onClick={() => void load(nextCursor, searchInput)}
        >
          {loadingMore ? "Carregando mais…" : "Ver mais mensagens"}
        </Button>
      )}
    </section>
  );
}
