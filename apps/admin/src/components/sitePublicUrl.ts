import { publicUrlSchema } from "@entrelacos/contracts";

export function publicSiteHandoffUrl(publicUrl: string): string {
  const safePublicUrl = publicUrlSchema.parse(publicUrl);
  const url = new URL(safePublicUrl);
  url.hash = "panel";
  return url.href;
}
