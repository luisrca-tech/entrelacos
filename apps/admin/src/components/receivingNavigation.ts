import { createContext } from "react";

export const receivingPages = [
  { id: "overview", label: "Visão geral" },
  { id: "activation", label: "Ativação" },
  { id: "account", label: "Conta para saque" },
  { id: "payments", label: "Pagamentos" },
  { id: "withdrawals", label: "Saques" },
] as const;
export type ReceivingPage = (typeof receivingPages)[number]["id"];
export const ReceivingPageContext = createContext<ReceivingPage>("overview");

export function resolveReceivingPage(value: string | undefined): ReceivingPage {
  return receivingPages.find((page) => page.id === value)?.id ?? "overview";
}
export function receivingPageHref(siteId: string, page: ReceivingPage): string {
  const base = `/sites/${encodeURIComponent(siteId)}/receiving`;
  return page === "overview" ? base : `${base}/${page}`;
}
