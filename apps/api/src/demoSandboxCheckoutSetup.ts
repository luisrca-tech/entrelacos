import { randomUUID } from "node:crypto";
import { receivingSetupConsentVersion } from "@entrelacos/contracts";
import type { DatabaseConnection } from "@entrelacos/database";
import { sql } from "drizzle-orm";
import { readDatabaseTimestamp } from "./databaseTimestamp";
import { DEMO_REPOSITORY_SLUG, DEMO_SITE_ID } from "./environmentProvision";
import type { GiftPaymentConfig } from "./giftPaymentConfig";
import { decryptProviderCredential } from "./providerCredentials";
import { evaluateReceivingReadiness } from "./receivingReadiness";

export const demoSandboxCheckoutConfirmation =
  "PREPARE development demo-wedding Sandbox checkout simulation";
const freshnessMs = 300000;
function unavailable(): never {
  throw new Error("Demo Sandbox checkout preparation unavailable");
}
function identifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  )
    return unavailable();
  return value;
}
type Database = Pick<DatabaseConnection["db"], "transaction">;

// Explicit operational fixture only. Native receiving approval is never inferred.
// Withdrawal service and SQL reservation boundaries reject SIMULATION evidence.
export async function prepareDemoSandboxCheckout(
  db: Database,
  config: GiftPaymentConfig,
  input: { confirmation: string },
) {
  if (
    config.mode !== "sandbox" ||
    config.applicationEnvironment !== "development" ||
    input.confirmation !== demoSandboxCheckoutConfirmation
  )
    return unavailable();
  try {
    return await db.transaction(async (tx) => {
      const sites = await tx.execute(
        sql`SELECT id,is_demo AS "isDemo",repository_slug AS "repositorySlug",clock_timestamp() AS "currentTime" FROM site WHERE id=${DEMO_SITE_ID} FOR UPDATE`,
      );
      const site = sites.rows[0];
      if (
        sites.rows.length !== 1 ||
        site.id !== DEMO_SITE_ID ||
        site.isDemo !== true ||
        site.repositorySlug !== DEMO_REPOSITORY_SLUG
      )
        return unavailable();
      const now = readDatabaseTimestamp(site.currentTime);
      const holders = await tx.execute(
        sql`SELECT h.id,h.holder_user_id AS "holderUserId",h.consent_id AS "consentId",h.consent_version AS "consentVersion",h.consent_at AS "consentAt",u.state,u.role FROM receiving_setup_holder h INNER JOIN "user" u ON u.id=h.holder_user_id WHERE h.site_id=${DEMO_SITE_ID} AND h.environment='sandbox' FOR UPDATE OF h`,
      );
      const holder = holders.rows[0];
      if (
        holders.rows.length !== 1 ||
        holder.state !== "ACTIVE" ||
        holder.role !== "SITE_ADMIN" ||
        !holder.consentId ||
        holder.consentVersion !== receivingSetupConsentVersion ||
        !holder.consentAt ||
        readDatabaseTimestamp(holder.consentAt).getTime() > now.getTime()
      )
        return unavailable();
      const accounts = await tx.execute(
        sql`SELECT a.id,a.site_id AS "siteId",a.environment,a.provider,a.operator_user_id AS "operatorUserId",a.operator_reference AS "operatorReference",a.account_reference AS "accountReference",a.recipient_reference AS "recipientReference",jsonb_build_object('version',a.credential_version,'keyId',a.credential_key_id,'nonce',a.credential_nonce,'ciphertext',a.credential_ciphertext,'tag',a.credential_tag) AS credential,a.webhook_token_hash AS "webhookTokenHash",a.webhook_registration AS "webhookRegistration",op.state AS "creationState" FROM receiving_account a INNER JOIN financial_operation op ON op.account_id=a.id AND op.site_id=a.site_id AND op.environment=a.environment AND op.kind='ACCOUNT_CREATE' WHERE a.site_id=${DEMO_SITE_ID} AND a.environment='sandbox' AND a.is_current=true FOR UPDATE OF a,op`,
      );
      const account = accounts.rows[0];
      if (
        accounts.rows.length !== 1 ||
        account.siteId !== DEMO_SITE_ID ||
        account.environment !== "sandbox" ||
        account.provider !== "ASAAS" ||
        account.operatorUserId !== holder.holderUserId ||
        account.creationState !== "SUCCEEDED" ||
        typeof account.webhookTokenHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(account.webhookTokenHash)
      )
        return unavailable();
      const registration = account.webhookRegistration;
      if (
        !registration ||
        typeof registration !== "object" ||
        Array.isArray(registration)
      )
        return unavailable();
      const webhook = registration as Record<string, unknown>;
      if (
        webhook.version !== 1 ||
        webhook.state !== "REGISTERED" ||
        webhook.url !== config.webhookUrl
      )
        return unavailable();
      identifier(webhook.providerWebhookId);
      const accountId = identifier(account.id),
        accountReference = identifier(account.accountReference),
        recipientReference = identifier(account.recipientReference);
      const operatorReference = identifier(
        `simulation-demo-checkout:${identifier(holder.id)}`,
      );
      if (
        account.operatorReference !== null &&
        account.operatorReference !== operatorReference
      )
        return unavailable();
      const credentialContext = {
        provider: "ASAAS" as const,
        siteId: DEMO_SITE_ID,
        accountBindingId: accountId,
        environment: "sandbox" as const,
      };
      // A valid stored scoped envelope is required; plaintext is never retained or logged.
      if (
        !decryptProviderCredential(
          account.credential,
          credentialContext,
          config.credentialKeyring,
        )
      )
        return unavailable();
      const destinationId = identifier(
          `demo-checkout-destination-${accountId}`,
        ),
        bankReference = identifier(`simulation:demo-checkout:${accountId}`);
      const destinations = await tx.execute(
        sql`SELECT id,version,bank_reference AS "bankReference",bank_state AS "bankState",is_current AS "isCurrent" FROM receiving_destination WHERE site_id=${DEMO_SITE_ID} AND account_id=${accountId} AND environment='sandbox' LIMIT 2 FOR UPDATE`,
      );
      const destination = destinations.rows[0];
      if (
        destinations.rows.length > 1 ||
        (destination &&
          (destination.id !== destinationId ||
            destination.version !== 1 ||
            destination.bankReference !== bankReference ||
            destination.bankState !== "VERIFIED" ||
            destination.isCurrent !== true))
      )
        return unavailable();
      const proofs = await tx.execute(
        sql`SELECT id,provenance,account_reference AS "accountReference",recipient_reference AS "recipientReference",operator_reference AS "operatorReference",bank_reference AS "bankReference",created_at AS "createdAt" FROM receiving_verification_evidence WHERE site_id=${DEMO_SITE_ID} AND account_id=${accountId} AND environment='sandbox' ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`,
      );
      const previous = proofs.rows[0];
      if (
        previous &&
        (previous.provenance !== "SIMULATION" ||
          previous.accountReference !== accountReference ||
          previous.recipientReference !== recipientReference ||
          previous.operatorReference !== operatorReference ||
          previous.bankReference !== bankReference ||
          readDatabaseTimestamp(previous.createdAt).getTime() >= now.getTime())
      )
        return unavailable();
      const updated = await tx.execute(
        sql`UPDATE receiving_account SET operator_reference=${operatorReference},provider_account_state='APPROVED',receiving_capability=true,withdrawal_capability=true,commercial_enabled=true,observed_at=${now},updated_at=${now} WHERE id=${accountId} AND site_id=${DEMO_SITE_ID} AND environment='sandbox' AND is_current=true RETURNING id`,
      );
      if (updated.rows.length !== 1 || updated.rows[0].id !== accountId)
        return unavailable();
      if (!destination)
        await tx.execute(
          sql`INSERT INTO receiving_destination (id,site_id,account_id,environment,version,bank_reference,masked_descriptor,bank_state,is_current,created_at) VALUES (${destinationId},${DEMO_SITE_ID},${accountId},'sandbox',1,${bankReference},'Simulated destination - Sandbox checkout only','VERIFIED',true,${now})`,
        );
      await tx.execute(
        sql`INSERT INTO receiving_verification_evidence (id,site_id,account_id,environment,destination_version,account_reference,recipient_reference,operator_reference,bank_reference,verification_status,provenance,verification_reference,provider_account_state,bank_state,receiving_capability,withdrawal_capability,commercial_enabled,observed_at,bank_observed_at,created_at) VALUES (${randomUUID()},${DEMO_SITE_ID},${accountId},'sandbox',1,${accountReference},${recipientReference},${operatorReference},${bankReference},'VERIFIED','SIMULATION',${`simulation:demo-checkout:v1:${randomUUID()}`},'APPROVED','VERIFIED',true,true,true,${now},${now},${now})`,
      );
      const binding = {
        siteId: DEMO_SITE_ID,
        provider: "ASAAS",
        operatorReference,
        environment: "sandbox" as const,
        accountReference,
        recipientReference,
        destinationVersion: 1,
        bankReference,
      };
      const readiness = evaluateReceivingReadiness({
        siteId: DEMO_SITE_ID,
        isDemo: true,
        environment: "development",
        mode: "sandbox",
        providerBinding: binding,
        evidence: {
          ...binding,
          verification: "verified",
          provenance: "simulation",
          accountState: "approved",
          bankState: "verified",
          observedAt: now,
          bankObservedAt: now,
          capabilities: { receiving: true, withdrawal: true },
          commercialEnabled: true,
        },
        now,
        freshnessMs,
      });
      if (readiness.state !== "READY") return unavailable();
      return {
        siteId: DEMO_SITE_ID,
        accountId,
        provenance: "SIMULATION" as const,
        purpose: "GUEST_CHECKOUT_ONLY" as const,
        destinationVersion: 1,
        observedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + freshnessMs).toISOString(),
      };
    });
  } catch {
    return unavailable();
  }
}
