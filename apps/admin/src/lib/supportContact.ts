/** Entrelaços support on WhatsApp Business, with Brazil country code. */
export const supportWhatsAppNumber = "5562991339861";

export type SupportSite = {
  displayName?: string | null;
  publicUrl?: string | null;
  lifecycle?: string | null;
};

/** What the couple needs help with; receiving is the money-related path. */
export type SupportTopic = "receiving" | "general";

const topicMessages: Record<
  SupportTopic,
  { withSite: (label: string) => string; withoutSite: string }
> = {
  receiving: {
    withSite: (label) =>
      `Olá! Sou responsável pelo site ${label} no Entrelaços e preciso de ajuda com os recebimentos.`,
    withoutSite:
      "Olá! Preciso de ajuda com os recebimentos do meu site no Entrelaços.",
  },
  general: {
    withSite: (label) =>
      `Olá! Sou responsável pelo site ${label} no Entrelaços e tenho uma dúvida.`,
    withoutSite: "Olá! Tenho uma dúvida sobre o painel do Entrelaços.",
  },
};

/** The public host only while the site is live; a draft address does not open. */
function liveSiteHost(site: SupportSite): string | null {
  if (site.lifecycle !== "ACTIVE" || !site.publicUrl) return null;
  try {
    return new URL(site.publicUrl).host || null;
  } catch {
    return null;
  }
}

/** Ready-made message so support knows which site the couple is talking about. */
export function supportMessage(
  site: SupportSite | null,
  topic: SupportTopic = "receiving",
): string {
  const messages = topicMessages[topic];
  const name = site?.displayName?.trim();
  if (!site || !name) return messages.withoutSite;
  const host = liveSiteHost(site);
  return messages.withSite(host ? `${name} (${host})` : name);
}

// encodeURIComponent keeps spaces as %20, which WhatsApp renders reliably.
export function supportWhatsAppUrl(
  site: SupportSite | null,
  topic: SupportTopic = "receiving",
): string {
  return `https://wa.me/${supportWhatsAppNumber}?text=${encodeURIComponent(supportMessage(site, topic))}`;
}
