import { Button, Input, toast } from "@entrelacos/ui";
import { useId } from "react";
import {
  adminAccessLinkCopyFailedMessage,
  copyAdminAccessLink,
} from "./siteAdminMenu";

export function GeneratedAccessLink({
  name,
  email,
  url,
  onDismiss,
}: {
  name: string;
  email: string;
  url: string;
  onDismiss?: () => void;
}) {
  const id = useId();
  const subject = encodeURIComponent("Seu acesso ao painel Entrelaços");
  const body = encodeURIComponent(
    `Olá, ${name}! Use este link para definir sua senha e entrar no painel do casamento.\n\n${url}\n\nO link vale por 24 horas e pode ser usado uma vez.`,
  );
  return (
    <section className="grid min-w-0 gap-3 rounded-xl border border-admin-line bg-admin-surface p-4">
      <label htmlFor={id} className="break-words text-sm font-semibold">
        Link de acesso para {name} ({email})
      </label>
      <Input
        id={id}
        readOnly
        value={url}
        className="min-w-0 bg-admin-canvas text-xs"
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          className="bg-admin-terracotta text-white hover:bg-admin-terracotta-deep"
          onClick={async () => {
            if (await copyAdminAccessLink(url, navigator.clipboard))
              toast.success("Link copiado.");
            else toast.error(adminAccessLinkCopyFailedMessage);
          }}
        >
          Copiar link
        </Button>
        <Button
          variant="outline"
          nativeButton={false}
          render={
            <a
              href={`mailto:${encodeURIComponent(email)}?subject=${subject}&body=${body}`}
            />
          }
        >
          Enviar por e-mail
        </Button>
        {onDismiss && (
          <Button type="button" variant="link" onClick={onDismiss}>
            Ocultar link
          </Button>
        )}
      </div>
      <p className="m-0 rounded-lg bg-admin-pending-wash p-3 text-xs text-admin-pending-ink">
        Vale por 24 horas e pode ser usado uma vez. Se expirar, gere outro em
        Configurações → Acessos do casal.
      </p>
    </section>
  );
}
