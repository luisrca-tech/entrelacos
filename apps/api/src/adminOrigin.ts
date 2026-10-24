import {
  allowsDevelopmentLocalhost,
  isTrustedAdminOrigin,
} from "@entrelacos/contracts";

export function trustedAdminOrigin(
  candidate: string | null | undefined,
  configuredOrigin: string,
): boolean {
  return isTrustedAdminOrigin(
    candidate,
    configuredOrigin,
    allowsDevelopmentLocalhost(process.env),
  );
}

export function trustedAdminOrigins(configuredOrigin: string): string[] {
  return allowsDevelopmentLocalhost(process.env)
    ? [
        configuredOrigin,
        "http://localhost:*",
        "https://localhost:*",
        "http://localhost",
        "https://localhost",
      ]
    : [configuredOrigin];
}

export function hasTrustedAdminOrigins(
  actual: unknown,
  configuredOrigin: string,
): boolean {
  const expected = trustedAdminOrigins(configuredOrigin);
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((origin, index) => actual[index] === origin)
  );
}
