export function showcaseBuildEnvironment(
  app: string,
  environment: string,
): Record<string, string> {
  if (
    !["botanical", "letters", "landing"].includes(app) ||
    !["development", "production"].includes(environment)
  ) {
    throw new Error("An explicit supported app and environment are required");
  }
  const suffix = environment === "development" ? "-dev" : "";
  const botanical = `https://demo-botanico${suffix}.entrelacos.workers.dev/`;
  const letters = `https://demo-cartas${suffix}.entrelacos.workers.dev/`;
  return {
    APP_ENV: environment,
    PUBLIC_SITE_INACTIVE: "false",
    PUBLIC_API_URL: `https://entrelacosapi-${environment}.up.railway.app`,
    PUBLIC_ADMIN_ORIGIN: `https://admin${suffix}.entrelacos.workers.dev`,
    PUBLIC_SITE_ID: app === "letters" ? "demo-wedding-cartas" : "demo-wedding",
    // This public opt-in authorizes only the existing Botanical production tenant.
    // Backend receiving readiness and all checkout guards remain authoritative.
    PUBLIC_LIVE_DEMO_SITE_ID:
      app === "botanical" && environment === "production" ? "demo-wedding" : "",
    PUBLIC_SITE_URL:
      app === "landing"
        ? `https://entrelacos${suffix}.entrelacos.workers.dev/`
        : app === "letters"
          ? letters
          : botanical,
    PUBLIC_BOTANICAL_DEMO_URL: botanical,
    PUBLIC_LETTERS_DEMO_URL: letters,
  };
}
