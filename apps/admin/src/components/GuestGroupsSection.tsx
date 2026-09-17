import {
  brazilianPhoneInputSchema,
  type DemoGuestGrantResponse,
  type GuestAccessPinResponse,
  type GuestGroupRecord,
} from "@entrelacos/contracts";
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
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
} from "@entrelacos/ui";
import { MoreHorizontal } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { ApiError, apiRequest } from "../lib/apiClient";
import {
  canIssueDemoGuestGrant,
  createGuestGroupDraft,
  type GuestGroupDraft,
  type GuestGroupMenuAction,
  groupDeletionConfirmation,
  guestGroupDraftErrors,
  guestGroupDraftPayload,
  guestGroupMenuActionLabels,
  guestGroupMenuActions,
} from "./guestGroupsForm";
import { emitGuestGroupsChanged } from "./guestGroupsRefresh";

type GuestGroupsSectionProps = {
  siteId: string;
  lifecycle: "DRAFT" | "IN_REVIEW" | "ACTIVE" | "INACTIVE";
  owner: boolean;
  isDemo: boolean;
};

function draftFromGroup(group: GuestGroupRecord): GuestGroupDraft {
  return {
    name: group.name,
    isForeign: group.isForeign,
    phone: group.phone ?? "",
    members: group.members.map((member) => ({
      id: member.id,
      fullName: member.fullName,
      isRepresentative: member.isRepresentative,
    })),
  };
}

function apiMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.code === "PHONE_CONFLICT")
      return "Este celular já está vinculado a outro grupo deste casamento.";
    if (cause.code === "SITE_INACTIVE")
      return "O casamento está inativo. Os grupos podem ser consultados, mas não alterados.";
    if (cause.code === "VALIDATION_ERROR")
      return "Confira o nome, os convidados, o representante e o celular informado.";
    if (cause.code === "GROUP_NOT_FOUND")
      return "Este grupo não existe mais. Atualize a lista e tente novamente.";
    if (cause.code === "GROUP_CONFIRMATION_MISMATCH")
      return "A confirmação não corresponde ao grupo atual. Recarregue os dados e tente novamente.";
    return cause.message;
  }
  return cause instanceof Error
    ? cause.message
    : "Não foi possível concluir a operação.";
}

export function GuestGroupsSection({
  siteId,
  lifecycle,
  owner,
  isDemo,
}: GuestGroupsSectionProps) {
  const [groups, setGroups] = useState<GuestGroupRecord[]>([]);
  const [form, setForm] = useState<GuestGroupDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [demoGrant, setDemoGrant] = useState<
    (DemoGuestGrantResponse & { groupName: string }) | null
  >(null);
  const [accessPin, setAccessPin] = useState<
    (GuestAccessPinResponse & { groupId: string; groupName: string }) | null
  >(null);
  const [deleteTarget, setDeleteTarget] = useState<GuestGroupRecord | null>(
    null,
  );
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [rotationTarget, setRotationTarget] = useState<GuestGroupRecord | null>(
    null,
  );
  const inactive = lifecycle === "INACTIVE";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiRequest<{ groups: GuestGroupRecord[] }>(
        `/v1/sites/${encodeURIComponent(siteId)}/groups`,
      );
      setGroups(result.groups);
      setError("");
    } catch (cause) {
      setError(apiMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  function startCreate(individual: boolean) {
    if (inactive) return;
    setEditingId(null);
    setForm(createGuestGroupDraft(individual));
    setError("");
    setNotice("");
  }

  function startEdit(group: GuestGroupRecord) {
    if (inactive) return;
    setEditingId(group.id);
    setForm(draftFromGroup(group));
    setError("");
    setNotice("");
  }

  function handleGroupMenuAction(
    action: GuestGroupMenuAction,
    group: GuestGroupRecord,
  ) {
    if (action === "reveal-pin") {
      void revealAccessPin(group);
      return;
    }
    if (action === "rotate-pin") {
      setRotationTarget(group);
      return;
    }
    if (action === "demo-grant") {
      void issueDemoAccess(group);
      return;
    }
    if (action === "edit") {
      startEdit(group);
      return;
    }
    setDeleteTarget(group);
    setDeleteConfirmation("");
    setError("");
    setNotice("");
  }

  function closeForm() {
    setForm(null);
    setEditingId(null);
    setError("");
  }

  function updateForm(update: Partial<GuestGroupDraft>) {
    setForm((current) => (current ? { ...current, ...update } : current));
  }

  function updateMember(
    index: number,
    update: Partial<GuestGroupDraft["members"][number]>,
  ) {
    setForm((current) => {
      if (!current) return current;
      return {
        ...current,
        members: current.members.map((member, memberIndex) =>
          memberIndex === index ? { ...member, ...update } : member,
        ),
      };
    });
  }

  function setRepresentative(index: number) {
    setForm((current) =>
      current
        ? {
            ...current,
            members: current.members.map((member, memberIndex) => ({
              ...member,
              isRepresentative: memberIndex === index,
            })),
          }
        : current,
    );
  }

  function addMember() {
    setForm((current) =>
      current
        ? {
            ...current,
            members: [
              ...current.members,
              { fullName: "", isRepresentative: false },
            ],
          }
        : current,
    );
  }

  function removeMember(index: number) {
    setForm((current) => {
      if (!current || current.members.length <= 1) return current;
      const removed = current.members[index];
      const members = current.members.filter(
        (_, memberIndex) => memberIndex !== index,
      );
      if (removed?.isRepresentative && members[0])
        members[0] = { ...members[0], isRepresentative: true };
      return { ...current, members };
    });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form || inactive) return;
    const errors = guestGroupDraftErrors(form);
    if (errors.length > 0) {
      setError(errors.join(" "));
      return;
    }
    setPending(true);
    setError("");
    setNotice("");
    try {
      const path = `/v1/sites/${encodeURIComponent(siteId)}/groups`;
      if (editingId) {
        await apiRequest(`${path}/${encodeURIComponent(editingId)}`, {
          method: "PATCH",
          body: guestGroupDraftPayload(form),
        });
        setNotice("Grupo atualizado.");
      } else {
        await apiRequest(path, {
          method: "POST",
          body: guestGroupDraftPayload(form),
        });
        setNotice("Grupo criado.");
      }
      closeForm();
      await load();
      emitGuestGroupsChanged(window, siteId);
    } catch (cause) {
      setError(apiMessage(cause));
    } finally {
      setPending(false);
    }
  }

  async function remove(group: GuestGroupRecord) {
    if (inactive || pending) return;
    const confirmation = groupDeletionConfirmation(
      group.id,
      group.name,
      deleteConfirmation,
    );
    if (!confirmation) {
      setError("Digite o nome exato do grupo para confirmar a exclusão.");
      return;
    }
    setPending(true);
    setError("");
    setNotice("");
    try {
      await apiRequest(
        `/v1/sites/${encodeURIComponent(siteId)}/groups/${encodeURIComponent(group.id)}`,
        { method: "DELETE", body: confirmation },
      );
      if (accessPin?.groupId === group.id) setAccessPin(null);
      setNotice("Grupo excluído.");
      setDeleteTarget(null);
      setDeleteConfirmation("");
      if (editingId === group.id) closeForm();
      await load();
      emitGuestGroupsChanged(window, siteId);
    } catch (cause) {
      setError(apiMessage(cause));
    } finally {
      setPending(false);
    }
  }

  async function issueDemoAccess(group: GuestGroupRecord) {
    if (
      pending ||
      !canIssueDemoGuestGrant(owner, isDemo, inactive, group) ||
      !group.phone
    )
      return;
    setPending(true);
    setError("");
    setNotice("");
    setDemoGrant(null);
    try {
      const result = await apiRequest<DemoGuestGrantResponse>(
        `/v1/owner/sites/${encodeURIComponent(siteId)}/demo/guest-grant`,
        { method: "POST", body: { phone: group.phone } },
      );
      setDemoGrant({ ...result, groupName: group.name });
      setNotice("Autorização temporária emitida para a demonstração.");
    } catch (cause) {
      setError(apiMessage(cause));
    } finally {
      setPending(false);
    }
  }

  async function revealAccessPin(group: GuestGroupRecord) {
    if (pending || group.isForeign) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const result = await apiRequest<GuestAccessPinResponse>(
        `/v1/sites/${encodeURIComponent(siteId)}/groups/${encodeURIComponent(group.id)}/access-pin`,
      );
      setAccessPin({ ...result, groupId: group.id, groupName: group.name });
      setNotice("PIN exibido somente nesta sessão administrativa.");
    } catch (cause) {
      setError(apiMessage(cause));
    } finally {
      setPending(false);
    }
  }

  async function copyAccessPin() {
    if (!accessPin) return;
    try {
      await navigator.clipboard.writeText(accessPin.accessPin);
      setNotice(`PIN de ${accessPin.groupName} copiado.`);
      setError("");
    } catch {
      setError(
        "Não foi possível copiar automaticamente. Selecione o PIN e copie manualmente.",
      );
    }
  }

  async function rotateAccessPin(group: GuestGroupRecord) {
    if (pending || inactive || group.isForeign) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const result = await apiRequest<GuestAccessPinResponse>(
        `/v1/sites/${encodeURIComponent(siteId)}/groups/${encodeURIComponent(group.id)}/access-pin/rotate`,
        { method: "POST", body: {} },
      );
      setAccessPin({ ...result, groupId: group.id, groupName: group.name });
      setNotice(
        "Novo PIN gerado. O PIN anterior e os acessos ativos foram revogados.",
      );
    } catch (cause) {
      setError(apiMessage(cause));
    } finally {
      setPending(false);
    }
  }

  const phoneInvalid =
    form !== null &&
    !form.isForeign &&
    form.phone.length > 0 &&
    !brazilianPhoneInputSchema.safeParse(form.phone).success;

  return (
    <section className="panel-section" aria-labelledby="guest-groups-title">
      <div className="guest-groups-heading">
        <div>
          <h2 id="guest-groups-title">Grupos de convidados</h2>
          <p>
            Cadastre cada convite com seu nome de localização, convidados e um
            único representante. Compartilhe o PIN do grupo junto com o link de
            confirmação; o SMS poderá ser ativado depois.
          </p>
        </div>
        {!inactive && (
          <div className="inline-actions">
            <Button
              disabled={pending}
              type="button"
              onClick={() => startCreate(false)}
            >
              Novo grupo
            </Button>
            <Button
              disabled={pending}
              type="button"
              variant="outline"
              onClick={() => startCreate(true)}
            >
              Convite individual
            </Button>
          </div>
        )}
      </div>
      {inactive && (
        <p className="notice" role="note">
          Casamento inativo. Os grupos continuam disponíveis para consulta, mas
          criação, edição e exclusão ficam indisponíveis.
        </p>
      )}
      {error && !form && !deleteTarget && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      <Dialog
        open={form !== null}
        onOpenChange={(open) => !open && closeForm()}
      >
        <DialogContent className="max-w-3xl max-h-[min(90vh,720px)] overflow-y-auto guest-group-dialog">
          <DialogTitle>{editingId ? "Editar grupo" : "Novo grupo"}</DialogTitle>
          <DialogDescription>
            Escolha o representante e revise os dados antes de salvar.
          </DialogDescription>
          {form && (
            <form className="guest-group-form data-form" onSubmit={save}>
              {error && <p role="alert">{error}</p>}
              <label htmlFor="guest-group-name">
                Nome do grupo
                <Input
                  id="guest-group-name"
                  maxLength={160}
                  required
                  value={form.name}
                  onChange={(event) => updateForm({ name: event.target.value })}
                  placeholder="Família Silva"
                />
              </label>
              <fieldset>
                <legend>Tipo de convite</legend>
                <label className="checkbox-label" htmlFor="guest-group-foreign">
                  <Checkbox
                    id="guest-group-foreign"
                    checked={form.isForeign}
                    onCheckedChange={(checked) =>
                      updateForm({ isForeign: checked === true })
                    }
                  />
                  Grupo estrangeiro
                </label>
              </fieldset>
              {form.isForeign ? (
                <p className="help-text" role="note">
                  Grupo estrangeiro não usa telefone nem SMS. Este convite exige
                  atendimento administrativo; não há autenticação alternativa.
                </p>
              ) : (
                <label htmlFor="guest-group-phone">
                  Celular do representante
                  <Input
                    id="guest-group-phone"
                    aria-describedby="guest-group-phone-help"
                    aria-invalid={phoneInvalid}
                    inputMode="tel"
                    maxLength={40}
                    placeholder="(62) 99999-9999"
                    required
                    type="tel"
                    value={form.phone}
                    onChange={(event) =>
                      updateForm({ phone: event.target.value })
                    }
                  />
                  <span className="help-text" id="guest-group-phone-help">
                    Use um celular brasileiro com DDD. Exemplo: (62) 99999-9999.
                    {phoneInvalid && " Confira o número informado."}
                  </span>
                </label>
              )}
              <fieldset className="guest-members-fieldset">
                <legend>Convidados</legend>
                <p className="help-text">
                  Escolha exatamente um representante. Ele será o contato
                  responsável pela confirmação deste convite.
                </p>
                {form.members.map((member, index) => (
                  <div className="guest-member-editor" key={member.id ?? index}>
                    <label htmlFor={`guest-member-${index}`}>
                      Nome completo
                      <Input
                        id={`guest-member-${index}`}
                        maxLength={160}
                        required
                        value={member.fullName}
                        onChange={(event) =>
                          updateMember(index, { fullName: event.target.value })
                        }
                      />
                    </label>
                    <label
                      className="checkbox-label"
                      htmlFor={`guest-representative-${index}`}
                    >
                      <Checkbox
                        id={`guest-representative-${index}`}
                        checked={member.isRepresentative}
                        onCheckedChange={(checked) =>
                          checked && setRepresentative(index)
                        }
                      />
                      Representante
                    </label>
                    <Button
                      variant="outline"
                      disabled={pending || form.members.length <= 1}
                      type="button"
                      onClick={() => removeMember(index)}
                    >
                      Remover
                    </Button>
                  </div>
                ))}
                <Button
                  disabled={pending}
                  type="button"
                  variant="outline"
                  onClick={addMember}
                >
                  Adicionar convidado
                </Button>
              </fieldset>
              <div className="inline-actions">
                <Button disabled={pending} type="submit">
                  {pending
                    ? "Salvando…"
                    : editingId
                      ? "Salvar grupo"
                      : "Criar grupo"}
                </Button>
                <Button
                  disabled={pending}
                  type="button"
                  variant="outline"
                  onClick={closeForm}
                >
                  Cancelar
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {demoGrant && (
        <Card className="demo-guest-grant" role="status">
          <CardHeader>
            <CardTitle>
              Autorização temporária · {demoGrant.groupName}
            </CardTitle>
            <CardDescription>
              Cole este valor somente no campo de demonstração do site público.
              Ele expira às {new Date(demoGrant.expiresAt).toLocaleTimeString()}{" "}
              e não deve ser colocado em URL, cookie ou armazenamento local.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Input
              aria-label="Autorização temporária da demonstração"
              readOnly
              spellCheck={false}
              value={demoGrant.grant}
            />
          </CardContent>
        </Card>
      )}
      {accessPin && (
        <Card className="demo-guest-grant" role="status">
          <CardHeader>
            <CardTitle>PIN de acesso · {accessPin.groupName}</CardTitle>
            <CardDescription>
              Envie este PIN junto com o link por WhatsApp ou pelo canal
              escolhido. Ele não é enviado automaticamente e permanece válido
              até ser rotacionado.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Input
              aria-label={`PIN de acesso de ${accessPin.groupName}`}
              inputMode="numeric"
              readOnly
              value={accessPin.accessPin}
            />
            <div className="inline-actions">
              <Button type="button" onClick={() => void copyAccessPin()}>
                Copiar PIN
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setAccessPin(null)}
              >
                Ocultar PIN
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
            setDeleteConfirmation("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir {deleteTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta ação remove o grupo, convidados, respostas, histórico,
              sessão, mensagem e dados de acesso associados. Digite o nome exato
              do grupo para continuar: <strong>{deleteTarget?.name}</strong>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p role="alert">{error}</p>}
          <label htmlFor="delete-group-confirmation">
            Nome exato do grupo
            <Input
              id="delete-group-confirmation"
              autoComplete="off"
              value={deleteConfirmation}
              onChange={(event) => {
                setDeleteConfirmation(event.target.value);
                setError("");
              }}
            />
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="danger-action"
              disabled={pending || deleteConfirmation !== deleteTarget?.name}
              onClick={() => deleteTarget && void remove(deleteTarget)}
            >
              {pending ? "Excluindo…" : "Excluir grupo definitivamente"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={rotationTarget !== null}
        onOpenChange={(open) => !open && setRotationTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotacionar PIN?</AlertDialogTitle>
            <AlertDialogDescription>
              {rotationTarget
                ? `Gerar um novo PIN para “${rotationTarget.name}”? O PIN anterior e os acessos ativos deixarão de funcionar.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={() => {
                if (rotationTarget) void rotateAccessPin(rotationTarget);
                setRotationTarget(null);
              }}
            >
              Rotacionar PIN
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {loading ? (
        <p role="status">Carregando grupos…</p>
      ) : groups.length === 0 ? (
        <p>Nenhum grupo cadastrado.</p>
      ) : (
        <div className="guest-group-list">
          {groups.map((group) => {
            const actions = guestGroupMenuActions({
              owner,
              isDemo,
              inactive,
              isForeign: group.isForeign,
              phone: group.phone,
            });
            return (
              <Card className="guest-group-card" key={group.id}>
                <CardHeader className="flex w-full flex-row items-start justify-between">
                  <div>
                    <CardTitle>{group.name}</CardTitle>
                    <CardDescription>
                      {group.isForeign
                        ? "Grupo estrangeiro · sem SMS"
                        : `Representante: ${group.members.find((member) => member.isRepresentative)?.fullName ?? "Não informado"} · ${group.phone}`}
                    </CardDescription>
                    <Badge variant="outline">
                      {group.members.length} convidados
                    </Badge>
                  </div>
                  {actions.length > 0 && (
                    <CardAction>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          disabled={pending}
                          render={
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className="size-8"
                              aria-label={`Ações de ${group.name}`}
                            />
                          }
                        >
                          <MoreHorizontal aria-hidden="true" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {actions
                            .filter((action) => action !== "delete")
                            .map((action) => (
                              <DropdownMenuItem
                                key={action}
                                disabled={pending}
                                onClick={() =>
                                  handleGroupMenuAction(action, group)
                                }
                              >
                                {guestGroupMenuActionLabels[action]}
                              </DropdownMenuItem>
                            ))}
                          {actions.includes("delete") && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                variant="destructive"
                                disabled={pending}
                                onClick={() =>
                                  handleGroupMenuAction("delete", group)
                                }
                              >
                                {guestGroupMenuActionLabels.delete}
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </CardAction>
                  )}
                </CardHeader>
                <CardContent>
                  <ul className="guest-group-members">
                    {group.members.map((member) => (
                      <li key={member.id}>
                        {member.fullName}
                        {member.isRepresentative && " · representante"}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
