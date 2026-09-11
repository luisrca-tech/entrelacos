import type { DatabaseTarget } from "@entrelacos/database";

function origin(value: string | undefined, name: string): string {
  try {
    const url = new URL(value ?? "");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error(`${name} must be an HTTP(S) origin`);
  }
}

export function readRuntimeConfig(env: Record<string, string | undefined>) {
  if (env.APP_ENV !== "development" && env.APP_ENV !== "test") {
    throw new Error(
      "APP_ENV must explicitly select development or test; production is not configured",
    );
  }
  const target: DatabaseTarget = env.APP_ENV;
  const port = Number(env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  const secret = env.BETTER_AUTH_SECRET ?? "";
  if (secret.trim().length < 32)
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  return {
    target,
    port,
    secret,
    baseURL: origin(env.BETTER_AUTH_URL, "BETTER_AUTH_URL"),
    adminOrigin: origin(env.ADMIN_ORIGIN, "ADMIN_ORIGIN"),
  };
}
