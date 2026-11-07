import {
  ownerAdminCreateInputSchema,
  ownerSiteCreateInputSchema,
} from "@entrelacos/contracts";
import {
  Badge,
  Button,
  DatePicker,
  Dialog,
  DialogDescription,
  DialogTitle,
  Input,
} from "@entrelacos/ui";
import { Check } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { adminStyles } from "../lib/adminStyles";
import { ApiError } from "../lib/apiClient";
import { AdminDialogContent } from "./AdminDialog";
import { formatBrazilianDate } from "./brazilianDate";
import { GeneratedAccessLink } from "./GeneratedAccessLink";
import { NumberedSection } from "./NumberedSection";
import { StatusSignal } from "./StatusSignal";
import { adminAccessLink } from "./siteAdminMenu";
import {
  createWedding,
  type WeddingCheckpoint,
  type WeddingDraft,
  type WeddingOutcome,
  weddingSlug,
} from "./weddingCreation";

export function CreateWeddingDialog({
  disabled,
  current,
  onCreated,
  onFailure,
  navigate,
}: {
  disabled: boolean;
  current: () => boolean;
  onCreated: () => void;
  onFailure: (cause: unknown) => void;
  navigate: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const saving = useRef(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!saving.current) setOpen(next);
      }}
    >
      <Button
        type="button"
        className={primary}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        Criar casamento
      </Button>
      {open && (
        <WeddingDialogContent
          current={current}
          saving={saving}
          onCreated={onCreated}
          onFailure={onFailure}
          navigate={navigate}
          close={() => setOpen(false)}
        />
      )}
    </Dialog>
  );
}

const primary = "bg-admin-terracotta text-white hover:bg-admin-terracotta-deep";
const fields = "grid gap-3 sm:grid-cols-2";

function WeddingDialogContent({
  current,
  saving,
  onCreated,
  onFailure,
  navigate,
  close,
}: {
  current: () => boolean;
  onCreated: () => void;
  onFailure: (cause: unknown) => void;
  navigate: (path: string) => void;
  close: () => void;
  saving: React.RefObject<boolean>;
}) {
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [editedName, setEditedName] = useState<string | null>(null);
  const [editedSlug, setEditedSlug] = useState<string | null>(null);
  const [editSlug, setEditSlug] = useState(false);
  const [addAdmin, setAddAdmin] = useState(false);
  const [issueLink, setIssueLink] = useState(false);
  const [error, setError] = useState("");
  const [keyConflict, setKeyConflict] = useState(false);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<WeddingOutcome | null>(null);
  const checkpoint = useRef<WeddingCheckpoint>({});
  const lastDraft = useRef<WeddingDraft | null>(null);
  const key = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const active = () => mounted.current && current();
  const name =
    editedName ?? [first.trim(), second.trim()].filter(Boolean).join(" & ");
  const slug = editedSlug ?? weddingSlug(first, second);
  // Once the site exists only its record is locked; the couple step stays
  // editable until a person is registered, so a rejected e-mail can be fixed.
  const siteFixed = Boolean(checkpoint.current.site);
  const adminFixed = Boolean(checkpoint.current.userId);

  async function save(draft: WeddingDraft) {
    if (!active() || saving.current) return;
    saving.current = true;
    setPending(true);
    setError("");
    setKeyConflict(false);
    lastDraft.current = draft;
    try {
      const result = await createWedding(
        draft,
        checkpoint.current,
        (value) => {
          const created = !checkpoint.current.site && value.site;
          checkpoint.current = value;
          if (created && active()) onCreated();
        },
        active,
      );
      if (!result || !active()) return;
      setOutcome(result);
      if (draft.admin) onCreated();
    } catch (cause) {
      if (!active()) return;
      onFailure(cause);
      if (!active()) return;
      const code = cause instanceof ApiError ? cause.code : null;
      if (!checkpoint.current.site && code === "REPOSITORY_SLUG_CONFLICT") {
        setEditSlug(true);
        setError("Esse identificador já está em uso. Escolha outro.");
        return;
      }
      if (!checkpoint.current.site && code === "PROVISIONING_KEY_CONFLICT") {
        setKeyConflict(true);
        onCreated();
        setError(
          "Uma tentativa anterior já usou este cadastro com outros dados. Confira a lista de casamentos antes de recomeçar, para não criar o mesmo casamento duas vezes.",
        );
        return;
      }
      setError(
        checkpoint.current.userId
          ? "O casamento e a pessoa já foram cadastrados. Tente gerar o link novamente."
          : checkpoint.current.site
            ? "O casamento já foi criado. Tente cadastrar a pessoa novamente."
            : "Não foi possível criar o casamento. Confira os dados e tente novamente.",
      );
    } finally {
      saving.current = false;
      if (active()) setPending(false);
    }
  }

  function restart() {
    key.current = null;
    setKeyConflict(false);
    setError("");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const previous = lastDraft.current;
    if (siteFixed && previous) {
      if (adminFixed) {
        void save({ ...previous, issueLink });
        return;
      }
      const retryAdmin = addAdmin
        ? ownerAdminCreateInputSchema.safeParse({
            name: data.get("adminName"),
            email: data.get("adminEmail"),
          })
        : null;
      if (retryAdmin && !retryAdmin.success) {
        setError("Confira o nome e o e-mail da pessoa do casal.");
        return;
      }
      void save({
        site: previous.site,
        admin: retryAdmin?.data ?? null,
        issueLink: Boolean(retryAdmin) && issueLink,
      });
      return;
    }
    key.current ??= crypto.randomUUID();
    const site = ownerSiteCreateInputSchema.safeParse({
      provisioningKey: key.current,
      repositorySlug: slug,
      displayName: name,
      coupleNames: [first, second],
      eventDate: data.get("date"),
    });
    const admin = addAdmin
      ? ownerAdminCreateInputSchema.safeParse({
          name: data.get("adminName"),
          email: data.get("adminEmail"),
        })
      : null;
    if (!site.success || (admin && !admin.success)) {
      setError(
        "Confira os dados. Use apenas letras minúsculas, números e hífens no identificador do site.",
      );
      return;
    }
    void save({ site: site.data, admin: admin?.data ?? null, issueLink });
  }

  const draft = lastDraft.current;
  const admin = draft?.admin;
  const created = outcome?.site;
  return (
    <AdminDialogContent showCloseButton className="max-w-[640px]">
      {outcome && draft ? (
        <>
          <div className="flex items-start gap-3 pr-8">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-admin-success-wash text-admin-success-ink">
              <Check aria-hidden="true" />
            </span>
            <div>
              <DialogTitle className="font-admin-display text-2xl font-normal">
                Casamento criado
              </DialogTitle>
              <DialogDescription>
                {created?.displayName} foi cadastrado em rascunho.
              </DialogDescription>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-admin-line bg-admin-canvas p-4">
            <div className="min-w-0 break-words">
              <strong>{created?.displayName}</strong>
              <p className="m-0 text-sm text-admin-muted">
                {created?.coupleNames.join(" e ")} ·{" "}
                {created && formatBrazilianDate(created.eventDate)}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">Rascunho</Badge>
              <StatusSignal tone={created?.publicUrl ? "success" : "neutral"}>
                {created?.publicUrl ? "Site vinculado" : "Site não vinculado"}
              </StatusSignal>
            </div>
          </div>
          {admin && outcome.access ? (
            <GeneratedAccessLink
              name={admin.name}
              email={admin.email}
              url={adminAccessLink(
                window.location.origin,
                outcome.access.token,
                "ACTIVATION",
              )}
            />
          ) : (
            <div className="grid gap-3 rounded-xl border border-admin-line p-4">
              <p className="m-0 text-sm text-admin-muted">
                {admin
                  ? `${admin.name} está cadastrado. O link de acesso ainda não foi gerado.`
                  : "Ninguém do casal foi cadastrado. Você pode adicionar uma pessoa em Configurações → Acessos do casal."}
              </p>
              {admin && (
                <Button
                  type="button"
                  className={`w-fit ${primary}`}
                  disabled={pending}
                  onClick={() => void save({ ...draft, issueLink: true })}
                >
                  {pending
                    ? "Gerando…"
                    : error
                      ? "Tentar gerar novamente"
                      : "Gerar link agora"}
                </Button>
              )}
              {!admin && (
                <Button
                  type="button"
                  variant="outline"
                  className="w-fit"
                  onClick={() =>
                    navigate(
                      `/sites/${encodeURIComponent(outcome.site.id)}/settings?tab=access`,
                    )
                  }
                >
                  Cadastrar pessoa
                </Button>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className={adminStyles.authError}>
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={close}
              disabled={pending}
            >
              Voltar para a lista
            </Button>
            <Button
              type="button"
              className={primary}
              disabled={pending}
              onClick={() =>
                navigate(`/sites/${encodeURIComponent(outcome.site.id)}/home`)
              }
            >
              Abrir casamento
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="grid gap-1 pr-8">
            <DialogTitle className="font-admin-display text-2xl font-normal">
              Criar casamento
            </DialogTitle>
            <DialogDescription>
              Cadastre o casal e a data. O casamento começa em rascunho e o
              endereço público é vinculado depois.
            </DialogDescription>
          </div>
          <form className="grid gap-5" onSubmit={submit}>
            <NumberedSection number={1} title="Casal e data">
              <div className={fields}>
                <label
                  className="grid gap-1.5 text-sm font-medium"
                  htmlFor="new-wedding-first"
                >
                  Nome da pessoa 1
                  <Input
                    id="new-wedding-first"
                    name="first"
                    value={first}
                    onChange={(event) => setFirst(event.target.value)}
                    maxLength={120}
                    required
                    disabled={pending || siteFixed}
                  />
                </label>
                <label
                  className="grid gap-1.5 text-sm font-medium"
                  htmlFor="new-wedding-second"
                >
                  Nome da pessoa 2
                  <Input
                    id="new-wedding-second"
                    name="second"
                    value={second}
                    onChange={(event) => setSecond(event.target.value)}
                    maxLength={120}
                    required
                    disabled={pending || siteFixed}
                  />
                </label>
                <label
                  className="grid gap-1.5 text-sm font-medium"
                  htmlFor="new-wedding-date"
                >
                  Data do casamento
                  <DatePicker
                    id="new-wedding-date"
                    name="date"
                    required
                    disabled={pending || siteFixed}
                  />
                </label>
                <label
                  className="grid gap-1.5 text-sm font-medium"
                  htmlFor="new-wedding-name"
                >
                  Nome do casamento
                  <Input
                    id="new-wedding-name"
                    name="name"
                    value={name}
                    onChange={(event) => setEditedName(event.target.value)}
                    maxLength={160}
                    required
                    disabled={pending || siteFixed}
                  />
                </label>
              </div>
            </NumberedSection>
            <NumberedSection number={2} title="Quem vai administrar (opcional)">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={addAdmin}
                  onChange={(event) => setAddAdmin(event.target.checked)}
                  disabled={pending || adminFixed}
                />{" "}
                Cadastrar alguém do casal agora
              </label>
              {addAdmin && (
                <>
                  <div className={fields}>
                    <label
                      className="grid gap-1.5 text-sm font-medium"
                      htmlFor="new-wedding-adminName"
                    >
                      Nome
                      <Input
                        id="new-wedding-adminName"
                        name="adminName"
                        maxLength={160}
                        required
                        disabled={pending || adminFixed}
                      />
                    </label>
                    <label
                      className="grid gap-1.5 text-sm font-medium"
                      htmlFor="new-wedding-adminEmail"
                    >
                      E-mail
                      <Input
                        id="new-wedding-adminEmail"
                        name="adminEmail"
                        type="email"
                        maxLength={320}
                        required
                        disabled={pending || adminFixed}
                      />
                    </label>
                  </div>
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <input
                      type="checkbox"
                      checked={issueLink}
                      onChange={(event) => setIssueLink(event.target.checked)}
                      disabled={pending}
                    />{" "}
                    Gerar link de acesso ao criar
                  </label>
                  <p className="m-0 text-xs text-admin-muted">
                    O link vale por 24 horas. Você também pode gerar em
                    Configurações → Acessos do casal.
                  </p>
                </>
              )}
            </NumberedSection>
            <NumberedSection number={3} title="Identificador do site">
              {editSlug ? (
                <label
                  className="grid gap-1.5 text-sm font-medium"
                  htmlFor="new-wedding-slug"
                >
                  Identificador
                  <Input
                    id="new-wedding-slug"
                    name="slug"
                    value={slug}
                    onChange={(event) => setEditedSlug(event.target.value)}
                    maxLength={64}
                    required
                    disabled={pending || siteFixed}
                  />
                </label>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-admin-line bg-admin-canvas p-3 text-sm">
                  <span className="break-all">
                    Identificador do site: <strong>{slug || "—"}</strong>
                  </span>
                  <Button
                    type="button"
                    variant="link"
                    onClick={() => setEditSlug(true)}
                    disabled={pending || siteFixed}
                  >
                    Alterar
                  </Button>
                </div>
              )}
              <p className="m-0 text-xs text-admin-muted">
                O identificador não pode ser alterado depois. Use letras
                minúsculas, números e hífens.
              </p>
            </NumberedSection>
            {error && (
              <p role="alert" className={adminStyles.authError}>
                {error}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              {keyConflict && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={restart}
                  disabled={pending}
                >
                  Recomeçar com novo cadastro
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={close}
                disabled={pending}
              >
                Cancelar
              </Button>
              <Button type="submit" className={primary} disabled={pending}>
                {pending
                  ? "Salvando…"
                  : error
                    ? "Tentar novamente"
                    : "Criar casamento"}
              </Button>
            </div>
          </form>
        </>
      )}
    </AdminDialogContent>
  );
}
