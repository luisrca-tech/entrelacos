import { createFileRoute } from "@tanstack/react-router";
import { Panel } from "../components/Panel";

export const Route = createFileRoute("/sites/$siteId/team")({
  component: SiteTeamRoute,
});
function SiteTeamRoute() {
  const { siteId } = Route.useParams();
  return <Panel key={siteId} siteId={siteId} area="team" />;
}
