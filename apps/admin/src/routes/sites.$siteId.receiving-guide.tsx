import { createFileRoute } from "@tanstack/react-router";
import { Panel } from "../components/Panel";

export const Route = createFileRoute("/sites/$siteId/receiving-guide")({
  component: SiteReceivingGuideRoute,
});
function SiteReceivingGuideRoute() {
  const { siteId } = Route.useParams();
  return <Panel key={siteId} siteId={siteId} area="receiving-guide" />;
}
