import {
  formatInvitationPhoneInput,
  type InvitationCreateInput,
  type InvitationRecord,
  invitationCreateInputSchema,
} from "@entrelacos/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
} from "@entrelacos/ui";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Trash2 } from "lucide-react";
import { useEffect } from "react";
import { Controller, useFieldArray, useForm } from "react-hook-form";
import type { z } from "zod";
import { adminStyles } from "../lib/adminStyles";
import { invitationFormValues } from "./invitationFormValues";

type FormInput = z.input<typeof invitationCreateInputSchema>;

type Props = {
  open: boolean;
  invitation: InvitationRecord | null;
  inactive: boolean;
  busy: boolean;
  error: string;
  onOpenChange: (open: boolean) => void;
  onSave: (value: InvitationCreateInput) => void;
};

export function InvitationFormDialog({
  open,
  invitation,
  inactive,
  busy,
  error,
  onOpenChange,
  onSave,
}: Props) {
  const {
    register,
    control,
    reset,
    handleSubmit,
    formState: { errors },
  } = useForm<FormInput, unknown, InvitationCreateInput>({
    resolver: zodResolver(invitationCreateInputSchema),
    defaultValues: invitationFormValues(invitation),
  });
  const { fields, append, remove } = useFieldArray({
    control,
    name: "guests",
    keyName: "fieldKey",
  });

  useEffect(() => {
    if (open) reset(invitationFormValues(invitation));
  }, [open, invitation, reset]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={`${adminStyles.dialog} flex max-w-[min(720px,calc(100vw-32px))] flex-col gap-0 overflow-hidden p-0`}
      >
        <form
          onSubmit={handleSubmit(onSave)}
          className="flex min-h-0 w-full flex-col"
          noValidate
        >
          <div className="min-h-0 flex-auto overflow-y-auto px-[30px] pt-[30px] [@media(max-width:760px)]:px-[18px] [@media(max-width:760px)]:pt-6">
            <DialogTitle className="font-admin-display text-3xl text-admin-graphite">
              {invitation ? "Editar convite" : "Adicionar convite"}
            </DialogTitle>
            <DialogDescription className="mt-4 leading-relaxed text-admin-muted">
              Um convite pode ter uma ou mais pessoas. Cada convidado responde
              individualmente.
            </DialogDescription>
            <div className="mt-5 grid gap-6 pb-6">
              {error && (
                <p role="alert" className={adminStyles.alert}>
                  {error}
                </p>
              )}
              <fieldset className="grid gap-4">
                <legend className="mb-3 font-admin-display text-xl text-admin-graphite">
                  Dados do convite
                </legend>
                <label
                  htmlFor="invitation-name"
                  className="grid gap-2 text-sm font-semibold text-admin-graphite"
                >
                  Identificação do convite
                  <Input
                    id="invitation-name"
                    {...register("name")}
                    autoComplete="off"
                    maxLength={160}
                    aria-invalid={Boolean(errors.name)}
                    className="min-h-11 border-admin-line bg-admin-surface"
                  />
                  {errors.name && (
                    <span
                      role="alert"
                      className="text-xs text-admin-status-declined"
                    >
                      Informe a identificação do convite.
                    </span>
                  )}
                </label>
                <label
                  htmlFor="invitation-phone"
                  className="grid gap-2 text-sm font-semibold text-admin-graphite"
                >
                  Telefone de contato
                  <Controller
                    control={control}
                    name="phone"
                    render={({ field }) => (
                      <Input
                        id="invitation-phone"
                        ref={field.ref}
                        name={field.name}
                        value={field.value}
                        onBlur={field.onBlur}
                        onChange={(event) =>
                          field.onChange(
                            formatInvitationPhoneInput(event.target.value),
                          )
                        }
                        type="tel"
                        inputMode="tel"
                        autoComplete="tel"
                        placeholder="(11) 99999-9999 ou +1 212 555 0123"
                        aria-invalid={Boolean(errors.phone)}
                        aria-describedby="invitation-phone-help"
                        className="min-h-11 border-admin-line bg-admin-surface"
                      />
                    )}
                  />
                  <span
                    id="invitation-phone-help"
                    className="text-xs font-normal leading-relaxed text-admin-muted"
                  >
                    Números brasileiros podem ser informados sem +55. Para outro
                    país, comece com + e o código internacional.
                  </span>
                  {errors.phone && (
                    <span
                      role="alert"
                      className="text-xs text-admin-status-declined"
                    >
                      Informe um telefone válido.
                    </span>
                  )}
                </label>
                <label
                  htmlFor="invitation-email"
                  className="grid gap-2 text-sm font-semibold text-admin-graphite"
                >
                  E-mail de contato{" "}
                  <span className="text-xs font-normal text-admin-muted">
                    (opcional)
                  </span>
                  <Input
                    id="invitation-email"
                    {...register("email")}
                    type="email"
                    autoComplete="email"
                    maxLength={320}
                    aria-invalid={Boolean(errors.email)}
                    className="min-h-11 border-admin-line bg-admin-surface"
                  />
                  {errors.email && (
                    <span
                      role="alert"
                      className="text-xs text-admin-status-declined"
                    >
                      Informe um e-mail válido ou deixe o campo vazio.
                    </span>
                  )}
                </label>
              </fieldset>
              <fieldset className="grid gap-3 border-t border-admin-line pt-5">
                <legend className="mb-3 font-admin-display text-xl text-admin-graphite">
                  Convidados neste convite ({fields.length})
                </legend>
                {fields.map((field, index) => (
                  <div
                    key={field.fieldKey}
                    className="grid gap-3 rounded-xl border border-admin-line bg-admin-canvas p-4"
                  >
                    {field.id && (
                      <input
                        type="hidden"
                        {...register(`guests.${index}.id`)}
                      />
                    )}
                    <div className="flex items-center justify-between gap-3">
                      <strong className="text-sm text-admin-graphite">
                        Convidado {index + 1}
                      </strong>
                      {fields.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => remove(index)}
                          disabled={busy || inactive}
                          aria-label={`Remover convidado ${index + 1}`}
                        >
                          <Trash2 aria-hidden="true" className="size-4" />
                          Remover
                        </Button>
                      )}
                    </div>
                    <label
                      htmlFor={`invitation-guest-name-${index}`}
                      className="grid gap-2 text-sm font-semibold text-admin-graphite"
                    >
                      Nome completo do convidado
                      <Input
                        id={`invitation-guest-name-${index}`}
                        {...register(`guests.${index}.fullName`)}
                        maxLength={160}
                        aria-invalid={Boolean(errors.guests?.[index]?.fullName)}
                        className="min-h-11 border-admin-line bg-admin-surface"
                      />
                      {errors.guests?.[index]?.fullName && (
                        <span
                          role="alert"
                          className="text-xs text-admin-status-declined"
                        >
                          Informe o nome do convidado.
                        </span>
                      )}
                    </label>
                    <fieldset className="grid grid-cols-2 gap-2">
                      <legend className="sr-only">
                        Faixa etária do convidado {index + 1}
                      </legend>
                      <label className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border border-admin-line bg-admin-surface px-3 text-sm">
                        <input
                          type="radio"
                          value="ADULT"
                          {...register(`guests.${index}.guestType`)}
                          className="accent-admin-terracotta"
                        />
                        Adulto
                      </label>
                      <label className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border border-admin-line bg-admin-surface px-3 text-sm">
                        <input
                          type="radio"
                          value="CHILD"
                          {...register(`guests.${index}.guestType`)}
                          className="accent-admin-terracotta"
                        />
                        Criança
                      </label>
                    </fieldset>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => append({ fullName: "", guestType: "ADULT" })}
                  disabled={busy || inactive}
                  className="min-h-11 border-admin-line"
                >
                  <Plus aria-hidden="true" className="size-4" />
                  Adicionar convidado
                </Button>
                {errors.guests?.root && (
                  <span
                    role="alert"
                    className="text-xs text-admin-status-declined"
                  >
                    Adicione pelo menos um convidado.
                  </span>
                )}
              </fieldset>
            </div>
          </div>
          <div className="mt-auto flex w-full shrink-0 justify-end gap-2 border-t border-admin-line bg-admin-surface px-[30px] py-3 [@media(max-width:760px)]:px-[18px]">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={busy || inactive}>
              {busy ? "Salvando…" : "Salvar convite"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
