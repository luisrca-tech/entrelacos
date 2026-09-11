import type { MeResponse, SiteRecord } from "@entrelacos/contracts";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { ApiError, apiRequest } from "../lib/apiClient";
import { SiteWorkspace } from "./SiteWorkspace";

export function Panel({ siteId }: { siteId?: string }) {
  const [actor, setActor] = useState<MeResponse | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    apiRequest<MeResponse>("/v1/me")
      .then((value) => {
        if (active) setActor(value);
      })
      .catch((cause) => {
        if (!active) return;
        if (cause instanceof ApiError && cause.status === 401)
          window.location.replace("/login");
        else
          setError(
            cause instanceof Error
              ? cause.message
              : "Não foi possível abrir o painel.",
          );
      });
    return () => {
      active = false;
    };
  }, []);
  async function logout() {
    try {
      await apiRequest("/v1/auth/sign-out", { method: "POST", body: {} });
      window.location.replace("/login");
    } catch {
      setError("Não foi possível sair. Tente novamente.");
    }
  }
  return (
    <main className="page-shell panel-shell">
      <header className="topbar">
        <Link className="brand" to="/">
          EntreLaços
        </Link>
        {actor && (
          <div className="inline-actions">
            <span>{actor.user.name}</span>
            <button type="button" onClick={logout}>
              Sair
            </button>
          </div>
        )}
      </header>
      {error ? (
        <p role="alert">{error}</p>
      ) : !actor ? (
        <p role="status">Carregando painel…</p>
      ) : siteId || actor.user.role === "SITE_ADMIN" ? (
        <SiteWorkspace
          siteId={siteId ?? actor.siteId ?? ""}
          owner={actor.user.role === "OWNER"}
        />
      ) : (
        <OwnerSites />
      )}
      <footer className="page-footer">
        EntreLaços · Painel administrativo
      </footer>
    </main>
  );
}

function OwnerSites() {
  const [sites, setSites] = useState<SiteRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const load = useCallback(async (next?: string) => {
    const result = await apiRequest<{
      sites: SiteRecord[];
      nextCursor: string | null;
    }>(`/v1/owner/sites${next ? `?cursor=${encodeURIComponent(next)}` : ""}`);
    setSites((previous) =>
      next ? [...previous, ...result.sites] : result.sites,
    );
    setCursor(result.nextCursor);
  }, []);
  useEffect(() => {
    load().catch((cause) => setError(cause.message));
  }, [load]);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError("");
    try {
      const result = await apiRequest<{ site: SiteRecord }>("/v1/owner/sites", {
        method: "POST",
        body: {
          repositorySlug: form.get("slug"),
          provisioningKey: form.get("key"),
          displayName: form.get("name"),
          coupleNames: [form.get("first"), form.get("second")],
          eventDate: form.get("date"),
        },
      });
      window.location.assign(`/sites/${encodeURIComponent(result.site.id)}`);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível criar o casamento.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <section className="panel-heading">
        <p className="eyebrow">Gestão global</p>
        <h1>Casamentos</h1>
        <p>
          Escolha um casamento para acompanhar seu status e gerenciar os
          acessos.
        </p>
      </section>
      {error && <p role="alert">{error}</p>}
      <section className="site-grid" aria-label="Casamentos cadastrados">
        {sites.map((site) => (
          <a className="site-card" href={`/sites/${site.id}`} key={site.id}>
            <h2>{site.displayName}</h2>
            <p>{site.coupleNames.join(" & ")}</p>
            <p>
              {site.eventDate} · {lifecycleLabel(site.lifecycle)}
            </p>
          </a>
        ))}
        {sites.length === 0 && <p>Nenhum casamento cadastrado.</p>}
      </section>
      {cursor && (
        <button
          type="button"
          onClick={() => load(cursor).catch((cause) => setError(cause.message))}
        >
          Carregar mais
        </button>
      )}
      <details className="panel-section">
        <summary>Criar ou retomar cadastro de casamento</summary>
        <p>
          Use a mesma referência e o mesmo identificador nas tentativas de um
          cadastro. Os dados já salvos serão preservados.
        </p>
        <form className="data-form form-grid" onSubmit={create}>
          <label>
            Nome do casamento
            <input name="name" required maxLength={160} />
          </label>
          <label>
            Identificador do site
            <input
              name="slug"
              required
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              maxLength={64}
              placeholder="ana-e-joao"
            />
          </label>
          <label>
            Referência do cadastro
            <input
              name="key"
              required
              maxLength={160}
              placeholder="casamento-ana-joao-2027"
            />
          </label>
          <label>
            Data do casamento
            <input name="date" type="date" required />
          </label>
          <label>
            Primeiro nome do casal
            <input name="first" required maxLength={120} />
          </label>
          <label>
            Segundo nome do casal
            <input name="second" required maxLength={120} />
          </label>
          <button type="submit" disabled={pending}>
            {pending ? "Salvando…" : "Abrir cadastro"}
          </button>
        </form>
      </details>
    </>
  );
}

export function lifecycleLabel(value: string) {
  return (
    (
      {
        DRAFT: "Rascunho",
        IN_REVIEW: "Em revisão",
        ACTIVE: "Ativo",
        INACTIVE: "Inativo",
      } as Record<string, string>
    )[value] ?? value
  );
}
