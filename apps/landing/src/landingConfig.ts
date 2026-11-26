type Environment = Record<string, string | undefined>;

/**
 * Ready WhatsApp message with no blanks to fill. The ad origin is told in
 * plain words ("pelo Instagram") so support knows where the lead came from
 * without showing the visitor a tracking code.
 */
export function contactMessageFor(ref: string | null): string {
  const origin = ref?.split("-")[0];
  const channel = !ref
    ? "pelo site"
    : origin === "ig" || origin === "instagram"
      ? "pelo Instagram"
      : origin === "fb" || origin === "facebook"
        ? "pelo Facebook"
        : "por um anúncio";
  return `Olá! Conheci o Entrelaços ${channel} e quero saber mais sobre o site para o nosso casamento.`;
}

export const contactMessage = contactMessageFor(null);
// encodeURIComponent keeps spaces as %20, which WhatsApp renders reliably.
export const defaultContactUrl = `https://wa.me/5562991339861?text=${encodeURIComponent(contactMessage)}`;

// Public Instagram profile shown in the footer. Leave empty to hide the link.
export const INSTAGRAM_URL = "https://www.instagram.com/entrelacos.site/";

/** The profile URL when it is a public HTTPS address, otherwise null. */
export function instagramLink(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function destination(
  value: string | undefined,
  key: string,
  production: boolean,
): string {
  try {
    const url = new URL(value ?? "");
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      (production && local) ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && local && !production))
    )
      throw new Error();
    return url.href;
  } catch {
    throw new Error(
      `${key} must be a valid public HTTPS URL (local HTTP is allowed only in development).`,
    );
  }
}

export function landingConfig(env: Environment, production: boolean) {
  const siteUrl = destination(
    env.PUBLIC_SITE_URL ?? (production ? undefined : "http://localhost:4323/"),
    "PUBLIC_SITE_URL",
    production,
  );
  const botanicalUrl = destination(
    env.PUBLIC_BOTANICAL_DEMO_URL ??
      (production ? undefined : "http://localhost:4321/"),
    "PUBLIC_BOTANICAL_DEMO_URL",
    production,
  );
  const lettersUrl = destination(
    env.PUBLIC_LETTERS_DEMO_URL ??
      (production ? undefined : "http://localhost:4322/"),
    "PUBLIC_LETTERS_DEMO_URL",
    production,
  );
  if (botanicalUrl === lettersUrl)
    throw new Error("Template destinations must remain independent.");
  const contactUrl = destination(
    env.PUBLIC_CONTACT_URL || defaultContactUrl,
    "PUBLIC_CONTACT_URL",
    production,
  );
  return { siteUrl, botanicalUrl, lettersUrl, contactUrl };
}
