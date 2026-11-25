/** Entrelaços support on WhatsApp Business, with Brazil country code. */
export const supportWhatsAppNumber = "5562991339861";

export type SupportSite = {
  displayName?: string | null;
  publicUrl?: string | null;
};

function siteHost(publicUrl: string | null | undefined): string | null {
  if (!publicUrl) return null;
  try {
    return new URL(publicUrl).host || null;
  } catch {
    return null;
  }
}

/** Ready-made message so support knows which site the couple is talking about. */
export function supportMessage(site: SupportSite | null): string {
  const name = site?.displayName?.trim();
  if (!name)
    return "Olá! Preciso de ajuda com os recebimentos do meu site no Entrelaços.";
  const host = siteHost(site?.publicUrl);
  const label = host ? `${name} (${host})` : name;
  return `Olá! Sou responsável pelo site ${label} no Entrelaços e preciso de ajuda com os recebimentos.`;
}

// encodeURIComponent keeps spaces as %20, which WhatsApp renders reliably.
export function supportWhatsAppUrl(site: SupportSite | null): string {
  return `https://wa.me/${supportWhatsAppNumber}?text=${encodeURIComponent(supportMessage(site))}`;
}
