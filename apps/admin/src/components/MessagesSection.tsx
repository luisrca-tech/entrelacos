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
  Badge,
  Button,
  Checkbox,
  Input,
  toast,
} from "@entrelacos/ui";
import { MessageCircle, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { adminStyles } from "../lib/adminStyles";
import { apiRequest } from "../lib/apiClient";
import { getInitials } from "./adminNavigation";
import { LoadMoreButton } from "./LoadMoreButton";
import { mergeSiteMessages, messageAdminError } from "./messageAdmin";
import { messagesQuery } from "./messageSearch";
import { OverflowMenu } from "./OverflowMenu";

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
        <div className="flex min-w-0 flex-[1_1_16rem] items-center gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-admin-success-wash text-admin-success-ink">
            <MessageCircle aria-hidden="true" className="size-5" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="m-0 font-admin-display text-xl text-admin-graphite">
                Mural no site
              </h2>
              {muralLoaded && (
                <Badge
                  variant="secondary"
                  className={
                    muralEnabled
                      ? "bg-admin-success-wash text-admin-success-ink"
                      : "bg-admin-beige text-admin-muted"
                  }
                >
                  {muralEnabled ? "Recebendo mensagens" : "Envios pausados"}
                </Badge>
              )}
            </div>
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
        </div>
        <label
          className="flex shrink-0 items-center gap-2.5 rounded-lg border border-admin-line bg-admin-canvas px-3 py-2 text-sm"
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

      <div className="grid gap-4">
        <div className="grid gap-3 sm:flex sm:items-center sm:justify-between">
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
          searchInput.trim() ? (
            <p
              className={`${adminStyles.surface} m-0 px-5 py-12 text-center text-admin-muted`}
            >
              Nenhuma mensagem encontrada para esse nome.
            </p>
          ) : (
            <div
              className={`${adminStyles.surface} grid max-w-full gap-2 p-6 sm:p-8`}
            >
              <span className="mb-2 grid size-11 place-items-center rounded-xl bg-admin-terracotta-wash text-admin-terracotta-deep">
                <MessageCircle aria-hidden="true" className="size-5" />
              </span>
              <h3 className="text-admin-graphite">Nenhuma mensagem ainda</h3>
              <p className="m-0 text-sm font-semibold text-admin-ink">
                As mensagens dos visitantes aparecerão aqui.
              </p>
              <p className="m-0 max-w-xl text-sm leading-relaxed text-admin-muted">
                Quando alguém deixar um recado no mural do site, ele aparece
                nesta página. Vocês podem ler tudo e remover o que não quiserem
                manter publicado.
              </p>
            </div>
          )
        ) : (
          <div className="grid items-start gap-4 md:grid-cols-2">
            {messages.map((message) => (
              <article
                key={message.id}
                className={`${adminStyles.surface} min-w-0 p-5 [@media(max-width:600px)]:p-4`}
              >
                <div className="flex min-w-0 items-start gap-3">
                  <span
                    aria-hidden="true"
                    className="grid size-9 shrink-0 place-items-center rounded-full bg-admin-terracotta-wash text-xs font-bold text-admin-terracotta-deep"
                  >
                    {getInitials(message.authorName)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="m-0 break-words font-admin-display text-xl! text-admin-ink">
                      {message.authorName}
                    </h3>
                    <p className="m-0 mt-1 text-xs text-admin-muted">
                      Publicada em{" "}
                      <time dateTime={message.createdAt}>
                        {new Intl.DateTimeFormat("pt-BR", {
                          dateStyle: "medium",
                          timeStyle: "short",
                          timeZone: "America/Sao_Paulo",
                        }).format(new Date(message.createdAt))}
                      </time>
                    </p>
                  </div>
                  <OverflowMenu
                    label={`Ações da mensagem de ${message.authorName}`}
                    items={[
                      {
                        id: "remove",
                        label: "Remover mensagem",
                        variant: "destructive",
                      },
                    ]}
                    disabled={!mutable || loading || Boolean(pending)}
                    onSelect={() => setRemoveTarget(message)}
                  />
                </div>
                <blockquote className="m-0 mt-3 break-words whitespace-pre-wrap text-sm leading-relaxed text-admin-body">
                  {message.text}
                </blockquote>
              </article>
            ))}
          </div>
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
          {removeTarget && (
            <blockquote className="m-0 line-clamp-3 break-words rounded-lg bg-admin-beige p-3 text-sm text-admin-body">
              {removeTarget.text}
            </blockquote>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(pending)}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              className={adminStyles.dangerButton}
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

      <LoadMoreButton
        cursor={nextCursor}
        onLoad={(cursor) => load(cursor, searchInput)}
        loading={loadingMore}
        disabled={loading || Boolean(pending)}
        manualOnly={Boolean(error)}
        label="Ver mais mensagens"
        className="justify-self-center"
      />
    </section>
  );
}
