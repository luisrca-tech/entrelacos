import { parseDateOnly } from "@entrelacos/ui";

const weekdays = [
  "Domingo",
  "Segunda-feira",
  "Terça-feira",
  "Quarta-feira",
  "Quinta-feira",
  "Sexta-feira",
  "Sábado",
];
const months = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

export function formatBrazilianDate(value: string): string {
  const date = parseDateOnly(value);
  if (!date) return value;

  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear()).padStart(4, "0");
  return `${day}/${month}/${year}`;
}

/** Spelled-out date, e.g. "Domingo, 14 de março de 2027". */
export function formatBrazilianLongDate(
  value: string,
  { weekday = true }: { weekday?: boolean } = {},
): string {
  const date = parseDateOnly(value);
  if (!date) return value;

  const text = `${date.getDate()} de ${months[date.getMonth()]} de ${date.getFullYear()}`;
  return weekday ? `${weekdays[date.getDay()]}, ${text}` : text;
}

/** Weekday name, e.g. "Domingo". */
export function formatBrazilianWeekday(value: string): string {
  const date = parseDateOnly(value);
  return date ? weekdays[date.getDay()] : value;
}
