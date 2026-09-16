export function readAccessTokenFromHash(hash: string): string {
  return (
    new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash).get(
      "token",
    ) ?? ""
  );
}

export function hasValidAccessToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}
