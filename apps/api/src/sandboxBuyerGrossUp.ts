// Explicit, single-site homologation only. This does not approve live pricing
// or assign responsibility for settlement differences.
export function allowsSandboxBuyerGrossUp(input: {
  siteId: string;
  sandboxBuyerGrossUpSiteId?: string;
  isDemo: boolean;
  applicationEnvironment: string;
  environment: string;
}): boolean {
  return (
    input.applicationEnvironment === "development" &&
    input.environment === "sandbox" &&
    input.isDemo === true &&
    input.siteId.length > 0 &&
    input.siteId === input.sandboxBuyerGrossUpSiteId
  );
}
