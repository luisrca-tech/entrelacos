export function allowsDevelopmentLocalhost(environment: {
  APP_ENV?: string;
  NODE_ENV?: string;
}): boolean {
  return (
    environment.APP_ENV === "development" &&
    environment.NODE_ENV !== "production"
  );
}

export function isTrustedAdminOrigin(
  candidate: string | null | undefined,
  configuredOrigin: string,
  allowLocalhost: boolean,
): boolean {
  if (candidate === configuredOrigin) return true;
  if (!allowLocalhost || !candidate) return false;
  try {
    const url = new URL(candidate);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname === "localhost" &&
      url.origin === candidate
    );
  } catch {
    return false;
  }
}
