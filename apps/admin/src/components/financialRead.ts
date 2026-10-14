import type { SiteAccess } from "@entrelacos/contracts";
import { ApiError } from "../lib/apiClient";

export type FinancialReadResult<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "unavailable" }
  | { status: "error" };

export type ScopedFinancialRead<T> = {
  siteId: string;
  access: SiteAccess | null;
  revision: number;
  result: FinancialReadResult<T>;
};

export function observeFinancialRead<T>(
  read: () => Promise<T>,
  onResult: (result: FinancialReadResult<T>) => void,
): () => void {
  let active = true;
  onResult({ status: "loading" });
  void (async () => {
    try {
      const value = await read();
      if (active) onResult({ status: "ready", value });
    } catch (error) {
      if (active)
        onResult({
          status:
            error instanceof ApiError &&
            error.status === 409 &&
            error.code === "PROVIDER_MODE_UNAVAILABLE"
              ? "unavailable"
              : "error",
        });
    }
  })();
  return () => {
    active = false;
  };
}

export function currentFinancialRead<T>(
  read: ScopedFinancialRead<T> | null,
  siteId: string,
  access: SiteAccess | null,
  revision: number,
): FinancialReadResult<T> | null {
  return read?.siteId === siteId &&
    read.access === access &&
    read.revision === revision
    ? read.result
    : null;
}
