import { createFileRoute } from "@tanstack/react-router";
import { Panel } from "../components/Panel";

export const Route = createFileRoute("/sites/$siteId/overview")({
  component: SiteOverviewRoute,
});

function SiteOverviewRoute() {
  const { siteId } = Route.useParams();
  return <Panel key={siteId} siteId={siteId} area="overview" />;
}
