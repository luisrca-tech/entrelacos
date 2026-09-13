import type {
  adminSummarySchema,
  SiteRecord,
  siteDomainRecordSchema,
} from "@entrelacos/contracts";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { ApiError, apiRequest } from "../lib/apiClient";
import { GuestGroupsSection } from "./GuestGroupsSection";
import { MessagesSection } from "./MessagesSection";
import { RsvpSection } from "./RsvpSection";
import { SmsUsageSection } from "./SmsUsageSection";
import { publicSiteHandoffUrl } from "./sitePublicUrl";

const labels: Record<string, string> = {
  DRAFT: "Rascunho",
  IN_REVIEW: "Em revisão",
  ACTIVE: "Ativo",
  INACTIVE: "Inativo",
  UNPUBLISHED: "Não publicado",
  PUBLISHED: "Publicado",
  PLACEHOLDER: "Página neutra",
  NONE: "Não configurado",
  PENDING: "Pendente",
  DISABLED: "Desativado",
};
type InternalField =
  | "repositorySlug"
  | "provisioningKey"
  | "trustedOrigins"
  | "reviewApprovedAt"
  | "createdAt"
  | "updatedAt";
type SiteView = Omit<SiteRecord, InternalField> &
  Partial<Pick<SiteRecord, InternalField>>;
type Admin = typeof adminSummarySchema._output;
type Domain = typeof siteDomainRecordSchema._output;

export function SiteWorkspace({
  siteId,
  owner,
}: {
  siteId: string;
  owner: boolean;
}) {
  const [site, setSite] = useState<SiteView | null>(null);
  const [admins, setAdmins] = useState<Admin[]>([]);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [error, setError] = useState("");
  const [fatal, setFatal] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [accessLink, setAccessLink] = useState("");
  const base = `/v1/owner/sites/${encodeURIComponent(siteId)}`;
  const load = useCallback(async () => {
    const result = await apiRequest<{ site: SiteView }>(
      owner ? base : `/v1/sites/${encodeURIComponent(siteId)}`,
    );
    setSite(result.site);
    if (owner) {
      const [users, names] = await Promise.all([
        apiRequest<{ admins: Admin[] }>(`${base}/admins`),
        apiRequest<{ domains: Domain[] }>(`${base}/domains`),
      ]);
      setAdmins(users.admins);
      setDomains(names.domains);
    }
  }, [base, owner, siteId]);
  useEffect(() => {
    load().catch((cause) => {
      setFatal(true);
      setError(
        cause instanceof ApiError && cause.status === 404
          ? "Acesso negado ou casamento não encontrado."
          : cause.message,
      );
    });
  }, [load]);
  async function mutate(path: string, body: unknown, method = "POST") {
    setPending(true);
    setError("");
    setNotice("");
    try {
      await apiRequest(path, { method, body });
      await load();
      setNotice("Alteração salva.");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Não foi possível salvar.",
      );
    } finally {
      setPending(false);
    }
  }
  function submit(
    event: FormEvent<HTMLFormElement>,
    path: string,
    body: (form: FormData) => unknown,
    method = "POST",
  ) {
    event.preventDefault();
    void mutate(path, body(new FormData(event.currentTarget)), method);
  }
  async function issue(admin: Admin, purpose: "ACTIVATION" | "RECOVERY") {
    setPending(true);
    setError("");
    setAccessLink("");
    try {
      const result = await apiRequest<{ token: string }>(
        `/v1/owner/admins/${admin.userId}/access`,
        { method: "POST", body: { userId: admin.userId, purpose } },
      );
      setAccessLink(
        `${window.location.origin}/${purpose === "ACTIVATION" ? "activate" : "recover"}#token=${result.token}`,
      );
      setNotice(
        `Link para ${admin.email}. Entregue em particular. Válido por 24 horas; substitui o link anterior da mesma finalidade.`,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível gerar o link.",
      );
    } finally {
      setPending(false);
    }
  }
  if (fatal)
    return (
      <section className="panel-section">
        <h1>Acesso indisponível</h1>
        <p role="alert">{error}</p>
        <a href="/login">Entrar novamente</a>
      </section>
    );
  if (!site) return <p role="status">Carregando casamento…</p>;
  return (
    <>
      <section className="panel-heading">
        {owner && <a href="/">← Todos os casamentos</a>}
        <p className="eyebrow">
          {owner ? "Gestão do casamento" : "Seu casamento"}
        </p>
        <h1>{site.displayName}</h1>
        <p>{site.coupleNames.join(" & ")}</p>
        <span className="status-pill">{labels[site.lifecycle]}</span>
      </section>
      {error && (
        <p role="alert">
          {error} <a href="/login">Login</a>
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {accessLink && (
        <div className="panel-section">
          <label>
            Link de acesso
            <input
              className="access-link"
              value={accessLink}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <button
            type="button"
            onClick={() => {
              setAccessLink("");
              setNotice("");
            }}
          >
            Ocultar link
          </button>
        </div>
      )}
      {site.lifecycle === "INACTIVE" && (
        <p className="notice">
          Casamento inativo. Os dados estão preservados e a consulta permanece
          disponível.
          {owner
            ? " A publicação da página neutra em todos os endereços é uma etapa manual separada."
            : " Alterações estão indisponíveis enquanto o site estiver inativo."}
        </p>
      )}
      <section className="facts panel-section" aria-label="Status e datas">
        <div>
          <strong>Casamento</strong>
          <p>{site.eventDate}</p>
        </div>
        <div>
          <strong>Vigência</strong>
          <p>
            {site.termStartsOn
              ? `${site.termStartsOn} a ${site.termEndsOn}`
              : "Aguardando aprovação"}
          </p>
        </div>
        <div>
          <strong>Publicação</strong>
          <p>{labels[site.publicationState]}</p>
        </div>
        {site.publicUrl && (
          <div>
            <a
              className="primary-action"
              href={publicSiteHandoffUrl(site.publicUrl)}
            >
              Ir para o site
            </a>
          </div>
        )}
      </section>
      <GuestGroupsSection
        siteId={site.id}
        lifecycle={site.lifecycle}
        owner={owner}
        isDemo={site.isDemo}
      />
      <RsvpSection siteId={site.id} lifecycle={site.lifecycle} />
      <MessagesSection siteId={site.id} lifecycle={site.lifecycle} />
      <SmsUsageSection
        siteId={site.id}
        lifecycle={site.lifecycle}
        owner={owner}
      />
      {!owner && (
        <section className="panel-section">
          <h2>Visão do casamento</h2>
          <p>
            Consulte aqui o status, a data e a vigência do seu site. Para
            ajustes de cadastro ou acesso, fale com o responsável.
          </p>
        </section>
      )}
      {owner && (
        <>
          <section className="panel-section">
            <h2>Ciclo de vida</h2>
            <div className="inline-actions">
              {site.lifecycle === "DRAFT" && (
                <button
                  disabled={pending}
                  type="button"
                  onClick={() => mutate(`${base}/review/start`, {})}
                >
                  Enviar para revisão
                </button>
              )}
              {site.lifecycle === "IN_REVIEW" && (
                <button
                  disabled={pending}
                  type="button"
                  onClick={() => mutate(`${base}/review/approve`, {})}
                >
                  Aprovar e iniciar vigência
                </button>
              )}
              {site.lifecycle === "INACTIVE" ? (
                <button
                  disabled={pending}
                  type="button"
                  onClick={() => mutate(`${base}/reactivate`, {})}
                >
                  Reativar casamento
                </button>
              ) : (
                <button
                  disabled={pending}
                  type="button"
                  onClick={() => mutate(`${base}/deactivate`, {})}
                >
                  Inativar casamento
                </button>
              )}
            </div>
            <p>
              A aprovação inicia um ano de vigência. O vencimento não inativa o
              casamento automaticamente.
            </p>
          </section>
          <details className="panel-section">
            <summary>Cadastro, publicação e datas</summary>
            <form
              key={`profile-${site.updatedAt}`}
              className="data-form form-grid"
              onSubmit={(event) =>
                submit(
                  event,
                  base,
                  (form) => ({
                    displayName: form.get("name"),
                    coupleNames: [form.get("first"), form.get("second")],
                    publicUrl: form.get("url") || null,
                    trustedOrigins: String(form.get("origins"))
                      .split(/\s+/)
                      .filter(Boolean),
                  }),
                  "PATCH",
                )
              }
            >
              <label>
                Nome do casamento
                <input
                  name="name"
                  required
                  maxLength={160}
                  defaultValue={site.displayName}
                />
              </label>
              <label>
                Primeiro nome
                <input
                  name="first"
                  required
                  maxLength={120}
                  defaultValue={site.coupleNames[0]}
                />
              </label>
              <label>
                Segundo nome
                <input
                  name="second"
                  required
                  maxLength={120}
                  defaultValue={site.coupleNames[1]}
                />
              </label>
              <label>
                Endereço público
                <input
                  name="url"
                  type="url"
                  defaultValue={site.publicUrl ?? ""}
                />
              </label>
              <label>
                Origens autorizadas (uma por linha)
                <textarea
                  name="origins"
                  rows={3}
                  defaultValue={site.trustedOrigins?.join("\n") ?? ""}
                  placeholder="https://casamento.exemplo.com"
                />
              </label>
              <button disabled={pending} type="submit">
                Salvar cadastro
              </button>
            </form>
            <form
              key={`dates-${site.updatedAt}`}
              className="data-form form-grid"
              onSubmit={(event) =>
                submit(
                  event,
                  `${base}/dates`,
                  (form) => ({
                    eventDate: form.get("date"),
                    ...(site.termStartsOn
                      ? {
                          termStartsOn: form.get("start"),
                          termEndsOn: form.get("end"),
                        }
                      : {}),
                  }),
                  "PATCH",
                )
              }
            >
              <label>
                Data do casamento
                <input
                  name="date"
                  type="date"
                  required
                  defaultValue={site.eventDate}
                />
              </label>
              {site.termStartsOn && (
                <>
                  <label>
                    Início da vigência
                    <input
                      name="start"
                      type="date"
                      required
                      defaultValue={site.termStartsOn}
                    />
                  </label>
                  <label>
                    Fim da vigência
                    <input
                      name="end"
                      type="date"
                      required
                      defaultValue={site.termEndsOn ?? ""}
                    />
                  </label>
                </>
              )}
              <button disabled={pending} type="submit">
                Salvar datas
              </button>
            </form>
            <form
              className="data-form"
              onSubmit={(event) =>
                submit(
                  event,
                  `${base}/publication`,
                  (form) => ({ publicationState: form.get("publication") }),
                  "PATCH",
                )
              }
            >
              <label>
                Publicação registrada
                <select
                  name="publication"
                  key={site.publicationState}
                  defaultValue={site.publicationState}
                >
                  <option value="UNPUBLISHED">Não publicado</option>
                  <option value="PUBLISHED">Publicado</option>
                  <option value="PLACEHOLDER">Página neutra</option>
                </select>
              </label>
              <p>
                Registre após verificar a publicação. Esta ação não altera a
                hospedagem.
              </p>
              <button disabled={pending} type="submit">
                Registrar publicação
              </button>
            </form>
          </details>
          <section className="panel-section">
            <h2>Administradores</h2>
            {admins.map((admin) => (
              <article className="record-row" key={admin.userId}>
                <h3>{admin.name}</h3>
                <p>
                  {admin.email} · {labels[admin.state]}
                </p>
                <div className="inline-actions">
                  {admin.state !== "DISABLED" && (
                    <>
                      <button
                        disabled={pending}
                        type="button"
                        onClick={() =>
                          issue(
                            admin,
                            admin.state === "PENDING"
                              ? "ACTIVATION"
                              : "RECOVERY",
                          )
                        }
                      >
                        {admin.state === "PENDING"
                          ? "Gerar link de ativação"
                          : "Gerar link de recuperação"}
                      </button>
                      <button
                        disabled={pending}
                        type="button"
                        onClick={() => {
                          setAccessLink("");
                          void mutate(
                            `/v1/owner/admins/${admin.userId}/access/revoke`,
                            {
                              userId: admin.userId,
                              purpose:
                                admin.state === "PENDING"
                                  ? "ACTIVATION"
                                  : "RECOVERY",
                            },
                          );
                        }}
                      >
                        Revogar link
                      </button>
                      <button
                        disabled={pending}
                        type="button"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Desativar o acesso de ${admin.name} e encerrar todas as sessões?`,
                            )
                          ) {
                            setAccessLink("");
                            void mutate(
                              `/v1/owner/admins/${admin.userId}/disable`,
                              { userId: admin.userId },
                            );
                          }
                        }}
                      >
                        Desativar acesso
                      </button>
                    </>
                  )}
                </div>
              </article>
            ))}
            <form
              className="data-form form-grid"
              onSubmit={(event) =>
                submit(event, `${base}/admins`, (form) => ({
                  name: form.get("name"),
                  email: form.get("email"),
                }))
              }
            >
              <label>
                Nome do administrador
                <input name="name" required maxLength={160} />
              </label>
              <label>
                E-mail
                <input name="email" type="email" required maxLength={320} />
              </label>
              <button disabled={pending} type="submit">
                Adicionar administrador
              </button>
            </form>
          </section>
          <section className="panel-section">
            <h2>Domínios</h2>
            {domains.map((domain) => (
              <form
                className="data-form form-grid record-row"
                key={`${domain.id}-${domain.updatedAt}`}
                onSubmit={(event) =>
                  submit(
                    event,
                    `${base}/domains/${domain.id}`,
                    (form) => ({
                      state: form.get("state"),
                      isPrimary: form.get("primary") === "on",
                      expiresOn: form.get("expiry") || null,
                    }),
                    "PATCH",
                  )
                }
              >
                <h3>{domain.hostname}</h3>
                <label>
                  Estado
                  <select name="state" defaultValue={domain.state}>
                    {["NONE", "PENDING", "ACTIVE", "INACTIVE"].map((state) => (
                      <option key={state} value={state}>
                        {labels[state]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Renovação
                  <input
                    name="expiry"
                    type="date"
                    defaultValue={domain.expiresOn ?? ""}
                  />
                </label>
                <label className="checkbox-label">
                  <input
                    name="primary"
                    type="checkbox"
                    defaultChecked={domain.isPrimary}
                  />
                  Domínio principal
                </label>
                <button disabled={pending} type="submit">
                  Salvar domínio
                </button>
              </form>
            ))}
            <form
              className="data-form form-grid"
              onSubmit={(event) =>
                submit(event, `${base}/domains`, (form) => ({
                  hostname: String(form.get("hostname")).trim().toLowerCase(),
                  isPrimary: form.get("primary") === "on",
                  expiresOn: form.get("expiry") || null,
                }))
              }
            >
              <label>
                Domínio
                <input
                  name="hostname"
                  placeholder="casamento.exemplo.com"
                  required
                  maxLength={253}
                />
              </label>
              <label>
                Renovação
                <input name="expiry" type="date" />
              </label>
              <label className="checkbox-label">
                <input name="primary" type="checkbox" />
                Domínio principal
              </label>
              <button disabled={pending} type="submit">
                Registrar domínio
              </button>
            </form>
            <p>
              DNS, hospedagem e renovação são operações manuais. O registro não
              as executa.
            </p>
          </section>
        </>
      )}
    </>
  );
}
