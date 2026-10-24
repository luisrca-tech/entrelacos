import { types } from "node:util";

const allowedFiles = new Set([
  "withdrawalReservations.ts",
  "withdrawalReservationRepository.ts",
  "withdrawalPostingRepository.ts",
  "withdrawalExecution.ts",
  "withdrawalComposition.ts",
  "receivingReadiness.ts",
  "receivingRepository.ts",
  "asaasHttpClient.ts",
  "asaasStoredAccountReader.ts",
  "asaasTransferClient.ts",
  "asaasWithdrawalCustody.ts",
  "databaseTimestamp.ts",
  "financialAuthorization.ts",
  "financeHttp.ts",
]);

const allowedDatabaseCodes = new Set([
  "23514",
  "23503",
  "23505",
  "25006",
  "42501",
]);
const allowedCustodyConstraints = new Set([
  "withdrawal_provider_observation_pkey",
  "withdrawal_observation_operation_fk",
  "withdrawal_observation_hash_check",
  "withdrawal_observation_payload_check",
  "withdrawal_observation_time_check",
  "withdrawal_observation_provider_check",
]);
function classifyDatabaseFailure(
  error: unknown,
): { code: string; constraint?: string } | undefined {
  let current = error;
  const seen = new Set<object>();
  for (let depth = 0; depth < 3; depth++) {
    if (
      !current ||
      typeof current !== "object" ||
      types.isProxy(current) ||
      seen.has(current)
    )
      return;
    seen.add(current);
    const ownData = (key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      return descriptor && Object.hasOwn(descriptor, "value")
        ? descriptor.value
        : undefined;
    };
    const code = ownData("code");
    if (typeof code === "string" && allowedDatabaseCodes.has(code)) {
      const constraint = ownData("constraint");
      return {
        code,
        ...(typeof constraint === "string" &&
        allowedCustodyConstraints.has(constraint)
          ? { constraint }
          : {}),
      };
    }
    current = ownData("cause");
  }
}

export function logWithdrawalFailure(error: unknown): void {
  if (process.env.APP_ENV !== "development") return;
  try {
    if (types.isProxy(error) || !(error instanceof Error)) return;
    const stack = error.stack;
    if (typeof stack !== "string" || stack.length > 32768) return;
    const frames: Array<{ file: string; line: number; column: number }> = [];
    for (const source of stack.split("\n").slice(1)) {
      const match = source.match(
        /^\s+at (?:[^()\n]* \()?[^()\n]*\/apps\/api\/src\/([^/:()\s]+):([1-9]\d*):([1-9]\d*)\)?$/,
      );
      if (!match || !allowedFiles.has(match[1])) continue;
      const line = Number(match[2]);
      const column = Number(match[3]);
      if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column))
        continue;
      frames.push({ file: match[1], line, column });
      if (frames.length === 4) break;
    }
    if (frames.length) {
      const databaseFailure = classifyDatabaseFailure(error);
      const payload = JSON.stringify({
        event: "withdrawal_failure",
        frames,
        ...(databaseFailure ? { databaseFailure } : {}),
      });
      console.error(payload);
    }
  } catch {
    // Diagnostics must never change authorization or error handling.
  }
}
