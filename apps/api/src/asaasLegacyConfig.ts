import type { DatabaseTarget } from "@entrelacos/database";
import type { ProviderCredentialKeyring } from "./providerCredentials";

/**
 * Settings shape of the Asaas modules still present until the Pagar.me
 * checkout replaces them. It is never read from the environment: the running
 * application always hands these modules `ASAAS_UNREACHABLE`, so they stay
 * inert whatever PAGARME_MODE is. Tests may still build the enabled shape.
 */
export type AsaasLegacyConfig =
  | { readonly mode: "disabled" }
  | {
      readonly mode: "sandbox" | "live";
      readonly applicationEnvironment: DatabaseTarget;
      readonly backgroundProcessing?: true;
      readonly liveDemoSiteIds?: readonly string[];
      readonly sandboxBuyerGrossUpSiteId?: string;
      readonly platformApiKey: string;
      readonly platformAccountId: string;
      readonly platformWalletId: string;
      readonly platformWebhookTokenHash: string;
      readonly credentialKeyId: string;
      readonly credentialKeyring: ProviderCredentialKeyring;
      readonly webhookPublicOrigin: string;
      readonly webhookUrl: string;
      readonly withdrawalAuthorization?: {
        readonly token: string;
        readonly url: string;
      };
    };

export const ASAAS_UNREACHABLE: AsaasLegacyConfig = Object.freeze({
  mode: "disabled",
});
