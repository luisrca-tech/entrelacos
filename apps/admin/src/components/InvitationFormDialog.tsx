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
import { Controller, useFieldArray, useForm, useWatch } from "react-hook-form";
import type { z } from "zod";
import { invitationFormValues } from "./invitationFormValues";
import { NumberedSection } from "./NumberedSection";

type FormInput = z.input<typeof invitationCreateInputSchema>;

type Props = {
  open: boolean;
  invitation: InvitationRecord | null;
  inactive: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (value: InvitationCreateInput) => void;
};

export function InvitationFormDialog({
  open,
  invitation,
  inactive,
  busy,
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

  const [reviewName, reviewGuests] = useWatch({
    control,
    name: ["name", "guests"],
  });
  const adults = (reviewGuests ?? []).filter(
    (guest) => guest.guestType !== "CHILD",
  ).length;
  const children = (reviewGuests ?? []).length - adults;
  const fieldLabel = "grid gap-2 text-sm font-semibold text-admin-graphite";
  const fieldError = "text-xs text-admin-status-declined";
  const inputClass = "min-h-11 border-admin-line bg-admin-surface";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-layout="sheet"
        showCloseButton
        className="top-0 right-0 left-auto flex h-dvh max-h-dvh w-full max-w-[min(560px,100vw)] translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-y-0 border-r-0 border-admin-line bg-admin-surface p-0 shadow-admin"
      >
        <form
          onSubmit={handleSubmit(onSave)}
          className="flex min-h-0 w-full flex-1 flex-col"
          noValidate
        >
          <div className="shrink-0 border-b border-admin-line py-6 pr-14 pl-[30px] [@media(max-width:760px)]:pl-[18px]">
            <DialogTitle className="font-admin-display text-3xl text-admin-graphite">
              {invitation ? "Editar convite" : "Novo convite"}
            </DialogTitle>
            <DialogDescription className="mt-2 leading-relaxed text-admin-muted">
              Um convite pode ter uma ou mais pessoas. Cada convidado responde
              individualmente.
            </DialogDescription>
          </div>
          <div className="grid min-h-0 flex-1 content-start gap-7 overflow-y-auto px-[30px] py-6 [@media(max-width:760px)]:px-[18px]">
            <NumberedSection number={1} title="Identificação">
              <label htmlFor="invitation-name" className={fieldLabel}>
                Identificação do convite
                <Input
                  id="invitation-name"
                  {...register("name")}
                  autoComplete="off"
                  maxLength={160}
                  aria-invalid={Boolean(errors.name)}
                  className={inputClass}
                />
                {errors.name && (
                  <span role="alert" className={fieldError}>
                    Informe a identificação do convite.
                  </span>
                )}
              </label>
              <label htmlFor="invitation-phone" className={fieldLabel}>
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
                      className={inputClass}
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
                  <span role="alert" className={fieldError}>
                    Informe um telefone válido.
                  </span>
                )}
              </label>
              <label htmlFor="invitation-email" className={fieldLabel}>
                <span>
                  E-mail de contato{" "}
                  <span className="text-xs font-normal text-admin-muted">
                    (opcional)
                  </span>
                </span>
                <Input
                  id="invitation-email"
                  {...register("email")}
                  type="email"
                  autoComplete="email"
                  maxLength={320}
                  aria-invalid={Boolean(errors.email)}
                  className={inputClass}
                />
                {errors.email && (
                  <span role="alert" className={fieldError}>
                    Informe um e-mail válido ou deixe o campo vazio.
                  </span>
                )}
              </label>
            </NumberedSection>
            <NumberedSection number={2} title="Pessoas">
              <ul className="m-0 grid list-none gap-3 p-0">
                {fields.map((field, index) => (
                  <li
                    key={field.fieldKey}
                    className="grid gap-3 rounded-xl border border-admin-line bg-admin-canvas p-4"
                  >
                    {field.id && (
                      <input
                        type="hidden"
                        {...register(`guests.${index}.id`)}
                      />
                    )}
                    <div className="flex items-end gap-2">
                      <label
                        htmlFor={`invitation-guest-name-${index}`}
                        className={`${fieldLabel} min-w-0 flex-1`}
                      >
                        Nome da pessoa {index + 1}
                        <Input
                          id={`invitation-guest-name-${index}`}
                          {...register(`guests.${index}.fullName`)}
                          maxLength={160}
                          aria-invalid={Boolean(
                            errors.guests?.[index]?.fullName,
                          )}
                          className={inputClass}
                        />
                      </label>
                      {fields.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => remove(index)}
                          disabled={busy || inactive}
                          aria-label={`Remover pessoa ${index + 1}`}
                          className="size-11 shrink-0"
                        >
                          <Trash2 aria-hidden="true" className="size-4" />
                        </Button>
                      )}
                    </div>
                    {errors.guests?.[index]?.fullName && (
                      <span role="alert" className={fieldError}>
                        Informe o nome do convidado.
                      </span>
                    )}
                    <fieldset className="m-0 grid grid-cols-2 gap-2 border-0 p-0">
                      <legend className="sr-only">
                        Faixa etária da pessoa {index + 1}
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
                  </li>
                ))}
              </ul>
              <Button
                type="button"
                variant="outline"
                onClick={() => append({ fullName: "", guestType: "ADULT" })}
                disabled={busy || inactive}
                className="min-h-11 w-fit border-admin-line"
              >
                <Plus aria-hidden="true" className="size-4" />
                Adicionar pessoa
              </Button>
              {errors.guests?.root && (
                <span role="alert" className={fieldError}>
                  Adicione pelo menos um convidado.
                </span>
              )}
            </NumberedSection>
            <NumberedSection number={3} title="Revisar">
              <dl className="m-0 grid gap-2 rounded-xl border border-admin-line bg-admin-canvas p-4 text-sm">
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="text-admin-muted">Convite</dt>
                  <dd className="m-0 min-w-0 break-words font-semibold">
                    {reviewName?.trim() || "Sem identificação"}
                  </dd>
                </div>
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="text-admin-muted">Pessoas</dt>
                  <dd className="m-0 font-semibold">
                    {adults + children}{" "}
                    {adults + children === 1 ? "pessoa" : "pessoas"} · {adults}{" "}
                    {adults === 1 ? "adulto" : "adultos"} · {children}{" "}
                    {children === 1 ? "criança" : "crianças"}
                  </dd>
                </div>
              </dl>
            </NumberedSection>
          </div>
          <div
            data-slot="sheet-footer"
            className="sticky bottom-0 flex w-full shrink-0 justify-end gap-2 border-t border-admin-line bg-admin-surface px-[30px] py-3 [@media(max-width:760px)]:px-[18px]"
          >
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              disabled={busy || inactive}
              className="bg-admin-terracotta text-white hover:bg-admin-terracotta-deep"
            >
              {busy ? "Salvando…" : "Salvar convite"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
