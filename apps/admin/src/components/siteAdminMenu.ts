export type AdminAccessPurpose = "ACTIVATION" | "RECOVERY";

export function adminAccessLink(
  origin: string,
  token: string,
  purpose: AdminAccessPurpose,
): string {
  return `${origin}/${purpose === "ACTIVATION" ? "activate" : "recover"}#token=${token}`;
}

export async function copyAdminAccessLink(
  link: string,
  clipboard: Pick<Clipboard, "writeText">,
): Promise<boolean> {
  try {
    await clipboard.writeText(link);
    return true;
  } catch {
    return false;
  }
}

export const adminAccessLinkCopyFailedMessage =
  "Não foi possível copiar o link. Tente novamente.";
