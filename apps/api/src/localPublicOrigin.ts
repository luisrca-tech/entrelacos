const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hostnameOf(value: string): string | undefined {
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

export function allowsLocalPublicOrigin(
  apiRequestUrl: string,
  publicOrigin?: string,
): boolean {
  if (!publicOrigin) return false;
  const apiHost = hostnameOf(apiRequestUrl);
  const originHost = hostnameOf(publicOrigin);
  return Boolean(
    apiHost &&
      originHost &&
      LOOPBACK_HOSTS.has(apiHost) &&
      LOOPBACK_HOSTS.has(originHost),
  );
}
