import { useCallback, useEffect, useState } from "react";

export type AsaasTasks = { password: boolean; phone: boolean };
type TaskStorage = Pick<Storage, "getItem" | "setItem">;

const emptyTasks: AsaasTasks = { password: false, phone: false };

export function asaasTasksKey(siteId: string, holderId: string) {
  return `entrelacos:asaas-tasks:${siteId}:${holderId}`;
}

// The couple marks these tasks themselves: the panel cannot see them in Asaas.
export function readAsaasTasks(
  storage: TaskStorage | null,
  key: string,
): AsaasTasks {
  try {
    const value = JSON.parse(storage?.getItem(key) ?? "null") as unknown;
    if (
      value &&
      typeof value === "object" &&
      typeof (value as AsaasTasks).password === "boolean" &&
      typeof (value as AsaasTasks).phone === "boolean"
    )
      return {
        password: (value as AsaasTasks).password,
        phone: (value as AsaasTasks).phone,
      };
  } catch {}
  return { ...emptyTasks };
}

export function writeAsaasTasks(
  storage: TaskStorage | null,
  key: string,
  tasks: AsaasTasks,
) {
  try {
    storage?.setItem(key, JSON.stringify(tasks));
  } catch {}
}

export function documentsTaskStatus(
  documentation:
    | "PENDING"
    | "AWAITING_APPROVAL"
    | "APPROVED"
    | "REJECTED"
    | undefined,
) {
  return documentation === "APPROVED"
    ? "done"
    : documentation === "AWAITING_APPROVAL"
      ? "review"
      : documentation === "REJECTED"
        ? "attention"
        : "waiting";
}

function browserStorage(): TaskStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function useAsaasTasks(key: string) {
  const [tasks, setTasks] = useState<AsaasTasks>(emptyTasks);
  useEffect(() => {
    setTasks(readAsaasTasks(browserStorage(), key));
  }, [key]);
  const toggle = useCallback(
    (task: keyof AsaasTasks, value: boolean) =>
      setTasks((current) => {
        const next = { ...current, [task]: value };
        writeAsaasTasks(browserStorage(), key, next);
        return next;
      }),
    [key],
  );
  return [tasks, toggle] as const;
}
