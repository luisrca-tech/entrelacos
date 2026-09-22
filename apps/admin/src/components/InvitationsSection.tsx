import type {
  AdminRsvpWriteInput,
  InvitationAccessPinResponse,
  InvitationCreateInput,
  InvitationDeleteConfirmation,
  InvitationRecord,
  RsvpDeadline,
  RsvpHistoryResponse,
  SiteRsvpResponse,
} from "@entrelacos/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
} from "@entrelacos/ui";
import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { adminStyles, displayHeading } from "../lib/adminStyles";
import { ApiError, apiRequest } from "../lib/apiClient";
import { InvitationDeleteDialog } from "./InvitationDeleteDialog";
import { InvitationDetailDialog } from "./InvitationDetailDialog";
import { InvitationExportDialog } from "./InvitationExportDialog";
import { InvitationFiltersPopover } from "./InvitationFiltersPopover";
import { InvitationFormDialog } from "./InvitationFormDialog";
import { InvitationList } from "./InvitationList";
import { InvitationOverview } from "./InvitationOverview";
import { invitationAdminError } from "./invitationAdminError";
import {
  type InvitationExportFormat,
  invitationExportPath,
} from "./invitationExport";
import { emitInvitationsChanged } from "./invitationsRefresh";
import {
  filterInvitations,
  type InvitationFilters,
  summarizeInvitations,
} from "./invitationView";
import { ManageConfirmationsDialog } from "./ManageConfirmationsDialog";
import {
  deadlineInstantFromLocal,
  deadlineLocalFromInstant,
  joinDeadlineLocal,
  splitDeadlineLocal,
} from "./rsvpDeadline";

type Props = {
  siteId: string;
  lifecycle: "DRAFT" | "IN_REVIEW" | "ACTIVE" | "INACTIVE";
};

const emptyFilters: InvitationFilters = {
  search: "",
  status: "ALL",
  guestType: "ALL",
};

function exportFilename(disposition: string | null, fallback: string): string {
  const filename = disposition?.match(/filename="([A-Za-z0-9._-]+)"/i);
  return filename?.[1] ?? fallback;
}

export function InvitationsSection({ siteId, lifecycle }: Props) {
  const base = `/v1/sites/${encodeURIComponent(siteId)}`;
  const invitationBase = `${base}/invitations`;
  const inactive = lifecycle === "INACTIVE";
  const [invitations, setInvitations] = useState<InvitationRecord[]>([]);
  const [filters, setFilters] = useState<InvitationFilters>(emptyFilters);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [deadlineOpen, setDeadlineOpen] = useState(false);
  const [deadline, setDeadline] = useState<RsvpDeadline | null>(null);
  const [deadlineDate, setDeadlineDate] = useState("");
  const [deadlineTime, setDeadlineTime] = useState("");
  const [deadlineTimezone, setDeadlineTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Sao_Paulo",
  );
  const [confirmations, setConfirmations] = useState<SiteRsvpResponse | null>(
    null,
  );
  const [history, setHistory] = useState<RsvpHistoryResponse | null>(null);
  const [confirmationsLoading, setConfirmationsLoading] = useState(false);

  const selectedInvitation =
    invitations.find((item) => item.id === detailId) ?? null;
  const editingInvitation =
    invitations.find((item) => item.id === editId) ?? null;
  const deletingInvitation =
    invitations.find((item) => item.id === deleteId) ?? null;
  const filtered = useMemo(
    () => filterInvitations(invitations, filters),
    [invitations, filters],
  );
  const summary = useMemo(
    () => summarizeInvitations(invitations),
    [invitations],
  );

  const loadInvitations = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiRequest<{ invitations: InvitationRecord[] }>(
        invitationBase,
      );
      setInvitations(response.invitations);
      setError("");
    } catch (cause) {
      setError(invitationAdminError(cause));
    } finally {
      setLoading(false);
    }
  }, [invitationBase]);

  const loadConfirmations = useCallback(async () => {
    const response = await apiRequest<SiteRsvpResponse>(`${base}/rsvp`);
    setConfirmations(response);
  }, [base]);

  const loadHistory = useCallback(
    async (cursor?: string) => {
      const query = new URLSearchParams({ limit: "50" });
      if (cursor) query.set("cursor", cursor);
      const response = await apiRequest<RsvpHistoryResponse>(
        `${base}/rsvp/history?${query.toString()}`,
      );
      setHistory((current) =>
        cursor && current
          ? {
              entries: [...current.entries, ...response.entries],
              nextCursor: response.nextCursor,
            }
          : response,
      );
    },
    [base],
  );

  useEffect(() => {
    void loadInvitations();
  }, [loadInvitations]);

  async function mutate<T>(
    operation: () => Promise<T>,
    success: string,
    onSuccess?: () => void,
  ) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await operation();
      onSuccess?.();
      await loadInvitations();
      emitInvitationsChanged(window, siteId);
      setNotice(success);
      return result;
    } catch (cause) {
      setError(invitationAdminError(cause));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function saveInvitation(value: InvitationCreateInput) {
    if (inactive) return;
    const id = editId;
    await mutate(
      () =>
        apiRequest(
          id ? `${invitationBase}/${encodeURIComponent(id)}` : invitationBase,
          { method: id ? "PATCH" : "POST", body: value },
        ),
      id ? "Convite atualizado." : "Convite adicionado.",
      () => {
        setFormOpen(false);
        setEditId(null);
        setDetailId(null);
      },
    );
  }

  async function deleteInvitation(confirmation: InvitationDeleteConfirmation) {
    if (inactive || !deletingInvitation) return;
    const id = deletingInvitation.id;
    await mutate(
      () =>
        apiRequest(`${invitationBase}/${encodeURIComponent(id)}`, {
          method: "DELETE",
          body: confirmation,
        }),
      "Convite excluído.",
      () => {
        setDeleteId(null);
        setDetailId(null);
      },
    );
  }

  async function rotatePin() {
    if (inactive || !selectedInvitation) return;
    const id = selectedInvitation.id;
    await mutate(
      () =>
        apiRequest(
          `${invitationBase}/${encodeURIComponent(id)}/access-pin/rotate`,
          {
            method: "POST",
          },
        ),
      "Novo PIN gerado. Compartilhe o novo PIN com os convidados deste convite.",
      () => setDetailId(null),
    );
  }

  async function revealPin(): Promise<string> {
    if (!selectedInvitation) throw new Error("Convite não encontrado.");
    const response = await apiRequest<InvitationAccessPinResponse>(
      `${invitationBase}/${encodeURIComponent(selectedInvitation.id)}/access-pin`,
    );
    return response.accessPin;
  }

  async function openConfirmations() {
    setConfirmationOpen(true);
    setConfirmationsLoading(true);
    setError("");
    try {
      await Promise.all([loadConfirmations(), loadHistory()]);
    } catch (cause) {
      setError(invitationAdminError(cause));
    } finally {
      setConfirmationsLoading(false);
    }
  }

  async function saveConfirmations(guests: AdminRsvpWriteInput["guests"]) {
    if (inactive || guests.length === 0) return;
    setBusy(true);
    setError("");
    try {
      await apiRequest(`${base}/rsvp`, {
        method: "POST",
        body: { requestId: crypto.randomUUID(), guests },
      });
      await Promise.all([
        loadConfirmations(),
        loadHistory(),
        loadInvitations(),
      ]);
      emitInvitationsChanged(window, siteId);
      setNotice("Confirmações salvas.");
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "RSVP_CONFLICT") {
        await Promise.all([loadConfirmations(), loadInvitations()]);
      }
      setError(invitationAdminError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function openDeadline() {
    setDeadlineOpen(true);
    setError("");
    try {
      const response = await apiRequest<RsvpDeadline>(`${base}/rsvp/deadline`);
      setDeadline(response);
      const timezone = response.deadlineTimezone ?? deadlineTimezone;
      setDeadlineTimezone(timezone);
      const parts = splitDeadlineLocal(
        response.deadlineAt
          ? deadlineLocalFromInstant(response.deadlineAt, timezone)
          : "",
      );
      setDeadlineDate(parts.date);
      setDeadlineTime(parts.time);
    } catch (cause) {
      setError(invitationAdminError(cause));
    }
  }

  async function saveDeadline(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inactive) return;
    setBusy(true);
    setError("");
    try {
      const local = joinDeadlineLocal(deadlineDate, deadlineTime);
      const next: RsvpDeadline = local
        ? {
            deadlineAt: deadlineInstantFromLocal(local, deadlineTimezone),
            deadlineTimezone,
          }
        : { deadlineAt: null, deadlineTimezone: null };
      await apiRequest(`${base}/rsvp/deadline`, {
        method: "PATCH",
        body: next,
      });
      setDeadline(next);
      setDeadlineOpen(false);
      setNotice(local ? "Prazo de confirmação salvo." : "Prazo removido.");
    } catch (cause) {
      setError(invitationAdminError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function downloadExport(
    format: InvitationExportFormat,
    options: { includePhone: boolean; includeEmail: boolean },
  ) {
    setBusy(true);
    setError("");
    try {
      const path = invitationExportPath(siteId, format, {
        ...filters,
        ...options,
        requestId: crypto.randomUUID(),
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
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = exportFilename(
        response.headers.get("Content-Disposition"),
        `entrelacos-convites-${siteId}.${format}`,
      );
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
      setExportOpen(false);
      setNotice(`Relatório ${format.toUpperCase()} gerado.`);
    } catch (cause) {
      setError(invitationAdminError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-area="invitations" aria-labelledby="invitations-title">
      <div className="mb-7">
        <h2
          id="invitations-title"
          className={`m-0 text-[clamp(2rem,3vw,3rem)] ${displayHeading}`}
        >
          Convites
        </h2>
        <p className="mb-0 mt-2 text-admin-muted">
          Organize convites, convidados e confirmações em um só lugar.
        </p>
      </div>
      {error && (
        <p role="alert" className={adminStyles.alert}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className={adminStyles.notice}>
          {notice}
        </p>
      )}
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(280px,370px)_minmax(0,1fr)]">
        <InvitationOverview
          summary={summary}
          inactive={inactive}
          onAdd={() => {
            setEditId(null);
            setFormOpen(true);
            setError("");
          }}
          onManageConfirmations={() => void openConfirmations()}
          onExport={() => setExportOpen(true)}
          onConfigureDeadline={() => void openDeadline()}
        />
        <div className="min-w-0">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <label
              className="relative min-w-[220px] flex-1"
              htmlFor="invitation-search"
            >
              <Search
                aria-hidden="true"
                className="absolute left-3 top-3.5 size-4 text-admin-muted"
              />
              <span className="sr-only">Buscar identificação do convite</span>
              <Input
                id="invitation-search"
                type="search"
                value={filters.search}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    search: event.target.value,
                  }))
                }
                placeholder="Buscar identificação do convite"
                className="min-h-11 border-admin-line bg-admin-surface pl-10"
              />
            </label>
            <InvitationFiltersPopover
              filters={filters}
              summary={summary}
              onChange={setFilters}
            />
          </div>
          {loading ? (
            <p role="status" className="text-admin-muted">
              Carregando convites…
            </p>
          ) : (
            <InvitationList
              invitations={filtered}
              hasFilters={
                Boolean(filters.search.trim()) ||
                filters.status !== "ALL" ||
                filters.guestType !== "ALL"
              }
              onOpen={(invitation) => {
                setDetailId(invitation.id);
                setError("");
              }}
            />
          )}
        </div>
      </div>
      <InvitationFormDialog
        open={formOpen}
        invitation={editingInvitation}
        inactive={inactive}
        busy={busy}
        error={formOpen ? error : ""}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditId(null);
        }}
        onSave={(value) => void saveInvitation(value)}
      />
      <InvitationDetailDialog
        key={detailId ?? "closed"}
        invitation={selectedInvitation}
        inactive={inactive}
        onOpenChange={(open) => {
          if (!open) setDetailId(null);
        }}
        onEdit={() => {
          setEditId(detailId);
          setDetailId(null);
          setFormOpen(true);
        }}
        onDelete={() => {
          setDeleteId(detailId);
          setDetailId(null);
        }}
        onRotatePin={() => void rotatePin()}
        onRevealPin={revealPin}
      />
      <InvitationDeleteDialog
        invitation={deletingInvitation}
        busy={busy}
        error={deleteId ? error : ""}
        onOpenChange={(open) => {
          if (!open) setDeleteId(null);
        }}
        onConfirm={(confirmation) => void deleteInvitation(confirmation)}
      />
      <ManageConfirmationsDialog
        open={confirmationOpen}
        onOpenChange={setConfirmationOpen}
        view={confirmations}
        history={history}
        loading={confirmationsLoading}
        busy={busy}
        inactive={inactive}
        error={confirmationOpen ? error : ""}
        onSave={(updates) => void saveConfirmations(updates)}
        onLoadMoreHistory={() => {
          if (!history?.nextCursor) return;
          setConfirmationsLoading(true);
          void loadHistory(history.nextCursor)
            .catch((cause) => setError(invitationAdminError(cause)))
            .finally(() => setConfirmationsLoading(false));
        }}
      />
      <InvitationExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        onExport={(format, options) => void downloadExport(format, options)}
        busy={busy}
        invitationCount={filtered.length}
      />
      <Dialog open={deadlineOpen} onOpenChange={setDeadlineOpen}>
        <DialogContent className={adminStyles.dialog}>
          <DialogTitle className="font-admin-display text-3xl text-admin-graphite">
            Prazo de confirmação
          </DialogTitle>
          <DialogDescription className="text-admin-muted">
            Após o prazo, os convidados podem consultar as respostas, mas não
            alterá-las.
          </DialogDescription>
          {deadlineOpen && error && (
            <p role="alert" className={adminStyles.alert}>
              {error}
            </p>
          )}
          <form
            onSubmit={(event) => void saveDeadline(event)}
            className="mt-5 grid gap-4"
          >
            <label
              htmlFor="invitation-deadline-date"
              className="grid gap-2 text-sm font-semibold text-admin-graphite"
            >
              Data
              <Input
                id="invitation-deadline-date"
                type="date"
                value={deadlineDate}
                onChange={(event) => setDeadlineDate(event.target.value)}
                className="border-admin-line"
              />
            </label>
            <label
              htmlFor="invitation-deadline-time"
              className="grid gap-2 text-sm font-semibold text-admin-graphite"
            >
              Horário
              <Input
                id="invitation-deadline-time"
                type="time"
                value={deadlineTime}
                onChange={(event) => setDeadlineTime(event.target.value)}
                className="border-admin-line"
              />
            </label>
            <label
              htmlFor="invitation-deadline-timezone"
              className="grid gap-2 text-sm font-semibold text-admin-graphite"
            >
              Fuso horário (IANA)
              <Input
                id="invitation-deadline-timezone"
                value={deadlineTimezone}
                onChange={(event) => setDeadlineTimezone(event.target.value)}
                placeholder="America/Sao_Paulo"
                className="border-admin-line"
              />
            </label>
            {deadline?.deadlineAt && (
              <p className="m-0 text-sm text-admin-muted">
                Prazo atual configurado.
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setDeadlineDate("");
                  setDeadlineTime("");
                }}
                disabled={busy}
              >
                Remover prazo
              </Button>
              <Button type="submit" disabled={busy || inactive}>
                {busy ? "Salvando…" : "Salvar prazo"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
