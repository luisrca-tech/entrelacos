import { randomUUID } from "node:crypto";
import type { DatabaseConnection } from "@entrelacos/database";
import {
  financialOperatorAlert,
  type financialOperatorAlertKinds,
} from "@entrelacos/database/schema";
import { sql } from "drizzle-orm";

export type FinancialOperatorAlertKind =
  (typeof financialOperatorAlertKinds)[number];

export interface FinancialOperatorAlertInput {
  kind: FinancialOperatorAlertKind;
  severity: "warning" | "critical";
  environment: "sandbox" | "live";
  /** Always set: the open-alert dedupe key is (environment, kind, reference). */
  paymentReference: string;
  siteId?: string | null;
  accountId?: string | null;
  checkoutAttemptId?: string | null;
  details?: Record<string, string | number | boolean | null>;
}

type AlertExecutor = Pick<DatabaseConnection["db"], "execute">;

function reference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 256 &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

function optional(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (!reference(value)) throw new Error("Invalid alert reference");
  return value;
}

/**
 * Opens an operator alert unless the same (environment, kind, payment) alert is
 * already open. Runs on the caller's executor so it commits with the effect
 * that observed it. Returns true only when a new alert row was written.
 */
export async function insertFinancialOperatorAlert(
  executor: AlertExecutor,
  input: FinancialOperatorAlertInput,
  id: string = randomUUID(),
): Promise<boolean> {
  if (
    !reference(input.paymentReference) ||
    !reference(id) ||
    (input.environment !== "sandbox" && input.environment !== "live") ||
    (input.severity !== "warning" && input.severity !== "critical")
  )
    throw new Error("Invalid operator alert");
  const details = JSON.stringify(input.details ?? {});
  const result =
    await executor.execute(sql`INSERT INTO ${financialOperatorAlert} (id, kind, severity, environment, site_id, account_id,
    payment_reference, checkout_attempt_id, details)
    VALUES (${id}, ${input.kind}, ${input.severity}, ${input.environment}, ${optional(input.siteId)}, ${optional(input.accountId)},
      ${input.paymentReference}, ${optional(input.checkoutAttemptId)}, ${details}::jsonb)
    ON CONFLICT (environment, kind, payment_reference) WHERE resolved_at IS NULL DO NOTHING RETURNING id`);
  return result.rows.length === 1;
}

/** Closes the open alert, if any. Returns true when one was resolved. */
export async function resolveFinancialOperatorAlert(
  executor: AlertExecutor,
  input: {
    environment: "sandbox" | "live";
    kind: FinancialOperatorAlertKind;
    paymentReference: string;
    note: string;
  },
): Promise<boolean> {
  if (!reference(input.paymentReference) || !input.note.trim())
    throw new Error("Invalid operator alert resolution");
  const result =
    await executor.execute(sql`UPDATE ${financialOperatorAlert} SET resolved_at = GREATEST(clock_timestamp(), created_at),
    resolved_note = ${input.note.trim()}
    WHERE environment = ${input.environment} AND kind = ${input.kind}
      AND payment_reference = ${input.paymentReference} AND resolved_at IS NULL RETURNING id`);
  return result.rows.length === 1;
}
