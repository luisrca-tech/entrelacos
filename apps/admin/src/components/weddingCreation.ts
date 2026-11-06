import {
  type OwnerSiteCreateInput,
  opaqueTokenSchema,
  type SiteRecord,
} from "@entrelacos/contracts";
import { ApiError, apiRequest } from "../lib/apiClient";

export type WeddingDraft = {
  site: OwnerSiteCreateInput;
  admin: { name: string; email: string } | null;
  issueLink: boolean;
};
export type WeddingCheckpoint = { site?: SiteRecord; userId?: string };
export type WeddingOutcome = {
  site: SiteRecord;
  access: { token: string; expiresAt: string } | null;
};

export function weddingSlug(first: string, second: string) {
  return [first.trim(), second.trim()]
    .filter(Boolean)
    .join(" e ")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

export async function createWedding(
  draft: WeddingDraft,
  checkpoint: WeddingCheckpoint,
  save: (checkpoint: WeddingCheckpoint) => void,
  current: () => boolean,
  request: typeof apiRequest = apiRequest,
): Promise<WeddingOutcome | undefined> {
  if (!current()) return;
  const site =
    checkpoint.site ??
    (
      await request<{ site: SiteRecord }>("/v1/owner/sites", {
        method: "POST",
        body: draft.site,
      })
    ).site;
  if (!current()) return;
  let userId = checkpoint.userId;
  save({ site, userId });
  if (!draft.admin) return { site, access: null };
  if (!userId) {
    const path = `/v1/owner/sites/${encodeURIComponent(site.id)}/admins`;
    try {
      userId = (
        await request<{ userId: string }>(path, {
          method: "POST",
          body: draft.admin,
        })
      ).userId;
    } catch (cause) {
      if (!current()) return;
      if (!(cause instanceof ApiError) || cause.status !== 409) throw cause;
      const { admins } = await request<{
        admins: { userId: string; email: string }[];
      }>(path);
      const email = draft.admin.email.trim().toLowerCase();
      userId = admins.find(
        (admin) => admin.email.toLowerCase() === email,
      )?.userId;
      if (!userId) throw cause;
    }
    if (!current()) return;
    save({ site, userId });
  }
  if (!draft.issueLink) return { site, access: null };
  const access = await request<{ token: string; expiresAt: string }>(
    `/v1/owner/admins/${encodeURIComponent(userId)}/access`,
    { method: "POST", body: { userId, purpose: "ACTIVATION" } },
  );
  if (!current()) return;
  return {
    site,
    access: { ...access, token: opaqueTokenSchema.parse(access.token) },
  };
}
