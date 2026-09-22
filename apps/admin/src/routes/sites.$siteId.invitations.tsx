import { createFileRoute } from "@tanstack/react-router";
import { Panel } from "../components/Panel";

export const Route = createFileRoute("/sites/$siteId/invitations")({
  component: SiteInvitationsRoute,
});

function SiteInvitationsRoute() {
  const { siteId } = Route.useParams();
  return <Panel key={siteId} siteId={siteId} area="invitations" />;
}
