import { Input, toast } from "@entrelacos/ui";
import { useId } from "react";
import { AdminButton } from "./AdminButton";
import {
  adminAccessLinkCopyFailedMessage,
  copyAdminAccessLink,
} from "./siteAdminMenu";

export function accessLinkMailto(name: string, email: string, url: string) {
  // RFC 6068 keeps "@" literal in the recipient; only the fields are encoded.
  const recipient = encodeURIComponent(email).replaceAll("%40", "@");
  const subject = encodeURIComponent("Seu acesso ao painel Entrelaços");
  const body = encodeURIComponent(
    `Olá, ${name}! Use este link para definir sua senha e entrar no painel do casamento.\n\n${url}\n\nO link vale por 24 horas e pode ser usado uma vez.`,
  );
  return `mailto:${recipient}?subject=${subject}&body=${body}`;
}

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
  return (
    <section className="grid min-w-0 gap-3 rounded-xl border border-admin-border bg-admin-surface p-4">
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
        <AdminButton
          tone="primary"
          type="button"
          onClick={async () => {
            if (await copyAdminAccessLink(url, navigator.clipboard))
              toast.success("Link copiado.");
            else toast.error(adminAccessLinkCopyFailedMessage);
          }}
        >
          Copiar link
        </AdminButton>
        <AdminButton
          tone="secondary"
          nativeButton={false}
          render={<a href={accessLinkMailto(name, email, url)} />}
        >
          Enviar por e-mail
        </AdminButton>
        {onDismiss && (
          <AdminButton type="button" tone="link" onClick={onDismiss}>
            Ocultar link
          </AdminButton>
        )}
      </div>
      <p className="m-0 rounded-lg bg-admin-pending-subtle p-3 text-xs text-admin-pending-text">
        Vale por 24 horas e pode ser usado uma vez. Se expirar, gere outro em
        Configurações → Acessos do casal.
      </p>
    </section>
  );
}
