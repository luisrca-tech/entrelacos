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
