import {
  siteTeamAcceptInputSchema,
  siteTeamAcceptResponseSchema,
  siteTeamInviteInputSchema,
} from "@entrelacos/contracts";
import { apiRequest } from "../lib/apiClient";

export type TeamAcceptance =
  | { mode: "existing"; email: string; password: string }
  | { mode: "new"; password: string }
  | { mode: "signedIn" };

export async function acceptTeamInvitation(
  token: string,
  input: TeamAcceptance,
  request: (
    path: string,
    options: { method: string; body: unknown },
  ) => Promise<unknown> = apiRequest,
) {
  const body = siteTeamAcceptInputSchema.parse(
    input.mode === "new" ? { token, password: input.password } : { token },
  );
  if (input.mode === "existing") {
    const email = siteTeamInviteInputSchema.shape.email.parse(input.email);
    await request("/v1/auth/sign-in/email", {
      method: "POST",
      body: { email, password: input.password },
    });
  }
  return siteTeamAcceptResponseSchema.parse(
    await request("/v1/team-invitations/accept", { method: "POST", body }),
  );
}
