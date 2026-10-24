interface TimestampPrecision {
  milliseconds: number;
  microseconds: bigint;
}

const precision = new WeakMap<Date, TimestampPrecision>();
const storedTimestamp =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2})(?::?(\d{2}))?)$/;

function invalid(): never {
  throw new TypeError("Invalid stored database timestamp");
}

export function databaseTimestampEpochMicroseconds(value: unknown): bigint {
  if (value instanceof Date) {
    const milliseconds = value.getTime();
    if (
      !Number.isSafeInteger(milliseconds) ||
      value.getUTCFullYear() < 1 ||
      value.getUTCFullYear() > 9999
    )
      return invalid();
    const exact = precision.get(value);
    if (exact && exact.milliseconds !== milliseconds) return invalid();
    return exact?.microseconds ?? BigInt(milliseconds) * 1000n;
  }
  if (typeof value !== "string") return invalid();
  const match = storedTimestamp.exec(value);
  if (!match) return invalid();
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number);
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 15 ||
    offsetMinute > 59
  )
    return invalid();
  // setUTCFullYear avoids the Date constructor's special treatment of years 0–99.
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, 0);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day
  )
    return invalid();
  const offset =
    (offsetHour * 60 + offsetMinute) * 60_000 * (match[9] === "-" ? -1 : 1);
  const milliseconds = local.getTime() - offset;
  const instant = new Date(milliseconds);
  if (instant.getUTCFullYear() < 1 || instant.getUTCFullYear() > 9999)
    return invalid();
  return BigInt(milliseconds) * 1000n + BigInt((match[7] ?? "").padEnd(6, "0"));
}

/** Normalize only stored SQL values. Injected clocks and public inputs keep their own strict guards. */
export function readDatabaseTimestamp(value: unknown): Date {
  const microseconds = databaseTimestampEpochMicroseconds(value);
  const milliseconds = Number(
    microseconds / 1000n -
      (microseconds < 0n && microseconds % 1000n !== 0n ? 1n : 0n),
  );
  const result = new Date(milliseconds);
  precision.set(result, { milliseconds, microseconds });
  return result;
}

/** Compare stored precision before converting to the public contract's millisecond ISO format. */
export function compareDatabaseTimestamps(left: Date, right: Date): -1 | 0 | 1 {
  const leftTime = databaseTimestampEpochMicroseconds(left);
  const rightTime = databaseTimestampEpochMicroseconds(right);
  return leftTime < rightTime ? -1 : leftTime > rightTime ? 1 : 0;
}
