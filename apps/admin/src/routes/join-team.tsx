import { createFileRoute } from "@tanstack/react-router";
import { TeamInvitationAcceptance } from "../components/TeamInvitationAcceptance";

export const Route = createFileRoute("/join-team")({
  component: TeamInvitationAcceptance,
});
