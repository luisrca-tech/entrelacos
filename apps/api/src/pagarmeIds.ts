/**
 * Pagar.me recipient identifiers. The reference documents `rp_`, the create
 * example answers `re_`, and recipients created after the 2026-07-14 API
 * change may only carry a `pp_` payment profile id
 * (https://docs.pagar.me/docs/liquida%C3%A7%C3%A3o-transfer%C3%AAncias-e-recebedores.md).
 * Every recipient check in the API uses this one pattern.
 */
export const pagarmeRecipientIdPattern = /^(?:rp|re|pp)_[A-Za-z0-9]{1,128}$/;

export function isPagarmeRecipientId(value: unknown): value is string {
  return typeof value === "string" && pagarmeRecipientIdPattern.test(value);
}

/**
 * Transfer ids are integers in the Transfers reference
 * (https://docs.pagar.me/reference/objeto-transfer%C3%AAncia.md) and are kept
 * as decimal strings. `with_` ids come from the deprecated withdrawals
 * route and stay readable for rows recorded before the move. `tran_` ids are
 * charge transactions (`last_transaction.id` of an order), never transfers,
 * so they are refused.
 */
export const pagarmeTransferIdPattern =
  /^(?:[1-9][0-9]{0,18}|with_[A-Za-z0-9]{1,128})$/;
export const pagarmeLegacyWithdrawalIdPattern = /^with_[A-Za-z0-9]{1,128}$/;
