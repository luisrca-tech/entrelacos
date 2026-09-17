import { createFileRoute } from "@tanstack/react-router";
import { Panel } from "../components/Panel";

export const Route = createFileRoute("/sites/$siteId/guests")({
  component: SiteGuestsRoute,
});

function SiteGuestsRoute() {
  const { siteId } = Route.useParams();
  return <Panel key={siteId} siteId={siteId} area="guests" />;
}
