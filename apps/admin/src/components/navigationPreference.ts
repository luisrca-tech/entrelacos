import { useSyncExternalStore } from "react";

// Every route renders its own Panel, so the shell remounts on navigation and
// component state would reset. The desktop sidebar preference therefore lives
// in a module store, mirrored to localStorage for later visits.
const storageKey = "entrelacos.admin.navigation";
const listeners = new Set<() => void>();
let expanded: boolean | null = null;

function readStored() {
  try {
    return window.localStorage.getItem(storageKey) !== "collapsed";
  } catch {
    return true;
  }
}

function getSnapshot() {
  if (expanded === null) expanded = readStored();
  return expanded;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setNavigationExpanded(next: boolean) {
  expanded = next;
  try {
    window.localStorage.setItem(storageKey, next ? "expanded" : "collapsed");
  } catch {
    // Storage may be blocked; the preference still holds for this session.
  }
  for (const listener of listeners) listener();
}

/**
 * Returns whether the desktop sidebar is expanded. The server render and the
 * hydration pass use the expanded default, so markup always matches; the
 * stored preference applies right after hydration.
 */
export function useNavigationExpanded() {
  return useSyncExternalStore(subscribe, getSnapshot, () => true);
}
