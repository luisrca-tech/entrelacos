import { siteIdSchema } from "@entrelacos/contracts";

export interface LiveSitePolicy {
  readonly liveDemoSiteId?: string;
}

export function allowsLiveSite(
  input: LiveSitePolicy & {
    siteId: string;
    isDemo: boolean;
    mode: "disabled" | "sandbox" | "live";
    applicationEnvironment: "development" | "test" | "production";
  },
): boolean {
  return (
    input.mode === "live" &&
    input.applicationEnvironment === "production" &&
    siteIdSchema.safeParse(input.siteId).success &&
    (input.isDemo === false ||
      (input.isDemo === true &&
        input.liveDemoSiteId === input.siteId &&
        siteIdSchema.safeParse(input.liveDemoSiteId).success))
  );
}
