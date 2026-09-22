import type {
  RsvpDeadline,
  RsvpHistoryResponse,
  RsvpState,
  SiteRsvpResponse,
} from "@entrelacos/contracts";
import {
  Badge,
  Button,
  Card,
  CardAction,
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
} from "@entrelacos/ui";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { adminStyles, displayHeading } from "../lib/adminStyles";
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

const statusFilterLabels = { all: "Todos", ...stateLabels };
const historyActorLabels = {
  all: "Todas",
  FAMILY: "Família",
  ADMIN: "Administração",
};
const demoGroupLabels: Record<string, string> = {
  "b7-group-pending": "Família Pendente",
  "b7-group-partial": "Família Parcial",
  "b7-group-confirmed": "Família Confirmada",
  "b7-group-declined": "Família Ausente",
  "b7-group-foreign": "Família Estrangeira",
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

export function rsvpFilterLabel(
  value: unknown,
  labels: Record<string, string>,
  placeholder: string,
) {
  return typeof value === "string"
    ? (labels[value] ?? placeholder)
    : placeholder;
}

export function rsvpGroupLabel(id: string, name: string) {
  return demoGroupLabels[id] ?? name;
}

function RsvpFilterField({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-w-0 flex-1 gap-2 text-[0.88rem] font-semibold text-admin-graphite">
      <span id={`${id}-label`}>{label}</span>
      {children}
    </div>
  );
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
  const [historyActor, setHistoryActor] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [includePhone, setIncludePhone] = useState(false);
  const [downloading, setDownloading] = useState<RsvpExportFormat | null>(null);
  const [groupsVersion, setGroupsVersion] = useState(0);
  const [deadlineOpen, setDeadlineOpen] = useState(false);
  const groupFilterLabels = Object.fromEntries([
    ["all", "Todos"],
    ...knownGroups.map((group) => [
      group.id,
      rsvpGroupLabel(group.id, group.name),
    ]),
  ]);

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
    [base, historyActor, historyGroupId],
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
    <section className={adminStyles.card} aria-labelledby="rsvp-title">
      <div className="flex items-end justify-between gap-3.5 [@media(max-width:760px)]:grid [@media(max-width:760px)]:grid-cols-1">
        <div>
          <h2
            className={`m-0 mb-[18px] text-[clamp(1.8rem,3vw,2.7rem)] ${displayHeading}`}
            id="rsvp-title"
          >
            Confirmações de presença
          </h2>
          <p className="leading-[1.6]">
            Consulte e ajuste a resposta individual de cada convidado.
          </p>
        </div>
        <div
          className="flex flex-wrap items-center gap-3.5"
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
      {error && !deadlineOpen && (
        <p className={adminStyles.alert} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="my-3.5 leading-[1.6] text-admin-muted" role="status">
          {notice}
        </p>
      )}

      {tab === "current" ? (
        <>
          <Card className="mb-6 rounded-[14px] border border-admin-line bg-admin-surface p-[26px] shadow-none">
            <CardHeader>
              <CardTitle>Prazo de confirmação</CardTitle>
              <CardDescription>
                {savedDeadline.deadlineLocal
                  ? `${savedDeadline.deadlineLocal} · ${savedDeadline.deadlineTimezone}`
                  : "Nenhum prazo configurado."}
              </CardDescription>
            </CardHeader>
            <CardContent className={adminStyles.inline}>
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
            <DialogContent className={adminStyles.dialog}>
              <DialogTitle
                className={`font-admin-display text-4xl font-normal ${displayHeading}`}
              >
                Editar prazo de confirmação
              </DialogTitle>
              <DialogDescription className="leading-[1.6] text-admin-muted">
                Use a data e hora local junto do fuso IANA correspondente.
              </DialogDescription>
              {error && (
                <p className={adminStyles.alert} role="alert">
                  {error}
                </p>
              )}
              <form className={adminStyles.formGrid} onSubmit={saveDeadline}>
                <label
                  className="grid gap-2 text-[0.88rem] font-semibold text-admin-graphite"
                  htmlFor="rsvp-deadline-date"
                >
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
                <label
                  className="grid gap-2 text-[0.88rem] font-semibold text-admin-graphite"
                  htmlFor="rsvp-deadline-time"
                >
                  Horário do prazo
                  <Input
                    id="rsvp-deadline-time"
                    type="time"
                    value={deadlineTime}
                    disabled={inactive || pending || !deadlineDate}
                    onChange={(event) => setDeadlineTime(event.target.value)}
                  />
                </label>
                <label
                  className="grid gap-2 text-[0.88rem] font-semibold text-admin-graphite"
                  htmlFor="rsvp-deadline-timezone"
                >
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
                <div className={adminStyles.inline}>
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
            <Card
              className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-[22px] rounded-[14px] border border-admin-line bg-admin-surface p-[26px] shadow-none"
              aria-label="Totais de confirmação"
            >
              <CardContent className="grid w-full grid-cols-[repeat(auto-fit,minmax(170px,1fr))] items-center gap-[22px]">
                <div>
                  <strong>Pendentes</strong>
                  <p className="mt-2 leading-[1.6] text-admin-muted">
                    {view.totals.pending}
                  </p>
                </div>
                <div>
                  <strong>Confirmados</strong>
                  <p className="mt-2 leading-[1.6] text-admin-muted">
                    {view.totals.confirmed}
                  </p>
                </div>
                <div>
                  <strong>Não comparecerão</strong>
                  <p className="mt-2 leading-[1.6] text-admin-muted">
                    {view.totals.declined}
                  </p>
                </div>
              </CardContent>
            </Card>
          )}
          <div className="my-7 grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] items-end gap-[18px]">
            <RsvpFilterField id="rsvp-group-filter" label="Grupo">
              <Select
                value={groupId || "all"}
                onValueChange={(value) =>
                  setGroupId(value === "all" || !value ? "" : value)
                }
              >
                <SelectTrigger
                  id="rsvp-group-filter"
                  aria-labelledby="rsvp-group-filter-label"
                >
                  <SelectValue>
                    {(value) =>
                      rsvpFilterLabel(value, groupFilterLabels, "Todos")
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  {knownGroups.map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                      {rsvpGroupLabel(group.id, group.name)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </RsvpFilterField>
            <RsvpFilterField id="rsvp-state-filter" label="Status">
              <Select
                value={state || "all"}
                onValueChange={(value) =>
                  setState(value === "all" || !value ? "" : value)
                }
              >
                <SelectTrigger
                  id="rsvp-state-filter"
                  aria-labelledby="rsvp-state-filter-label"
                >
                  <SelectValue>
                    {(value) =>
                      rsvpFilterLabel(value, statusFilterLabels, "Todos")
                    }
                  </SelectValue>
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
            </RsvpFilterField>
          </div>
          <Card
            className="my-6 items-stretch rounded-[14px] border border-admin-line bg-admin-surface p-[26px] shadow-none [&_[data-slot=card-header]]:w-full [&_h3]:mb-2"
            aria-labelledby="rsvp-export-title"
          >
            <CardHeader className="flex w-full flex-row items-start justify-between">
              <div>
                <CardTitle id="rsvp-export-title">Exportar relatório</CardTitle>
                <CardDescription>
                  O arquivo usa os filtros de grupo e status selecionados acima.
                  Telefones ficam de fora até você incluí-los explicitamente.
                </CardDescription>
              </div>
              <CardAction>
                <div className={adminStyles.inline}>
                  <Button
                    type="button"
                    size="sm"
                    disabled={Boolean(downloading)}
                    onClick={() => void downloadExport("csv")}
                  >
                    {downloading === "csv" ? "Gerando CSV…" : "Baixar CSV"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={Boolean(downloading)}
                    onClick={() => void downloadExport("pdf")}
                  >
                    {downloading === "pdf" ? "Gerando PDF…" : "Baixar PDF"}
                  </Button>
                </div>
              </CardAction>
            </CardHeader>
            <CardContent>
              <label
                className={adminStyles.checkbox}
                htmlFor="rsvp-include-phone"
              >
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
            </CardContent>
          </Card>
          {loading ? (
            <p className="leading-[1.6]" role="status">
              Carregando confirmações…
            </p>
          ) : view?.groups.length === 0 ? (
            <p className="leading-[1.6]">
              Nenhum convidado corresponde aos filtros.
            </p>
          ) : (
            <div className="mt-6 grid gap-3">
              {view?.groups.map((group) => (
                <Card
                  className="items-stretch rounded-[10px] border border-admin-line bg-admin-surface p-5 [@media(max-width:760px)]:grid [@media(max-width:760px)]:grid-cols-1 [&_[data-slot=card-header]]:w-full [&_h3]:mb-2"
                  key={group.id}
                >
                  <CardHeader className="flex w-full flex-row items-start justify-between">
                    <div>
                      <CardTitle>
                        {rsvpGroupLabel(group.id, group.name)}
                      </CardTitle>
                      <CardDescription>
                        {group.totals.confirmed} confirmados ·{" "}
                        {group.totals.declined} ausentes ·{" "}
                        {group.totals.pending} pendentes
                      </CardDescription>
                      <Badge variant="outline">
                        {group.members.length} convidados
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <ul className="m-0 list-none p-0">
                      {group.members.map((member) => (
                        <li
                          className="grid grid-cols-[minmax(0,1fr)_minmax(180px,260px)] items-center gap-4 border-t border-admin-line py-3 first:border-t-0 first:pt-0 last:pb-0 [@media(max-width:760px)]:grid-cols-1"
                          key={member.id}
                        >
                          <span>
                            {member.fullName}
                            {member.isRepresentative ? " · representante" : ""}
                          </span>
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
                              <SelectValue>
                                {stateLabels[drafts[member.id] ?? member.state]}
                              </SelectValue>
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
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
          <footer className="fixed right-0 bottom-0 left-[248px] z-[7] flex justify-center border-t border-admin-line bg-admin-canvas px-[42px] pt-4 pb-6 shadow-[0_-8px_24px_rgb(68_49_36_/_8%)] [@media(max-width:760px)]:right-0 [@media(max-width:760px)]:bottom-[calc(74px+env(safe-area-inset-bottom))] [@media(max-width:760px)]:left-0 [@media(max-width:760px)]:px-5 [@media(max-width:760px)]:pt-3 [@media(max-width:760px)]:pb-4 [@media(min-width:761px)_and_(max-width:1060px)]:left-[216px] [@media(min-width:761px)_and_(max-width:1060px)]:px-7">
            <Button
              type="button"
              disabled={inactive || pending || changedMembers.length === 0}
              className="w-[70%] [@media(max-width:760px)]:w-full"
              onClick={() => void saveRsvp()}
            >
              {changedMembers.length === 0
                ? "Salvar alterações"
                : `Salvar ${changedMembers.length} ${changedMembers.length === 1 ? "alteração" : "alterações"}`}
            </Button>
          </footer>
        </>
      ) : (
        <>
          <div className="my-7 grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] items-end gap-[18px]">
            <RsvpFilterField id="rsvp-history-group" label="Grupo">
              <Select
                value={historyGroupId || "all"}
                onValueChange={(value) =>
                  setHistoryGroupId(value === "all" || !value ? "" : value)
                }
              >
                <SelectTrigger
                  id="rsvp-history-group"
                  aria-labelledby="rsvp-history-group-label"
                >
                  <SelectValue>
                    {(value) =>
                      rsvpFilterLabel(value, groupFilterLabels, "Todos")
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  {knownGroups.map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                      {rsvpGroupLabel(group.id, group.name)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </RsvpFilterField>
            <RsvpFilterField id="rsvp-history-actor" label="Origem">
              <Select
                value={historyActor || "all"}
                onValueChange={(value) =>
                  setHistoryActor(value === "all" || !value ? "" : value)
                }
              >
                <SelectTrigger
                  id="rsvp-history-actor"
                  aria-labelledby="rsvp-history-actor-label"
                >
                  <SelectValue>
                    {(value) =>
                      rsvpFilterLabel(value, historyActorLabels, "Todas")
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas</SelectItem>
                  <SelectItem value="FAMILY">Família</SelectItem>
                  <SelectItem value="ADMIN">Administração</SelectItem>
                </SelectContent>
              </Select>
            </RsvpFilterField>
          </div>
          {loading ? (
            <p className="leading-[1.6]" role="status">
              Carregando histórico…
            </p>
          ) : history?.entries.length === 0 ? (
            <p className="leading-[1.6]">Nenhuma alteração registrada.</p>
          ) : (
            <ol className="grid gap-3 pl-6 leading-[1.6]">
              {history?.entries.map((entry) => (
                <li key={entry.id}>
                  <strong>{entry.memberDisplayName}</strong> em{" "}
                  {rsvpGroupLabel(entry.groupId, entry.groupName)}:{" "}
                  {stateLabels[entry.beforeState]} →{" "}
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
