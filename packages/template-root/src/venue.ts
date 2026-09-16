export type ClipboardWriter = {
  writeText(value: string): Promise<void>;
};

export async function copyAddress(
  address: string,
  clipboard: ClipboardWriter | undefined,
): Promise<boolean> {
  if (!address.trim() || !clipboard) return false;
  try {
    await clipboard.writeText(address);
    return true;
  } catch {
    return false;
  }
}
