import { z } from "zod";

/**
 * `default_bank_account.holder_name` length. The POST /recipients docs
 * (https://docs.pagar.me/reference/criar-recebedor-1) state no number; the
 * limit comes from Pagar.me's own 422: "Bank account holder name must be
 * lower than 30 characters". 29 is the strict reading of "lower than"
 * (whether exactly 30 passes was never probed against Pagar.me).
 */
export const RECEIVING_HOLDER_NAME_MAX_LENGTH = 29;
const RECEIVING_HOLDER_NAME_MIN_LENGTH = 2;

/** Trim, collapse spaces, curly apostrophe to ', pt-BR uppercase. */
export function normalizeReceivingHolderName(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleUpperCase("pt-BR");
}

/** Letters (accented included), single spaces, apostrophe and hyphen. */
const holderNamePattern = /^\p{L}[\p{L}'-]*(?: [\p{L}'-]+)*$/u;

export const receivingHolderNameSchema = z
  .string()
  .transform(normalizeReceivingHolderName)
  .pipe(
    z
      .string()
      .min(RECEIVING_HOLDER_NAME_MIN_LENGTH)
      .max(RECEIVING_HOLDER_NAME_MAX_LENGTH)
      .regex(holderNamePattern),
  );

const particles = new Set(["DA", "DE", "DO", "DOS", "DAS", "E"]);
const fits = (words: readonly string[]) =>
  words.join(" ").length <= RECEIVING_HOLDER_NAME_MAX_LENGTH;

/**
 * A bank-style holder name (at most 29 characters) from the full name:
 * unchanged when it fits; otherwise first and last names are kept, middle
 * names become initials and the particles da/de/do/dos/das/e stay. Still
 * too long: particles go, then middle initials from the right, and last
 * the words that do not fit, cut at a word boundary. Always editable.
 */
export function suggestReceivingHolderName(fullName: string): string {
  const words = normalizeReceivingHolderName(
    fullName.replace(/[^\p{L}\s'‘’ʼ-]/gu, " "),
  )
    .split(" ")
    .map((word) => word.replace(/^['-]+|['-]+$/g, ""))
    .filter(Boolean);
  if (fits(words)) return words.join(" ");
  const first = words[0];
  const last = words[words.length - 1];
  let middle = words
    .slice(1, -1)
    .map((word) => (particles.has(word) ? word : [...word][0]));
  if (words.length > 1 && !fits([first, ...middle, last]))
    middle = middle.filter((word) => !particles.has(word));
  while (middle.length && !fits([first, ...middle, last])) middle.pop();
  const candidate = words.length > 1 ? [first, ...middle, last] : [first];
  if (fits(candidate)) return candidate.join(" ");
  const kept: string[] = [];
  for (const word of candidate) {
    if (!fits([...kept, word])) break;
    kept.push(word);
  }
  if (kept.length) return kept.join(" ");
  return [...first]
    .slice(0, RECEIVING_HOLDER_NAME_MAX_LENGTH)
    .join("")
    .replace(/['-]+$/, "");
}
