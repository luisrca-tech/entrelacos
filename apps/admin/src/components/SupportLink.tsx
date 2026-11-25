import { createContext, type ReactNode, useContext } from "react";
import { type SupportSite, supportWhatsAppUrl } from "../lib/supportContact";

const SupportSiteContext = createContext<SupportSite | null>(null);

export function SupportSiteProvider({
  site,
  children,
}: {
  site: SupportSite | null;
  children?: ReactNode;
}) {
  return (
    <SupportSiteContext.Provider value={site}>
      {children}
    </SupportSiteContext.Provider>
  );
}

/** Opens Entrelaços support on WhatsApp with the current site in the message. */
export function SupportLink({
  className,
  children = "Falar com o suporte do EntreLaços",
}: {
  className?: string;
  children?: ReactNode;
}) {
  const site = useContext(SupportSiteContext);
  return (
    <a
      href={supportWhatsAppUrl(site)}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      {children}
    </a>
  );
}
