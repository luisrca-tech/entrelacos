import { randomUUID } from "node:crypto";
import type { ReceivingReadiness } from "@entrelacos/contracts";
import type { DatabaseConnection } from "@entrelacos/database";
import { sql } from "drizzle-orm";
import { createAsaasReceivingVerification } from "./asaasReceivingVerification";
import type { FinancialActor } from "./financialAuthorization";
import { allowsLiveSite } from "./liveSitePolicy";
import {
  decryptProviderCredential,
  type ProviderCredentialKeyring,
} from "./providerCredentials";
import { readReceivingProvisioningRecord } from "./receivingNomination";
import {
  createReceivingPixPreparation,
  type IncomingPixPreparation,
} from "./receivingPixPreparation";
import { readReceivingReadiness } from "./receivingRepository";
import {
  ReceivingSetupError,
  type ReceivingSetupRepository,
} from "./receivingSetupRepository";
import {
  createReceivingVerification,
  type ReceivingVerificationScope,
  readReceivingVerificationScope,
} from "./receivingVerification";
import { createReceivingVerificationRepository } from "./receivingVerificationRepository";

export function createReceivingVerificationComposition(options: {
  liveDemoSiteId?: string;
  db: DatabaseConnection["db"];
  mode: "sandbox" | "live";
  applicationEnvironment: "development" | "test" | "production";
  platformAccountReference: string;
  keyring: ProviderCredentialKeyring;
  repository: Pick<
    ReceivingSetupRepository,
    | "requireHolder"
    | "readSessionAuthentication"
    | "readCurrentProvisioningPolicy"
    | "readAccount"
    | "armIncomingPix"
    | "settleIncomingPix"
    | "consentIncomingPix"
  >;
  fetch: typeof globalThis.fetch;
  now(): Date;
  readReadiness?: (siteId: string) => Promise<ReceivingReadiness>;
  prepareIncoming?: (
    actor: FinancialActor,
    scope: ReceivingVerificationScope,
  ) => Promise<IncomingPixPreparation>;
}) {
  const liveDemoSiteId = options.liveDemoSiteId;
  const sandboxSimulation =
    options.mode === "sandbox" &&
    options.applicationEnvironment === "development";
  const supported =
    sandboxSimulation ||
    (options.mode === "live" &&
      options.applicationEnvironment === "production");
  const native = createAsaasReceivingVerification(options);
  const pix = createReceivingPixPreparation({
    repository: {
      arm: (...args) => options.repository.armIncomingPix(...args),
      settle: (...args) => options.repository.settleIncomingPix(...args),
    },
    fetch: options.fetch,
    now: options.now,
  });
  async function prepareIncoming(
    actor: FinancialActor,
    scope: ReceivingVerificationScope,
  ) {
    const account = await options.repository.readAccount(actor.siteId);
    if (
      !account?.result ||
      !account.record ||
      account.state !== "SUCCEEDED" ||
      account.accountId !== scope.accountId ||
      account.operatorUserId !== actor.userId ||
      account.result.accountReference !== scope.accountReference ||
      account.result.recipientReference !== scope.recipientReference ||
      scope.accountReference === options.platformAccountReference ||
      account.record.provision.parentAccountReference !==
        options.platformAccountReference
    )
      throw new ReceivingSetupError(409, "RECEIVING_ACCOUNT_REQUIRED");
    const binding = {
      provider: "ASAAS" as const,
      siteId: scope.siteId,
      accountBindingId: scope.accountId,
      environment: options.mode,
      accountReference: scope.accountReference,
      recipientReference: scope.recipientReference,
    };
    return pix.prepare(
      actor,
      binding,
      decryptProviderCredential(
        account.result.credential,
        {
          provider: binding.provider,
          siteId: binding.siteId,
          accountBindingId: binding.accountBindingId,
          environment: binding.environment,
        },
        options.keyring,
      ),
    );
  }
  const verification = createReceivingVerification({
    profile: "rv1",
    setupSessionSelection: supported,
    ...native,
    repository: createReceivingVerificationRepository(options.db, {
      mode: options.mode,
      ...(liveDemoSiteId === undefined
        ? {}
        : { liveDemoSiteId: liveDemoSiteId }),
      applicationEnvironment: options.applicationEnvironment,
      maxAuthAgeMs: 300000,
      now: options.now,
      allowSandboxSimulationHistory: sandboxSimulation,
      readCurrentPolicy: native.readCurrentPolicy,
      authorizeSetupSelectionInTransaction: async (
        tx,
        fence,
        authorization,
        candidate,
      ) =>
        supported &&
        (candidate === null ||
          candidate.bankReference.startsWith("asaas-bank-")) &&
        options.repository.readCurrentProvisioningPolicy(
          readReceivingProvisioningRecord(fence.operation.request_snapshot),
          tx,
          authorization,
        ),
    }),
    now: options.now,
  });
  const pending = new Map<string, Promise<void>>();
  const refreshed = new Map<string, number>();
  let closed = false;
  async function current(siteId: string) {
    if (!supported || closed)
      throw new ReceivingSetupError(503, "RECEIVING_VERIFICATION_UNAVAILABLE");
    const result = await options.db.execute(
      sql`SELECT st.is_demo AS "isDemo",a.site_id AS "siteId",a.id AS "accountId",a.operator_user_id AS "operatorUserId",a.operator_reference AS "operatorReference",a.account_reference AS "accountReference",a.recipient_reference AS "recipientReference",EXISTS(SELECT 1 FROM receiving_destination d WHERE d.site_id=a.site_id AND d.account_id=a.id AND d.environment=a.environment AND d.is_current=true AND starts_with(d.bank_reference,'asaas-bank-')) AS "nativeDestination" FROM receiving_account a JOIN site st ON st.id=a.site_id WHERE a.site_id=${siteId} AND a.environment=${options.mode} AND a.provider='ASAAS' AND a.is_current=true AND (st.is_demo=${sandboxSimulation} OR (${options.mode}='live' AND st.id=${liveDemoSiteId ?? null})) LIMIT 2`,
    );
    const row = result.rows[0];
    if (
      result.rows.length !== 1 ||
      row.siteId !== siteId ||
      (options.mode === "sandbox"
        ? row.isDemo !== sandboxSimulation
        : !allowsLiveSite({
            siteId,
            isDemo: row.isDemo as boolean,
            mode: options.mode,
            applicationEnvironment: options.applicationEnvironment,
            liveDemoSiteId: liveDemoSiteId,
          })) ||
      typeof row.nativeDestination !== "boolean"
    )
      throw new ReceivingSetupError(409, "RECEIVING_ACCOUNT_REQUIRED");
    const { nativeDestination, isDemo: _isDemo, ...scope } = row;
    return {
      scope: readReceivingVerificationScope({
        ...scope,
        provider: "ASAAS",
        environment: options.mode,
      }),
      nativeDestination,
    };
  }
  async function settle(command: Parameters<typeof verification.begin>[0]) {
    const owner = verification.begin(command);
    const result = await owner.feedback;
    await owner.completion;
    if (result.state !== "STORED")
      throw new ReceivingSetupError(503, "RECEIVING_VERIFICATION_UNAVAILABLE");
  }
  async function observe(siteId: string) {
    const selected = await current(siteId);
    // Public reads may refresh existing evidence, but never select a destination.
    if (!selected.nativeDestination) return;
    await settle({ action: "OBSERVE", scope: selected.scope });
    refreshed.set(siteId, options.now().getTime());
  }
  async function observeOnce(siteId: string) {
    const existing = pending.get(siteId);
    if (existing) return existing;
    const work = observe(siteId);
    pending.set(siteId, work);
    try {
      await work;
    } finally {
      if (pending.get(siteId) === work) pending.delete(siteId);
    }
  }
  return Object.freeze({
    async verify(
      actor: FinancialActor,
      pixConsentVersion?: string,
    ): Promise<ReceivingReadiness> {
      if (!supported || closed)
        throw new ReceivingSetupError(
          503,
          "RECEIVING_VERIFICATION_UNAVAILABLE",
        );
      const proof = await options.repository.readSessionAuthentication(actor);
      if (
        proof.proofKind !== "SESSION_AUTHENTICATION" ||
        proof.userId !== actor.userId ||
        proof.siteId !== actor.siteId ||
        proof.sessionId !== actor.sessionId
      )
        throw new ReceivingSetupError(403, "MEMBERSHIP_DENIED");
      await options.repository.requireHolder(actor);
      const selected = await current(actor.siteId);
      if (selected.scope.operatorUserId !== actor.userId)
        throw new ReceivingSetupError(403, "RECEIVING_HOLDER_REQUIRED");
      if (pixConsentVersion)
        await options.repository.consentIncomingPix(
          actor,
          selected.scope.accountId,
          pixConsentVersion,
        );
      const preparation = await (options.prepareIncoming ?? prepareIncoming)(
        actor,
        selected.scope,
      );
      if (preparation !== "READY")
        throw new ReceivingSetupError(
          409,
          `RECEIVING_PIX_PREPARATION_${preparation}`,
        );
      if (!selected.nativeDestination)
        await settle({
          action: "SELECT",
          scope: selected.scope,
          selectionId: randomUUID(),
          authorization: { actor, recentAuth: proof },
          confirmDestinationSelection: true,
        });
      await observeOnce(actor.siteId);
      return (
        options.readReadiness ??
        ((siteId) =>
          readReceivingReadiness(options.db, siteId, {
            mode: options.mode,
            ...(liveDemoSiteId === undefined
              ? {}
              : { liveDemoSiteId: liveDemoSiteId }),
            applicationEnvironment: options.applicationEnvironment,
            freshnessMs: 300000,
            now: options.now,
          }))
      )(actor.siteId);
    },
    async refresh(siteId: string) {
      if (!supported || closed) return;
      const last = refreshed.get(siteId);
      const at = options.now().getTime();
      if (last !== undefined && at >= last && at - last < 60000) return;
      await observeOnce(siteId);
    },
    async close() {
      closed = true;
      await Promise.all([
        verification.close(),
        native.observer.close(),
        pix.close(),
      ]);
      await Promise.allSettled(pending.values());
      pending.clear();
      refreshed.clear();
    },
  });
}
