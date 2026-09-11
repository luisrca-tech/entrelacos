export async function createRecognitionChallenge() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return {
    verifier,
    challenge: Array.from(digest, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
  };
}
export function panelHandoffUrl(
  panelOrigin: string,
  siteId: string,
  origin: string,
  challenge: string,
) {
  const url = new URL(panelOrigin);
  if (
    url.origin !== panelOrigin ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error("Invalid panel origin");
  url.pathname = "/handoff";
  url.search = new URLSearchParams({ siteId, origin, challenge }).toString();
  return url.href;
}
