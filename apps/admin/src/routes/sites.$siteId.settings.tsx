import { createFileRoute } from "@tanstack/react-router";
import { Panel } from "../components/Panel";

export const Route = createFileRoute("/sites/$siteId/settings")({
  component: SiteSettingsRoute,
});

function SiteSettingsRoute() {
  const { siteId } = Route.useParams();
  return <Panel key={siteId} siteId={siteId} area="settings" />;
}
