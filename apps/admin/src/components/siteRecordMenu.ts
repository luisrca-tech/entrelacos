export type SiteRecordMenuAction = "profile" | "dates" | "publication";

export const siteRecordMenuActions: Array<{
  id: SiteRecordMenuAction;
  label: string;
}> = [
  { id: "profile", label: "Editar cadastro" },
  { id: "dates", label: "Editar datas" },
  { id: "publication", label: "Registrar publicação" },
];
