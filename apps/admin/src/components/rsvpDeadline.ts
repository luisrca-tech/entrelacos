type DateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

const localDateTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function formatter(timeZone: string) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new Error("Invalid IANA timezone");
  }
}

function partsAt(instant: Date, timeZone: string): DateTimeParts {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(instant)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, Number(value)]),
  );

  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
  };
}

function parseLocalDateTime(value: string): DateTimeParts {
  const match = localDateTimePattern.exec(value);
  if (!match) {
    throw new Error("Invalid local date and time");
  }

  const [, year, month, day, hour, minute] = match;
  const parsed = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
  };
  const roundTrip = new Date(
    Date.UTC(
      parsed.year,
      parsed.month - 1,
      parsed.day,
      parsed.hour,
      parsed.minute,
    ),
  );

  if (
    roundTrip.getUTCFullYear() !== parsed.year ||
    roundTrip.getUTCMonth() + 1 !== parsed.month ||
    roundTrip.getUTCDate() !== parsed.day ||
    roundTrip.getUTCHours() !== parsed.hour ||
    roundTrip.getUTCMinutes() !== parsed.minute
  ) {
    throw new Error("Invalid local date and time");
  }

  return parsed;
}

function asUtcMilliseconds(parts: DateTimeParts) {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
  );
}

export function deadlineInstantFromLocal(
  localDateTime: string,
  timeZone: string,
) {
  const desired = parseLocalDateTime(localDateTime);
  formatter(timeZone);

  const desiredUtc = asUtcMilliseconds(desired);
  let candidate = desiredUtc;

  // Re-evaluate once after applying the zone offset so DST transitions settle.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const displayed = partsAt(new Date(candidate), timeZone);
    candidate += desiredUtc - asUtcMilliseconds(displayed);
  }

  const instant = new Date(candidate);
  const displayed = partsAt(instant, timeZone);
  if (asUtcMilliseconds(displayed) !== desiredUtc) {
    throw new Error("The selected local time does not exist in this timezone");
  }

  return instant.toISOString();
}

export function deadlineLocalFromInstant(instant: string, timeZone: string) {
  const parsed = new Date(instant);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid deadline instant");
  }

  const value = partsAt(parsed, timeZone);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.year}-${pad(value.month)}-${pad(value.day)}T${pad(value.hour)}:${pad(value.minute)}`;
}
