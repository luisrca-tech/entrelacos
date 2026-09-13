import type {
  RsvpDeadline,
  RsvpHistoryResponse,
  RsvpState,
  SiteRsvpResponse,
} from "@entrelacos/contracts";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ApiError, apiRequest } from "../lib/apiClient";
import { listenForGuestGroupsChanged } from "./guestGroupsRefresh";
import {
  deadlineInstantFromLocal,
  deadlineLocalFromInstant,
} from "./rsvpDeadline";
import {
  exportFilename,
  type RsvpExportFormat,
  rsvpExportPath,
} from "./rsvpExport";

type Props = {
  siteId: string;
  lifecycle: "DRAFT" | "IN_REVIEW" | "ACTIVE" | "INACTIVE";
};

const stateLabels: Record<RsvpState, string> = {
  PENDING: "Pendente",
  CONFIRMED: "Confirmado",
  DECLINED: "Não comparecerá",
};

function errorMessage(cause: unknown) {
  if (cause instanceof ApiError) {
    if (cause.code === "RSVP_CONFLICT")
      return "Outra pessoa alterou uma confirmação. A lista foi atualizada; revise antes de salvar novamente.";
    if (cause.code === "SITE_INACTIVE")
      return "O casamento está inativo. As confirmações permanecem disponíveis somente para consulta.";
    if (cause.code === "RSVP_RESULT_REMOVED")
      return "O resultado anterior foi removido após a exclusão de um grupo. Recarregue os dados antes de salvar novamente.";
    if (cause.code === "VALIDATION_ERROR")
      return "Confira a data, o fuso horário e as confirmações informadas.";
  }
  return cause instanceof Error
    ? cause.message
    : "Não foi possível concluir a operação.";
}

function queryString(values: Record<string, string>) {
  const query = new URLSearchParams(
    Object.entries(values).filter(([, value]) => value),
  ).toString();
  return query ? `?${query}` : "";
}

export function RsvpSection({ siteId, lifecycle }: Props) {
  const base = `/v1/sites/${encodeURIComponent(siteId)}/rsvp`;
  const inactive = lifecycle === "INACTIVE";
  const [view, setView] = useState<SiteRsvpResponse | null>(null);
  const [knownGroups, setKnownGroups] = useState<SiteRsvpResponse["groups"]>(
    [],
  );
  const [groupId, setGroupId] = useState("");
  const [state, setState] = useState("");
  const [drafts, setDrafts] = useState<Record<string, RsvpState>>({});
  const [deadlineLocal, setDeadlineLocal] = useState("");
  const [deadlineTimezone, setDeadlineTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Sao_Paulo",
  );
  const [history, setHistory] = useState<RsvpHistoryResponse | null>(null);
  const [tab, setTab] = useState<"current" | "history">("current");
  const [historyGroupId, setHistoryGroupId] = useState("");
  const [historyMemberId, setHistoryMemberId] = useState("");
  const [historyActor, setHistoryActor] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [includePhone, setIncludePhone] = useState(false);
  const [downloading, setDownloading] = useState<RsvpExportFormat | null>(null);
  const [groupsVersion, setGroupsVersion] = useState(0);

  const loadCurrent = useCallback(async () => {
    void groupsVersion;
    setLoading(true);
    try {
      const result = await apiRequest<SiteRsvpResponse>(
        `${base}${queryString({ groupId, state })}`,
      );
      setView(result);
      if (!groupId && !state) setKnownGroups(result.groups);
      setDrafts({});
      setDeadlineTimezone(
        result.deadlineTimezone ||
          Intl.DateTimeFormat().resolvedOptions().timeZone ||
          "America/Sao_Paulo",
      );
      setDeadlineLocal(
        result.deadlineAt && result.deadlineTimezone
          ? deadlineLocalFromInstant(result.deadlineAt, result.deadlineTimezone)
          : "",
      );
      setError("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [base, groupId, groupsVersion, state]);

  const loadHistory = useCallback(
    async (cursor = "", append = false) => {
      setLoading(true);
      try {
        const result = await apiRequest<RsvpHistoryResponse>(
          `${base}/history${queryString({
            groupId: historyGroupId,
            memberId: historyMemberId,
            actorType: historyActor,
            cursor,
            limit: "50",
          })}`,
        );
        setHistory((current) =>
          append && current
            ? { ...result, entries: [...current.entries, ...result.entries] }
            : result,
        );
        setError("");
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setLoading(false);
      }
    },
    [base, historyActor, historyGroupId, historyMemberId],
  );

  useEffect(() => {
    void loadCurrent();
  }, [loadCurrent]);

  useEffect(
    () =>
      listenForGuestGroupsChanged(window, siteId, () => {
        setGroupId("");
        setState("");
        setGroupsVersion((current) => current + 1);
      }),
    [siteId],
  );

  useEffect(() => {
    if (tab === "history") void loadHistory();
  }, [loadHistory, tab]);

  const changedMembers = useMemo(() => {
    if (!view) return [];
    return view.groups.flatMap((group) =>
      group.members.flatMap((member) => {
        const next = drafts[member.id];
        return next && next !== member.state
          ? [
              {
                memberId: member.id,
                state: next,
                expectedRevision: member.revision,
              },
            ]
          : [];
      }),
    );
  }, [drafts, view]);

  const historyMembers = useMemo(
    () =>
      knownGroups.flatMap((group) =>
        group.members.map((member) => ({
          id: member.id,
          label: `${group.name} — ${member.fullName}`,
        })),
      ),
    [knownGroups],
  );

  async function saveDeadline(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inactive) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const body: RsvpDeadline = deadlineLocal
        ? {
            deadlineAt: deadlineInstantFromLocal(
              deadlineLocal,
              deadlineTimezone,
            ),
            deadlineTimezone,
          }
        : { deadlineAt: null, deadlineTimezone: null };
      await apiRequest<RsvpDeadline>(`${base}/deadline`, {
        method: "PATCH",
        body,
      });
      setNotice(
        deadlineLocal ? "Prazo de confirmação salvo." : "Prazo removido.",
      );
      await loadCurrent();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  async function saveRsvp() {
    if (inactive || changedMembers.length === 0) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      await apiRequest(base, {
        method: "POST",
        body: { requestId: crypto.randomUUID(), members: changedMembers },
      });
      setNotice("Confirmações salvas.");
      await loadCurrent();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "RSVP_CONFLICT") {
        const selectedDrafts = { ...drafts };
        const message = errorMessage(cause);
        await loadCurrent();
        setDrafts(selectedDrafts);
        setError(message);
      } else {
        setError(errorMessage(cause));
      }
    } finally {
      setPending(false);
    }
  }

  async function downloadExport(format: RsvpExportFormat) {
    if (downloading) return;
    setDownloading(format);
    setError("");
    setNotice("");
    try {
      const requestId = crypto.randomUUID();
      const path = rsvpExportPath(siteId, format, {
        requestId,
        includePhone,
        ...(groupId ? { groupId } : {}),
        ...(state ? { state: state as RsvpState } : {}),
      });
      const response = await fetch(`/api${path}`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) {
        const problem = (await response.json().catch(() => ({}))) as {
          code?: string;
        };
        throw new ApiError(response.status, problem.code ?? "REQUEST_FAILED");
      }
      const blobUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      anchor.download = exportFilename(
        response.headers.get("Content-Disposition"),
        `entrelacos-rsvp-${siteId}.${format}`,
      );
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
      setNotice(
        `Relatório ${format.toUpperCase()} gerado com os filtros selecionados.`,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setDownloading(null);
    }
  }

  return (
    <section className="panel-section rsvp-admin" aria-labelledby="rsvp-title">
      <div className="guest-groups-heading">
        <div>
          <h2 id="rsvp-title">Confirmações de presença</h2>
          <p>Consulte e ajuste a resposta individual de cada convidado.</p>
        </div>
        <div
          className="inline-actions"
          role="tablist"
          aria-label="Visões de confirmação"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === "current"}
            onClick={() => setTab("current")}
          >
            Atual
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "history"}
            onClick={() => setTab("history")}
          >
            Histórico
          </button>
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      {tab === "current" ? (
        <>
          <form
            className="data-form form-grid rsvp-deadline-form"
            onSubmit={saveDeadline}
          >
            <label>
              Prazo local
              <input
                type="datetime-local"
                value={deadlineLocal}
                disabled={inactive || pending}
                onChange={(event) => setDeadlineLocal(event.target.value)}
              />
            </label>
            <label>
              Fuso horário
              <input
                value={deadlineTimezone}
                disabled={inactive || pending || !deadlineLocal}
                onChange={(event) => setDeadlineTimezone(event.target.value)}
                placeholder="America/Sao_Paulo"
              />
            </label>
            <button type="submit" disabled={inactive || pending}>
              Salvar prazo
            </button>
            {deadlineLocal && (
              <button
                type="button"
                disabled={inactive || pending}
                onClick={() => setDeadlineLocal("")}
              >
                Remover prazo
              </button>
            )}
          </form>

          {view && (
            <section className="facts" aria-label="Totais de confirmação">
              <div>
                <strong>Pendentes</strong>
                <p>{view.totals.pending}</p>
              </div>
              <div>
                <strong>Confirmados</strong>
                <p>{view.totals.confirmed}</p>
              </div>
              <div>
                <strong>Não comparecerão</strong>
                <p>{view.totals.declined}</p>
              </div>
            </section>
          )}
          <div className="data-form form-grid rsvp-filters">
            <label>
              Grupo
              <select
                value={groupId}
                onChange={(event) => setGroupId(event.target.value)}
              >
                <option value="">Todos</option>
                {knownGroups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Status
              <select
                value={state}
                onChange={(event) => setState(event.target.value)}
              >
                <option value="">Todos</option>
                {Object.entries(stateLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <section className="rsvp-export" aria-labelledby="rsvp-export-title">
            <div>
              <h3 id="rsvp-export-title">Exportar relatório</h3>
              <p>
                O arquivo usa os filtros de grupo e status selecionados acima.
                Telefones ficam de fora até você incluí-los explicitamente.
              </p>
            </div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={includePhone}
                disabled={Boolean(downloading)}
                onChange={(event) => setIncludePhone(event.target.checked)}
              />
              Incluir celular do representante
            </label>
            <div className="inline-actions">
              <button
                type="button"
                disabled={Boolean(downloading)}
                onClick={() => void downloadExport("csv")}
              >
                {downloading === "csv" ? "Gerando CSV…" : "Baixar CSV"}
              </button>
              <button
                type="button"
                disabled={Boolean(downloading)}
                onClick={() => void downloadExport("pdf")}
              >
                {downloading === "pdf" ? "Gerando PDF…" : "Baixar PDF"}
              </button>
            </div>
          </section>
          {loading ? (
            <p role="status">Carregando confirmações…</p>
          ) : view?.groups.length === 0 ? (
            <p>Nenhum convidado corresponde aos filtros.</p>
          ) : (
            <div className="rsvp-group-list">
              {view?.groups.map((group) => (
                <section className="rsvp-group" key={group.id}>
                  <h3>{group.name}</h3>
                  <p>
                    {group.totals.confirmed} confirmados ·{" "}
                    {group.totals.declined} ausentes · {group.totals.pending}{" "}
                    pendentes
                  </p>
                  {group.members.map((member) => (
                    <label className="rsvp-member-row" key={member.id}>
                      <span>
                        {member.fullName}
                        {member.isRepresentative ? " (representante)" : ""}
                      </span>
                      <select
                        aria-label={`Confirmação de ${member.fullName}`}
                        value={drafts[member.id] ?? member.state}
                        disabled={inactive || pending}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [member.id]: event.target.value as RsvpState,
                          }))
                        }
                      >
                        {Object.entries(stateLabels).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </section>
              ))}
            </div>
          )}
          <button
            type="button"
            disabled={inactive || pending || changedMembers.length === 0}
            onClick={() => void saveRsvp()}
          >
            {changedMembers.length === 0
              ? "Salvar alterações"
              : `Salvar ${changedMembers.length} ${changedMembers.length === 1 ? "alteração" : "alterações"}`}
          </button>
        </>
      ) : (
        <>
          <div className="data-form form-grid rsvp-filters">
            <label>
              Grupo
              <select
                value={historyGroupId}
                onChange={(event) => {
                  setHistoryGroupId(event.target.value);
                  setHistoryMemberId("");
                }}
              >
                <option value="">Todos</option>
                {knownGroups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Integrante
              <select
                value={historyMemberId}
                onChange={(event) => setHistoryMemberId(event.target.value)}
              >
                <option value="">Todos</option>
                {historyMembers
                  .filter(
                    (member) =>
                      !historyGroupId ||
                      knownGroups
                        .find((group) => group.id === historyGroupId)
                        ?.members.some(
                          (candidate) => candidate.id === member.id,
                        ),
                  )
                  .map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.label}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Origem
              <select
                value={historyActor}
                onChange={(event) => setHistoryActor(event.target.value)}
              >
                <option value="">Todas</option>
                <option value="FAMILY">Família</option>
                <option value="ADMIN">Administração</option>
              </select>
            </label>
          </div>
          {loading ? (
            <p role="status">Carregando histórico…</p>
          ) : history?.entries.length === 0 ? (
            <p>Nenhuma alteração registrada.</p>
          ) : (
            <ol className="rsvp-history">
              {history?.entries.map((entry) => (
                <li key={entry.id}>
                  <strong>{entry.memberDisplayName}</strong> em{" "}
                  {entry.groupName}: {stateLabels[entry.beforeState]} →{" "}
                  {stateLabels[entry.afterState]}. Alterado por{" "}
                  {entry.actorDisplayName} (
                  {entry.actorType === "ADMIN" ? "administração" : "família"})
                  em{" "}
                  {new Intl.DateTimeFormat("pt-BR", {
                    dateStyle: "short",
                    timeStyle: "short",
                  }).format(new Date(entry.occurredAt))}
                  .
                </li>
              ))}
            </ol>
          )}
          {history?.nextCursor && (
            <button
              type="button"
              disabled={loading}
              onClick={() => void loadHistory(history.nextCursor ?? "", true)}
            >
              Carregar mais
            </button>
          )}
        </>
      )}
    </section>
  );
}
