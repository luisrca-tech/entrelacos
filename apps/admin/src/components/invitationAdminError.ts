import { ApiError } from "../lib/apiClient";

export function invitationAdminError(cause: unknown): string {
  if (cause instanceof ApiError) {
    const messages: Record<string, string> = {
      PHONE_CONFLICT:
        "Este telefone já está vinculado a outro convite deste casamento.",
      INVITATION_NOT_FOUND:
        "Este convite não existe mais. Atualize a lista e tente novamente.",
      INVITATION_CONFIRMATION_MISMATCH:
        "A identificação do convite mudou. Recarregue os dados antes de excluir.",
      RSVP_CONFLICT:
        "Outra pessoa alterou uma confirmação. A lista foi atualizada; revise antes de salvar novamente.",
      RSVP_DEADLINE_PASSED: "O prazo de confirmação terminou.",
      SITE_INACTIVE:
        "O casamento está inativo. Os convites podem ser consultados, mas não alterados.",
      VALIDATION_ERROR: "Confira os dados informados e tente novamente.",
    };
    return messages[cause.code] ?? cause.message;
  }
  return cause instanceof Error
    ? cause.message
    : "Não foi possível concluir a operação.";
}
