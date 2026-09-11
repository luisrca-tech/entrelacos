import {
  brazilianPhoneInputSchema,
  type DemoGuestGrantResponse,
  type GuestGroupRecord,
} from "@entrelacos/contracts";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { ApiError, apiRequest } from "../lib/apiClient";
import {
  canIssueDemoGuestGrant,
  createGuestGroupDraft,
  type GuestGroupDraft,
  guestGroupDraftErrors,
  guestGroupDraftPayload,
} from "./guestGroupsForm";

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
    } catch (cause) {
      setError(apiMessage(cause));
    } finally {
      setPending(false);
    }
  }

  async function remove(group: GuestGroupRecord) {
    if (inactive || pending) return;
    if (!window.confirm(`Excluir o grupo “${group.name}”?`)) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      await apiRequest(
        `/v1/sites/${encodeURIComponent(siteId)}/groups/${encodeURIComponent(group.id)}`,
        { method: "DELETE", body: {} },
      );
      setNotice("Grupo excluído.");
      if (editingId === group.id) closeForm();
      await load();
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
            único representante para receber o código por SMS.
          </p>
        </div>
        {!inactive && (
          <div className="inline-actions">
            <button
              disabled={pending}
              type="button"
              onClick={() => startCreate(false)}
            >
              Novo grupo
            </button>
            <button
              disabled={pending}
              type="button"
              onClick={() => startCreate(true)}
            >
              Convite individual
            </button>
          </div>
        )}
      </div>
      {inactive && (
        <p className="notice" role="note">
          Casamento inativo. Os grupos continuam disponíveis para consulta, mas
          criação, edição e exclusão ficam indisponíveis.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {demoGrant && (
        <div className="demo-guest-grant" role="status">
          <strong>Autorização temporária · {demoGrant.groupName}</strong>
          <p>
            Cole este valor somente no campo de demonstração do site público.
            Ele expira às {new Date(demoGrant.expiresAt).toLocaleTimeString()} e
            não deve ser colocado em URL, cookie ou armazenamento local.
          </p>
          <input
            aria-label="Autorização temporária da demonstração"
            readOnly
            spellCheck={false}
            value={demoGrant.grant}
          />
        </div>
      )}
      {form && !inactive && (
        <form className="guest-group-form data-form" onSubmit={save}>
          <div className="guest-group-form-heading">
            <h3>{editingId ? "Editar grupo" : "Novo grupo"}</h3>
            <button type="button" onClick={closeForm} disabled={pending}>
              Cancelar
            </button>
          </div>
          <label>
            Nome do grupo
            <input
              maxLength={160}
              required
              value={form.name}
              onChange={(event) => updateForm({ name: event.target.value })}
              placeholder="Família Silva"
            />
          </label>
          <fieldset>
            <legend>Tipo de convite</legend>
            <label className="radio-label">
              <input
                checked={!form.isForeign}
                name="guest-group-kind"
                type="radio"
                onChange={() => updateForm({ isForeign: false })}
              />
              Grupo brasileiro
            </label>
            <label className="radio-label">
              <input
                checked={form.isForeign}
                name="guest-group-kind"
                type="radio"
                onChange={() => updateForm({ isForeign: true })}
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
            <label>
              Celular do representante
              <input
                aria-describedby="guest-group-phone-help"
                aria-invalid={phoneInvalid}
                inputMode="tel"
                maxLength={40}
                placeholder="(62) 99999-9999"
                required
                type="tel"
                value={form.phone}
                onChange={(event) => updateForm({ phone: event.target.value })}
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
              Escolha exatamente um representante. Ele será o contato que recebe
              o código de verificação.
            </p>
            {form.members.map((member, index) => (
              <div className="guest-member-editor" key={member.id ?? index}>
                <label>
                  Nome completo
                  <input
                    maxLength={160}
                    required
                    value={member.fullName}
                    onChange={(event) =>
                      updateMember(index, { fullName: event.target.value })
                    }
                  />
                </label>
                <label className="radio-label">
                  <input
                    checked={member.isRepresentative}
                    name="guest-group-representative"
                    type="radio"
                    onChange={() =>
                      setForm((current) =>
                        current
                          ? {
                              ...current,
                              members: current.members.map(
                                (candidate, candidateIndex) => ({
                                  ...candidate,
                                  isRepresentative: candidateIndex === index,
                                }),
                              ),
                            }
                          : current,
                      )
                    }
                  />
                  Representante
                </label>
                <button
                  disabled={pending || form.members.length <= 1}
                  type="button"
                  onClick={() => removeMember(index)}
                >
                  Remover
                </button>
              </div>
            ))}
            <button disabled={pending} type="button" onClick={addMember}>
              Adicionar convidado
            </button>
          </fieldset>
          <div className="inline-actions">
            <button disabled={pending} type="submit">
              {pending
                ? "Salvando…"
                : editingId
                  ? "Salvar grupo"
                  : "Criar grupo"}
            </button>
            <button disabled={pending} type="button" onClick={closeForm}>
              Cancelar
            </button>
          </div>
        </form>
      )}
      {loading ? (
        <p role="status">Carregando grupos…</p>
      ) : groups.length === 0 ? (
        <p>Nenhum grupo cadastrado.</p>
      ) : (
        <div className="guest-group-list">
          {groups.map((group) => (
            <article className="guest-group-card" key={group.id}>
              <div>
                <h3>{group.name}</h3>
                <p className="guest-group-meta">
                  {group.isForeign
                    ? "Grupo estrangeiro · sem SMS"
                    : `Representante: ${group.members.find((member) => member.isRepresentative)?.fullName ?? "Não informado"} · ${group.phone}`}
                </p>
              </div>
              <ul className="guest-group-members">
                {group.members.map((member) => (
                  <li key={member.id}>
                    {member.fullName}
                    {member.isRepresentative && " · representante"}
                  </li>
                ))}
              </ul>
              {!inactive && (
                <div className="inline-actions">
                  {canIssueDemoGuestGrant(owner, isDemo, inactive, group) && (
                    <button
                      disabled={pending}
                      type="button"
                      onClick={() => void issueDemoAccess(group)}
                    >
                      Gerar acesso demo
                    </button>
                  )}
                  <button
                    disabled={pending}
                    type="button"
                    onClick={() => startEdit(group)}
                  >
                    Editar
                  </button>
                  <button
                    disabled={pending}
                    type="button"
                    onClick={() => void remove(group)}
                  >
                    Excluir
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
