import type {
  RsvpDeadline,
  RsvpHistoryResponse,
  RsvpState,
  SiteRsvpResponse,
} from "@entrelacos/contracts";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  DatePicker,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@entrelacos/ui";
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
  joinDeadlineLocal,
  resetDeadlineDraft,
  splitDeadlineLocal,
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
  const [savedDeadline, setSavedDeadline] = useState({
    deadlineLocal: "",
    deadlineTimezone:
      Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Sao_Paulo",
  });
  const [deadlineDate, setDeadlineDate] = useState("");
  const [deadlineTime, setDeadlineTime] = useState("");
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
  const [deadlineOpen, setDeadlineOpen] = useState(false);

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
      const nextDeadlineTimezone =
        result.deadlineTimezone ||
        Intl.DateTimeFormat().resolvedOptions().timeZone ||
        "America/Sao_Paulo";
      const nextDeadlineLocal =
        result.deadlineAt && result.deadlineTimezone
          ? deadlineLocalFromInstant(result.deadlineAt, result.deadlineTimezone)
          : "";
      const nextSavedDeadline = resetDeadlineDraft({
        deadlineLocal: nextDeadlineLocal,
        deadlineTimezone: nextDeadlineTimezone,
      });
      setSavedDeadline(nextSavedDeadline);
      setDeadlineTimezone(nextSavedDeadline.deadlineTimezone);
      const deadlineParts = splitDeadlineLocal(nextSavedDeadline.deadlineLocal);
      setDeadlineDate(deadlineParts.date);
      setDeadlineTime(deadlineParts.time);
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

  function beginDeadlineEdit(clear = false) {
    const draft = resetDeadlineDraft(savedDeadline);
    const deadlineParts = splitDeadlineLocal(clear ? "" : draft.deadlineLocal);
    setDeadlineDate(deadlineParts.date);
    setDeadlineTime(deadlineParts.time);
    setDeadlineTimezone(draft.deadlineTimezone);
    setError("");
    setDeadlineOpen(true);
  }

  function cancelDeadlineEdit() {
    const draft = resetDeadlineDraft(savedDeadline);
    const deadlineParts = splitDeadlineLocal(draft.deadlineLocal);
    setDeadlineDate(deadlineParts.date);
    setDeadlineTime(deadlineParts.time);
    setDeadlineTimezone(draft.deadlineTimezone);
    setError("");
    setDeadlineOpen(false);
  }

  async function saveDeadline(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inactive) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const deadlineLocal = joinDeadlineLocal(deadlineDate, deadlineTime);
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
      const nextSavedDeadline = resetDeadlineDraft({
        deadlineLocal,
        deadlineTimezone: deadlineLocal
          ? deadlineTimezone
          : savedDeadline.deadlineTimezone,
      });
      setSavedDeadline(nextSavedDeadline);
      setNotice(
        deadlineLocal ? "Prazo de confirmação salvo." : "Prazo removido.",
      );
      setDeadlineOpen(false);
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
          <Button
            type="button"
            variant={tab === "current" ? "default" : "outline"}
            role="tab"
            aria-selected={tab === "current"}
            onClick={() => setTab("current")}
          >
            Atual
          </Button>
          <Button
            type="button"
            variant={tab === "history" ? "default" : "outline"}
            role="tab"
            aria-selected={tab === "history"}
            onClick={() => setTab("history")}
          >
            Histórico
          </Button>
        </div>
      </div>
      {error && !deadlineOpen && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      {tab === "current" ? (
        <>
          <Card className="rsvp-deadline-summary">
            <CardHeader>
              <CardTitle>Prazo de confirmação</CardTitle>
              <CardDescription>
                {savedDeadline.deadlineLocal
                  ? `${savedDeadline.deadlineLocal} · ${savedDeadline.deadlineTimezone}`
                  : "Nenhum prazo configurado."}
              </CardDescription>
            </CardHeader>
            <CardContent className="inline-actions">
              <Button
                type="button"
                disabled={inactive || pending}
                onClick={() => beginDeadlineEdit()}
              >
                Editar prazo
              </Button>
              {savedDeadline.deadlineLocal && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={inactive || pending}
                  onClick={() => beginDeadlineEdit(true)}
                >
                  Remover prazo
                </Button>
              )}
            </CardContent>
          </Card>
          <Dialog
            open={deadlineOpen}
            onOpenChange={(open) => {
              if (open) beginDeadlineEdit();
              else cancelDeadlineEdit();
            }}
          >
            <DialogContent>
              <DialogTitle>Editar prazo de confirmação</DialogTitle>
              <DialogDescription>
                Use a data e hora local junto do fuso IANA correspondente.
              </DialogDescription>
              {error && <p role="alert">{error}</p>}
              <form
                className="data-form form-grid rsvp-deadline-form"
                onSubmit={saveDeadline}
              >
                <label htmlFor="rsvp-deadline-date">
                  Data do prazo
                  <DatePicker
                    id="rsvp-deadline-date"
                    value={deadlineDate || undefined}
                    disabled={inactive || pending}
                    onValueChange={(value) => {
                      setDeadlineDate(value ?? "");
                      if (!value) setDeadlineTime("");
                    }}
                  />
                </label>
                <label htmlFor="rsvp-deadline-time">
                  Horário do prazo
                  <Input
                    id="rsvp-deadline-time"
                    type="time"
                    value={deadlineTime}
                    disabled={inactive || pending || !deadlineDate}
                    onChange={(event) => setDeadlineTime(event.target.value)}
                  />
                </label>
                <label htmlFor="rsvp-deadline-timezone">
                  Fuso horário
                  <Input
                    id="rsvp-deadline-timezone"
                    value={deadlineTimezone}
                    disabled={
                      inactive || pending || !deadlineDate || !deadlineTime
                    }
                    onChange={(event) =>
                      setDeadlineTimezone(event.target.value)
                    }
                    placeholder="America/Sao_Paulo"
                  />
                </label>
                <div className="inline-actions">
                  <Button type="submit" disabled={inactive || pending}>
                    {pending ? "Salvando…" : "Salvar prazo"}
                  </Button>
                  <DialogClose
                    render={
                      <Button
                        type="button"
                        variant="outline"
                        disabled={pending}
                      />
                    }
                    onClick={cancelDeadlineEdit}
                  >
                    Cancelar
                  </DialogClose>
                </div>
              </form>
            </DialogContent>
          </Dialog>

          {view && (
            <Card className="facts" aria-label="Totais de confirmação">
              <CardContent>
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
              </CardContent>
            </Card>
          )}
          <div className="data-form form-grid rsvp-filters">
            <label htmlFor="rsvp-group-filter">
              Grupo
              <Select
                value={groupId || "all"}
                onValueChange={(value) =>
                  setGroupId(value === "all" || !value ? "" : value)
                }
              >
                <SelectTrigger id="rsvp-group-filter">
                  <SelectValue placeholder="Todos" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  {knownGroups.map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label htmlFor="rsvp-state-filter">
              Status
              <Select
                value={state || "all"}
                onValueChange={(value) =>
                  setState(value === "all" || !value ? "" : value)
                }
              >
                <SelectTrigger id="rsvp-state-filter">
                  <SelectValue placeholder="Todos" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  {Object.entries(stateLabels).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>
          <Card className="rsvp-export" aria-labelledby="rsvp-export-title">
            <CardHeader>
              <CardTitle id="rsvp-export-title">Exportar relatório</CardTitle>
              <CardDescription>
                O arquivo usa os filtros de grupo e status selecionados acima.
                Telefones ficam de fora até você incluí-los explicitamente.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <label className="checkbox-label" htmlFor="rsvp-include-phone">
                <Checkbox
                  id="rsvp-include-phone"
                  checked={includePhone}
                  disabled={Boolean(downloading)}
                  onCheckedChange={(checked) =>
                    setIncludePhone(checked === true)
                  }
                />
                Incluir celular do representante
              </label>
              <div className="inline-actions">
                <Button
                  type="button"
                  disabled={Boolean(downloading)}
                  onClick={() => void downloadExport("csv")}
                >
                  {downloading === "csv" ? "Gerando CSV…" : "Baixar CSV"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={Boolean(downloading)}
                  onClick={() => void downloadExport("pdf")}
                >
                  {downloading === "pdf" ? "Gerando PDF…" : "Baixar PDF"}
                </Button>
              </div>
            </CardContent>
          </Card>
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
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Convidado</TableHead>
                        <TableHead>Confirmação</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {group.members.map((member) => (
                        <TableRow key={member.id}>
                          <TableCell>
                            {member.fullName}
                            {member.isRepresentative ? " (representante)" : ""}
                          </TableCell>
                          <TableCell>
                            <Select
                              value={drafts[member.id] ?? member.state}
                              disabled={inactive || pending}
                              onValueChange={(value) =>
                                setDrafts((current) => ({
                                  ...current,
                                  [member.id]: value as RsvpState,
                                }))
                              }
                            >
                              <SelectTrigger
                                aria-label={`Confirmação de ${member.fullName}`}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {Object.entries(stateLabels).map(
                                  ([value, label]) => (
                                    <SelectItem key={value} value={value}>
                                      {label}
                                    </SelectItem>
                                  ),
                                )}
                              </SelectContent>
                            </Select>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </section>
              ))}
            </div>
          )}
          <Button
            type="button"
            disabled={inactive || pending || changedMembers.length === 0}
            onClick={() => void saveRsvp()}
          >
            {changedMembers.length === 0
              ? "Salvar alterações"
              : `Salvar ${changedMembers.length} ${changedMembers.length === 1 ? "alteração" : "alterações"}`}
          </Button>
        </>
      ) : (
        <>
          <div className="data-form form-grid rsvp-filters">
            <label htmlFor="rsvp-history-group">
              Grupo
              <Select
                value={historyGroupId || "all"}
                onValueChange={(value) => {
                  setHistoryGroupId(value === "all" || !value ? "" : value);
                  setHistoryMemberId("");
                }}
              >
                <SelectTrigger id="rsvp-history-group">
                  <SelectValue placeholder="Todos" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  {knownGroups.map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label htmlFor="rsvp-history-member">
              Integrante
              <Select
                value={historyMemberId || "all"}
                onValueChange={(value) =>
                  setHistoryMemberId(value === "all" || !value ? "" : value)
                }
              >
                <SelectTrigger id="rsvp-history-member">
                  <SelectValue placeholder="Todos" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
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
                      <SelectItem key={member.id} value={member.id}>
                        {member.label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </label>
            <label htmlFor="rsvp-history-actor">
              Origem
              <Select
                value={historyActor || "all"}
                onValueChange={(value) =>
                  setHistoryActor(value === "all" || !value ? "" : value)
                }
              >
                <SelectTrigger id="rsvp-history-actor">
                  <SelectValue placeholder="Todas" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas</SelectItem>
                  <SelectItem value="FAMILY">Família</SelectItem>
                  <SelectItem value="ADMIN">Administração</SelectItem>
                </SelectContent>
              </Select>
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
            <Button
              type="button"
              variant="outline"
              disabled={loading}
              onClick={() => void loadHistory(history.nextCursor ?? "", true)}
            >
              Carregar mais
            </Button>
          )}
        </>
      )}
    </section>
  );
}
