import { parseDateOnly } from "@entrelacos/ui";

export function formatBrazilianDate(value: string): string {
  const date = parseDateOnly(value);
  if (!date) return value;

  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear()).padStart(4, "0");
  return `${day}-${month}-${year}`;
}
