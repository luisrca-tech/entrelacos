import { describe, expect, it } from "vitest";
import {
  compareDatabaseTimestamps,
  databaseTimestampEpochMicroseconds,
  readDatabaseTimestamp,
} from "./databaseTimestamp";

describe("stored PostgreSQL timestamp normalization", () => {
  it.each([
    "2026-10-12 17:00:00+00",
    "2026-10-12 14:00:00-03",
    "2026-10-12 18:30:00+0130",
    "2026-10-12T14:00:00.000-03:00",
    "2026-10-12T17:00:00Z",
  ])("normalizes the explicit instant %s", (value) => {
    expect(readDatabaseTimestamp(value).toISOString()).toBe(
      "2026-10-12T17:00:00.000Z",
    );
  });

  it("copies native Dates without changing their instant", () => {
    const value = new Date("2026-10-12T17:00:00.123Z");
    const result = readDatabaseTimestamp(value);
    expect(result).not.toBe(value);
    value.setTime(0);
    expect(result.toISOString()).toBe("2026-10-12T17:00:00.123Z");
  });

  it("retains all PostgreSQL microseconds for ordering and fences", () => {
    const value = readDatabaseTimestamp("2026-10-12 17:00:00.123456+00");
    const later = readDatabaseTimestamp("2026-10-12 17:00:00.123457+00");
    expect(value.toISOString()).toBe("2026-10-12T17:00:00.123Z");
    expect(databaseTimestampEpochMicroseconds(value)).toBe(
      BigInt(Date.parse("2026-10-12T17:00:00.123Z")) * 1000n + 456n,
    );
    expect(compareDatabaseTimestamps(value, later)).toBe(-1);
    expect(compareDatabaseTimestamps(later, value)).toBe(1);
    expect(compareDatabaseTimestamps(value, readDatabaseTimestamp(value))).toBe(
      0,
    );
  });

  it("handles pre-epoch fractions and explicit leap-day offsets exactly", () => {
    const value = readDatabaseTimestamp("1969-12-31 23:59:59.999999+00");
    expect(value.toISOString()).toBe("1969-12-31T23:59:59.999Z");
    expect(databaseTimestampEpochMicroseconds(value)).toBe(-1n);
    expect(readDatabaseTimestamp("2024-02-29 23:30:00-01").toISOString()).toBe(
      "2024-03-01T00:30:00.000Z",
    );
  });

  it.each([
    undefined,
    null,
    0,
    {},
    new Date(Number.NaN),
    "2026-10-12",
    "2026-10-12 17:00:00",
    "2026-10-12T17:00:00",
    "2026-02-29 17:00:00+00",
    "2024-02-30 17:00:00+00",
    "2026-04-31 17:00:00+00",
    "2026-13-12 17:00:00+00",
    "2026-10-12 24:00:00+00",
    "2026-10-12 17:60:00+00",
    "2026-10-12 17:00:60+00",
    "2026-10-12 17:00:00+16",
    "2026-10-12 17:00:00+00:60",
    "2026-10-12 17:00:00.1234567+00",
    "0000-01-01 00:00:00+00",
    "10000-01-01 00:00:00+00",
    "infinity",
    "-infinity",
    "2026-10-12 17:00:00 UTC",
    " 2026-10-12 17:00:00+00",
    "2026-10-12 17:00:00+00 ",
    "2026-10-12T17:00:00Z password=private",
  ])("rejects invalid, ambiguous or unsupported stored values: %s", (value) => {
    expect(() => readDatabaseTimestamp(value)).toThrow(
      "Invalid stored database timestamp",
    );
  });

  it("rejects mutation of a normalized timestamp instead of reusing stale precision", () => {
    const value = readDatabaseTimestamp("2026-10-12 17:00:00.123456+00");
    value.setTime(value.getTime() + 1);
    expect(() => databaseTimestampEpochMicroseconds(value)).toThrow(
      "Invalid stored database timestamp",
    );
  });
});
