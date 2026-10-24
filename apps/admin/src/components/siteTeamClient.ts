import {
  originSchema,
  siteIdSchema,
  siteTeamAcceptInputSchema,
  siteTeamInviteInputSchema,
  siteTeamInviteResponseSchema,
  siteTeamResponseSchema,
} from "@entrelacos/contracts";
import { apiRequest } from "../lib/apiClient";

type TeamRequest = (
  path: string,
  options?: { method?: string; body?: unknown },
) => Promise<unknown>;

export async function loadSiteTeam(
  siteId: string,
  request: TeamRequest = apiRequest,
) {
  const id = siteIdSchema.parse(siteId);
  const team = siteTeamResponseSchema.parse(
    await request(`/v1/sites/${encodeURIComponent(id)}/team`),
  );
  if (
    [...team.members, ...team.invitations].some((entry) => entry.siteId !== id)
  )
    throw new Error("Unexpected team site");
  return team;
}

export async function issueTeamInvitation(
  siteId: string,
  input: unknown,
  request: TeamRequest = apiRequest,
) {
  const id = siteIdSchema.parse(siteId);
  const body = siteTeamInviteInputSchema.parse(input);
  const result = siteTeamInviteResponseSchema.parse(
    await request(`/v1/sites/${encodeURIComponent(id)}/team/invitations`, {
      method: "POST",
      body,
    }),
  );
  if (result.invitation.siteId !== id)
    throw new Error("Unexpected invitation site");
  return result;
}

export function teamInvitationUrl(origin: string, token: string): string {
  originSchema.parse(origin);
  siteTeamAcceptInputSchema.shape.token.parse(token);
  return `${origin}/join-team#token=${token}`;
}
