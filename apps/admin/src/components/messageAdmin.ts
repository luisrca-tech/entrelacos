import type { SiteMessageRecord } from "@entrelacos/contracts";
import { ApiError } from "../lib/apiClient";

export function mergeSiteMessages(
  current: SiteMessageRecord[],
  incoming: SiteMessageRecord[],
  append: boolean,
): SiteMessageRecord[] {
  if (!append) return incoming;
  const ids = new Set(current.map(({ id }) => id));
  return [...current, ...incoming.filter(({ id }) => !ids.has(id))];
}

export function messageAdminError(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return "Não foi possível atualizar a moderação. Tente novamente.";
  }
  if (error.code === "MESSAGE_NOT_FOUND") {
    return "A mensagem não existe mais. Os dados foram recarregados.";
  }
  if (error.code === "SITE_INACTIVE") {
    return "Alterações não estão disponíveis enquanto o site estiver inativo.";
  }
  return error.message;
}
