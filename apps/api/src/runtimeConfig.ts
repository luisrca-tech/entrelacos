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

function databaseTarget(
  env: Record<string, string | undefined>,
): DatabaseTarget {
  const explicit = env.APP_ENV?.trim();
  if (
    explicit === "development" ||
    explicit === "test" ||
    explicit === "production"
  ) {
    return explicit;
  }
  const railwayEnvironment = env.RAILWAY_ENVIRONMENT_NAME?.trim();
  if (
    !explicit &&
    (railwayEnvironment === "development" ||
      railwayEnvironment === "production")
  ) {
    return railwayEnvironment;
  }
  throw new Error(
    "APP_ENV must select development, test, or production outside recognized Railway environments",
  );
}

function betterAuthOrigin(env: Record<string, string | undefined>): string {
  const configured = env.BETTER_AUTH_URL?.trim();
  const railwayDomain = env.RAILWAY_PUBLIC_DOMAIN?.trim();
  return origin(
    configured || (railwayDomain ? `https://${railwayDomain}` : undefined),
    "BETTER_AUTH_URL",
  );
}

export function readRuntimeConfig(env: Record<string, string | undefined>) {
  const target = databaseTarget(env);
  const port = Number(env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  const secret = env.BETTER_AUTH_SECRET ?? "";
  if (secret.trim().length < 32)
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  const fingerprintSecret = (env.GUEST_FINGERPRINT_SECRET ?? secret).trim();
  if (fingerprintSecret.length < 32) {
    throw new Error(
      "GUEST_FINGERPRINT_SECRET must contain at least 32 characters",
    );
  }
  const trustProxyHeaders =
    (
      env.TRUST_PROXY_HEADERS ??
      (env.RAILWAY_ENVIRONMENT_NAME?.trim() ? "true" : "false")
    )
      .trim()
      .toLowerCase() === "true";
  return {
    target,
    port,
    secret,
    baseURL: betterAuthOrigin(env),
    adminOrigin: origin(env.ADMIN_ORIGIN, "ADMIN_ORIGIN"),
    fingerprintSecret,
    trustProxyHeaders,
  };
}
