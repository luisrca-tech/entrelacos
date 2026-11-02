type Environment = Record<string, string | undefined>;

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
  const contactUrl = env.PUBLIC_CONTACT_URL
    ? destination(env.PUBLIC_CONTACT_URL, "PUBLIC_CONTACT_URL", production)
    : null;
  return { siteUrl, botanicalUrl, lettersUrl, contactUrl };
}
