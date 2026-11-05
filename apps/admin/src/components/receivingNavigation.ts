import { createContext } from "react";

export const receivingPages = [
  { id: "overview", label: "Visão geral" },
  { id: "holder", label: "Quem recebe" },
  { id: "details", label: "Seus dados" },
  { id: "activation", label: "Ativar no Asaas" },
  { id: "account", label: "Conta para saque" },
  { id: "fees", label: "Taxas e presentes" },
  { id: "payments", label: "Pagamentos" },
  { id: "withdrawals", label: "Saques" },
  { id: "settings", label: "Configurações" },
] as const;
export type ReceivingPage = (typeof receivingPages)[number]["id"];
export const ReceivingPageContext = createContext<ReceivingPage>("overview");

export const readyReceivingPages = [
  "overview",
  "payments",
  "withdrawals",
  "settings",
] as const satisfies readonly ReceivingPage[];
export type ReadyReceivingPage = (typeof readyReceivingPages)[number];
export function isReadyReceivingPage(
  page: ReceivingPage,
): page is ReadyReceivingPage {
  return (readyReceivingPages as readonly string[]).includes(page);
}

// Payments, withdrawals and settings only make sense once receiving is ready.
export function receivingTabs(ready: boolean) {
  return ready
    ? receivingPages.filter(({ id }) =>
        (readyReceivingPages as readonly string[]).includes(id),
      )
    : [];
}

export function resolveReceivingPage(value: string | undefined): ReceivingPage {
  return receivingPages.find((page) => page.id === value)?.id ?? "overview";
}
export function receivingPageHref(siteId: string, page: ReceivingPage): string {
  const base = `/sites/${encodeURIComponent(siteId)}/receiving`;
  return page === "overview" ? base : `${base}/${page}`;
}
