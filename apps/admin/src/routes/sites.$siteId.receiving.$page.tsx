import { createFileRoute, redirect } from "@tanstack/react-router";
import { Panel } from "../components/Panel";
import {
  ReceivingPageContext,
  resolveReceivingPage,
} from "../components/receivingNavigation";

export const Route = createFileRoute("/sites/$siteId/receiving/$page")({
  beforeLoad: ({ params }) => {
    if (resolveReceivingPage(params.page) === "overview")
      throw redirect({
        to: "/sites/$siteId/receiving",
        params: { siteId: params.siteId },
      });
  },
  component: SiteReceivingPageRoute,
});
function SiteReceivingPageRoute() {
  const { siteId, page } = Route.useParams();
  return (
    <ReceivingPageContext value={resolveReceivingPage(page)}>
      <Panel key={siteId} siteId={siteId} area="receiving" />
    </ReceivingPageContext>
  );
}
