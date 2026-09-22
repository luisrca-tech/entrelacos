export type SiteAdminMenuAction =
  | "issue-access"
  | "revoke-access"
  | "disable-access";

export type SiteAdminMenuItem = {
  id: SiteAdminMenuAction;
  label: string;
  variant?: "destructive";
};

export function siteAdminMenuActions(
  state: "PENDING" | "ACTIVE" | "DISABLED",
): SiteAdminMenuItem[] {
  if (state === "DISABLED") return [];
  return [
    {
      id: "issue-access",
      label:
        state === "PENDING"
          ? "Gerar link de ativação"
          : "Gerar link de recuperação",
    },
    { id: "revoke-access", label: "Revogar link" },
    {
      id: "disable-access",
      label: "Desativar acesso",
      variant: "destructive",
    },
  ];
}

export type AdminAccessPurpose = "ACTIVATION" | "RECOVERY";

export function adminAccessLink(
  origin: string,
  token: string,
  purpose: AdminAccessPurpose,
): string {
  return `${origin}/${purpose === "ACTIVATION" ? "activate" : "recover"}#token=${token}`;
}

export async function copyAdminAccessLink(
  link: string,
  clipboard: Pick<Clipboard, "writeText">,
): Promise<boolean> {
  try {
    await clipboard.writeText(link);
    return true;
  } catch {
    return false;
  }
}

export function adminAccessLinkCopiedMessage(
  email: string,
  purpose: AdminAccessPurpose,
): string {
  return purpose === "ACTIVATION"
    ? `Link de ativação de ${email} copiado.`
    : `Link de recuperação de ${email} copiado.`;
}

export const adminAccessLinkCopyFailedMessage =
  "Não foi possível copiar o link. Tente novamente.";

export function adminAccessLinkRevokedMessage(
  email: string,
  purpose: AdminAccessPurpose,
): string {
  return purpose === "ACTIVATION"
    ? `Link anterior revogado. Link de ativação de ${email} copiado.`
    : `Link anterior revogado. Link de recuperação de ${email} copiado.`;
}
