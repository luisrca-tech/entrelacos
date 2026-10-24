import { createFileRoute } from "@tanstack/react-router";
import { Panel } from "../components/Panel";
import { ReceivingPageContext } from "../components/receivingNavigation";

export const Route = createFileRoute("/sites/$siteId/receiving/")({
  component: SiteReceivingRoute,
});
function SiteReceivingRoute() {
  const { siteId } = Route.useParams();
  return (
    <ReceivingPageContext value="overview">
      <Panel key={siteId} siteId={siteId} area="receiving" />
    </ReceivingPageContext>
  );
}
