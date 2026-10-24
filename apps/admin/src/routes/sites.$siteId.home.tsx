import { createFileRoute } from "@tanstack/react-router";
import { Panel } from "../components/Panel";

export const Route = createFileRoute("/sites/$siteId/home")({
  component: SiteHomeRoute,
});
function SiteHomeRoute() {
  const { siteId } = Route.useParams();
  return <Panel key={siteId} siteId={siteId} area="home" />;
}
