import { publicUrlSchema } from "@entrelacos/contracts";

export const LOCAL_PUBLIC_SITE_URL = "http://localhost:4321/";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLocalPanelOrigin(origin: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export function publicSiteHandoffUrl(
  publicUrl: string,
  panelOrigin = "",
): string {
  const source = isLocalPanelOrigin(panelOrigin)
    ? LOCAL_PUBLIC_SITE_URL
    : publicUrl;
  const safePublicUrl = publicUrlSchema.parse(source);
  const url = new URL(safePublicUrl);
  url.hash = "panel";
  return url.href;
}

export function subscribeToPanelOrigin() {
  return () => undefined;
}
