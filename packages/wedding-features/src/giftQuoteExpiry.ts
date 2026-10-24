const maximumTimeoutMs = 2_147_483_647;

export function scheduleGiftQuoteExpiry(
  expiresAt: string,
  onExpired: () => void,
): () => void {
  const deadline = Date.parse(expiresAt);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  const check = () => {
    if (!active) return;
    const remaining = deadline - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      active = false;
      onExpired();
      return;
    }
    timer = setTimeout(check, Math.min(remaining, maximumTimeoutMs));
  };
  check();
  return () => {
    active = false;
    if (timer !== undefined) clearTimeout(timer);
  };
}
