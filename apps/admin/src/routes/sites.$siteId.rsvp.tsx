import { createFileRoute } from "@tanstack/react-router";
import { Panel } from "../components/Panel";

export const Route = createFileRoute("/sites/$siteId/rsvp")({
  component: SiteRsvpRoute,
});

function SiteRsvpRoute() {
  const { siteId } = Route.useParams();
  return <Panel key={siteId} siteId={siteId} area="rsvp" />;
}
