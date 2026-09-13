export type FocusTarget = {
  focus: () => void;
  isConnected?: boolean;
};

export function captureFocus(value: unknown): FocusTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const focus = (value as { focus?: unknown }).focus;
  return typeof focus === "function" ? (value as FocusTarget) : null;
}

export function restoreFocus(target: FocusTarget | null): void {
  if (target && target.isConnected !== false) target.focus();
}
