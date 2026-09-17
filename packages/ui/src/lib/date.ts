/** A calendar date serialized without a timezone component. */
export type DateOnly = `${number}-${number}-${number}`;

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDateOnly(value: string | undefined): Date | undefined {
  if (!value) return undefined;

  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  // Noon avoids historical local-time transitions that skipped midnight.
  date.setHours(12, 0, 0, 0);
  date.setFullYear(year, month - 1, day);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return undefined;
  }

  return date;
}

export function formatDateOnly(date: Date): string | undefined {
  if (Number.isNaN(date.getTime())) return undefined;

  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
