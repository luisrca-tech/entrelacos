/**
 * Accessible text for a gift image. The couple's description is optional and
 * only their own text is stored; when it is blank the fallback is derived at
 * render time from the gift's 1-based position in the list being shown, so it
 * stays correct when the catalog is reordered, filtered or paged.
 */
export function giftImageAlt(
  altText: string | null | undefined,
  position: number,
): string {
  if (!Number.isSafeInteger(position) || position < 1)
    throw new RangeError("Gift position must be a positive integer");
  const written = altText?.trim();
  return written || `Imagem do presente ${position} na lista`;
}
