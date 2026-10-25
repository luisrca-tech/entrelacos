import type { WithdrawalIntent } from "@entrelacos/contracts";

export function withdrawalAmountRows(
  value: Pick<
    WithdrawalIntent,
    "amountCents" | "feeCents" | "netCents" | "feeSemantics" | "settlement"
  >,
): [string, number][] {
  const fee = value.settlement?.feeCents ?? value.feeCents;
  const net = value.settlement?.netCents ?? value.netCents;
  if (fee === 0) return [["Valor do saque", net]];
  return [
    [
      value.settlement
        ? "Valor debitado"
        : value.feeSemantics !== undefined
          ? "Débito máximo aprovado"
          : "Valor solicitado",
      value.settlement?.totalDebitCents ?? value.amountCents,
    ],
    [
      value.settlement
        ? "Taxa efetiva"
        : value.feeSemantics !== undefined
          ? "Taxa máxima"
          : "Taxa",
      fee,
    ],
    [
      value.feeSemantics === "MAXIMUM_WITH_MINIMUM_NET" && !value.settlement
        ? "Líquido mínimo"
        : "Valor líquido",
      net,
    ],
  ];
}
