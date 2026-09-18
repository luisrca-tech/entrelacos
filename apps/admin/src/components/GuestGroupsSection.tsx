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
  Input,
  toast,
} from "@entrelacos/ui";
import { Trash2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { adminStyles, displayHeading } from "../lib/adminStyles";
import { ApiError, apiRequest } from "../lib/apiClient";
import {
  canIssueDemoGuestGrant,
  copyGuestAccessPin,
  createGuestGroupDraft,
  type GuestGroupDraft,
  type GuestGroupMenuAction,
  groupDeletionConfirmation,
  guestAccessPinCopiedMessage,
  guestAccessPinCopyFailedMessage,
  guestAccessPinRotatedMessage,
  guestGroupDraftErrors,
  guestGroupDraftPayload,
  guestGroupMenuActionLabels,
  guestGroupMenuActions,
} from "./guestGroupsForm";
import { emitGuestGroupsChanged } from "./guestGroupsRefresh";
import { OverflowMenu } from "./OverflowMenu";

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
    if (action === "copy-pin") {
      void copyAccessPin(group);
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

  async function copyAccessPin(group: GuestGroupRecord) {
    if (pending || group.isForeign) return;
    setPending(true);
    setError("");
    try {
      const result = await apiRequest<GuestAccessPinResponse>(
        `/v1/sites/${encodeURIComponent(siteId)}/groups/${encodeURIComponent(group.id)}/access-pin`,
      );
      const copied = await copyGuestAccessPin(
        result.accessPin,
        navigator.clipboard,
      );
      if (copied) {
        toast.success(guestAccessPinCopiedMessage(group.name));
        return;
      }
      toast.error(guestAccessPinCopyFailedMessage);
    } catch (cause) {
      setError(apiMessage(cause));
    } finally {
      setPending(false);
    }
  }

  async function rotateAccessPin(group: GuestGroupRecord) {
    if (pending || inactive || group.isForeign) return;
    setPending(true);
    setError("");
    try {
      await apiRequest<GuestAccessPinResponse>(
        `/v1/sites/${encodeURIComponent(siteId)}/groups/${encodeURIComponent(group.id)}/access-pin/rotate`,
        { method: "POST", body: {} },
      );
      toast.success(guestAccessPinRotatedMessage);
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
    <section className={adminStyles.card} aria-labelledby="guest-groups-title">
      <div className="flex items-end justify-between gap-3.5 max-[760px]:grid max-[760px]:grid-cols-1">
        <div>
          <h2
            className={`m-0 mb-[18px] text-[clamp(1.8rem,3vw,2.7rem)] ${displayHeading}`}
            id="guest-groups-title"
          >
            Grupos de convidados
          </h2>
          <p className="leading-[1.6]">
            Cadastre cada convite com seu nome de localização, convidados e um
            único representante. Compartilhe o PIN do grupo junto com o link de
            confirmação; o SMS poderá ser ativado depois.
          </p>
        </div>
        {!inactive && (
          <div className="ml-auto flex shrink-0 flex-wrap items-center gap-3.5 pb-1.5 max-[760px]:ml-0 max-[600px]:items-stretch">
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
        <p className={adminStyles.notice} role="note">
          Casamento inativo. Os grupos continuam disponíveis para consulta, mas
          criação, edição e exclusão ficam indisponíveis.
        </p>
      )}
      {error && !form && !deleteTarget && (
        <p className={adminStyles.alert} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="my-3.5 leading-[1.6] text-admin-muted" role="status">
          {notice}
        </p>
      )}

      <Dialog
        open={form !== null}
        onOpenChange={(open) => !open && closeForm()}
      >
        <DialogContent
          className={`${adminStyles.dialog} max-w-3xl max-h-[min(90vh,720px)]`}
        >
          <DialogTitle
            className={`font-admin-display text-4xl font-normal ${displayHeading}`}
          >
            {editingId ? "Editar grupo" : "Novo grupo"}
          </DialogTitle>
          <DialogDescription className="leading-[1.6] text-admin-muted">
            Escolha o representante e revise os dados antes de salvar.
          </DialogDescription>
          {form && (
            <form
              className={`${adminStyles.form} rounded-[10px] border border-admin-line bg-admin-beige p-5`}
              onSubmit={save}
            >
              {error && (
                <p className={adminStyles.alert} role="alert">
                  {error}
                </p>
              )}
              <label
                className="grid gap-2 text-[0.88rem] font-semibold text-admin-graphite"
                htmlFor="guest-group-name"
              >
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
                <label
                  className={adminStyles.checkbox}
                  htmlFor="guest-group-foreign"
                >
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
                <p
                  className="text-[0.87rem] leading-[1.6] text-admin-muted"
                  role="note"
                >
                  Grupo estrangeiro não usa telefone nem SMS. Este convite exige
                  atendimento administrativo; não há autenticação alternativa.
                </p>
              ) : (
                <label
                  className="grid gap-2 text-[0.88rem] font-semibold text-admin-graphite"
                  htmlFor="guest-group-phone"
                >
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
                  <span
                    className="text-[0.87rem] leading-[1.6] text-admin-muted"
                    id="guest-group-phone-help"
                  >
                    Use um celular brasileiro com DDD. Exemplo: (62) 99999-9999.
                    {phoneInvalid && " Confira o número informado."}
                  </span>
                </label>
              )}
              <fieldset className="grid gap-4">
                <legend>Convidados</legend>
                <p className="text-[0.87rem] leading-[1.6] text-admin-muted">
                  Escolha exatamente um representante. Ele será o contato
                  responsável pela confirmação deste convite.
                </p>
                {form.members.map((member, index) => (
                  <div
                    className="grid gap-2.5 max-[760px]:grid-cols-1"
                    key={member.id ?? index}
                  >
                    <div className="flex w-full items-center justify-between gap-3">
                      <label className="m-0" htmlFor={`guest-member-${index}`}>
                        Nome completo
                      </label>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-8"
                        disabled={pending || form.members.length <= 1}
                        type="button"
                        aria-label="Remover convidado"
                        onClick={() => removeMember(index)}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </div>
                    <Input
                      id={`guest-member-${index}`}
                      maxLength={160}
                      required
                      value={member.fullName}
                      onChange={(event) =>
                        updateMember(index, { fullName: event.target.value })
                      }
                    />
                    <div className="flex w-full items-center justify-between gap-3 max-[760px]:grid max-[760px]:grid-cols-1">
                      <label
                        className={adminStyles.checkbox}
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
                      {index === form.members.length - 1 && (
                        <Button
                          disabled={pending}
                          type="button"
                          variant="outline"
                          onClick={addMember}
                        >
                          Adicionar convidado
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </fieldset>
              <div className={adminStyles.inline}>
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
        <Card
          className="my-6 rounded-[10px] border border-admin-line bg-admin-beige p-5"
          role="status"
        >
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
          {error && (
            <p className={adminStyles.alert} role="alert">
              {error}
            </p>
          )}
          <label
            className="grid gap-2 text-[0.88rem] font-semibold text-admin-graphite"
            htmlFor="delete-group-confirmation"
          >
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
              className="justify-self-start border-admin-terracotta-deep bg-transparent text-admin-terracotta-deep"
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
        <p className="leading-[1.6]" role="status">
          Carregando grupos…
        </p>
      ) : groups.length === 0 ? (
        <p className="leading-[1.6]">Nenhum grupo cadastrado.</p>
      ) : (
        <div className="mt-6 grid gap-3">
          {groups.map((group) => {
            const actions = guestGroupMenuActions({
              owner,
              isDemo,
              inactive,
              isForeign: group.isForeign,
              phone: group.phone,
            });
            return (
              <Card
                className="items-stretch rounded-[10px] border border-admin-line bg-admin-surface p-5 max-[760px]:grid max-[760px]:grid-cols-1 [&_[data-slot=card-header]]:w-full [&_h3]:mb-2"
                key={group.id}
              >
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
                      <OverflowMenu
                        label={`Ações de ${group.name}`}
                        disabled={pending}
                        items={actions.map((action) => ({
                          id: action,
                          label: guestGroupMenuActionLabels[action],
                          variant:
                            action === "delete" ? "destructive" : "default",
                        }))}
                        onSelect={(action) =>
                          handleGroupMenuAction(
                            action as GuestGroupMenuAction,
                            group,
                          )
                        }
                      />
                    </CardAction>
                  )}
                </CardHeader>
                <CardContent>
                  <ul className="m-0 flex-1 basis-[220px] pl-5 leading-[1.6]">
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
