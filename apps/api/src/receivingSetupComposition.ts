import { hkdfSync, randomUUID } from "node:crypto";
import type { DatabaseConnection } from "@entrelacos/database";
import { site } from "@entrelacos/database/schema";
import { eq } from "drizzle-orm";
import type { AuthInstance } from "./authHttp";
import { createFinancialPasswordVerifier } from "./financialPasswordVerifier";
import { createFinancialReauthenticationRateLimit } from "./financialReauthenticationRateLimit";
import type { GiftPaymentConfig } from "./giftPaymentConfig";
import { createPagarmeRecipientClient } from "./pagarmeRecipientClient";
import {
  createReceivingAccountProvisioning,
  deriveReceivingFingerprintKey,
  RECEIVING_FINGERPRINT_KEY_ID,
} from "./receivingAccountProvisioning";
import { createReceivingAccountProvisioningRepository } from "./receivingAccountProvisioningRepository";
import {
  createReceivingNominationComposition,
  type ReceivingNominationCompositionPorts,
} from "./receivingNominationComposition";
import { createReceivingNominationRepository } from "./receivingNominationRepository";
import {
  createReceivingSetupService,
  type ReceivingSetupService,
} from "./receivingSetup";
import type { ReceivingSetupHttpOptions } from "./receivingSetupHttp";
import { createReceivingSetupRepository } from "./receivingSetupRepository";
import { createReceivingVerificationComposition } from "./receivingVerificationComposition";

export interface ReceivingSetupCompositionOptions {
  db: DatabaseConnection["db"];
  standardAuth: AuthInstance;
  secret: string;
  baseURL: string;
  adminOrigin: string;
  now?: () => Date;
  fetch?: typeof globalThis.fetch;
}
export interface ReceivingSetupComposition {
  readonly ports: Partial<ReceivingNominationCompositionPorts> & {
    receivingSetup?: ReceivingSetupService;
    receivingVerification?: ReceivingSetupHttpOptions["receivingVerification"];
    kycRateLimit?: ReceivingSetupHttpOptions["kycRateLimit"];
  };
  refreshReceiving?(siteId: string): Promise<void>;
  close(): Promise<void>;
}
function unavailable(): never {
  throw new Error("Receiving setup composition unavailable");
}

export function createReceivingSetupComposition(
  config: GiftPaymentConfig,
  options: ReceivingSetupCompositionOptions,
): ReceivingSetupComposition {
  if (config.mode === "disabled")
    return Object.freeze({ ports: Object.freeze({}), async close() {} });
  if (
    !["sandbox", "live"].includes(config.mode) ||
    !["development", "test", "production"].includes(
      config.applicationEnvironment,
    ) ||
    (config.mode === "live") !==
      (config.applicationEnvironment === "production")
  )
    return unavailable();
  const mode = config.mode;
  const liveSitePolicy =
    config.liveDemoSiteIds === undefined
      ? {}
      : { liveDemoSiteIds: config.liveDemoSiteIds };
  const { applicationEnvironment, platformRecipientId, secretKey } = config;
  const policyVersion = "receiving-setup-v1";
  const maxAuthAgeMs = 300_000;
  const now = options.now ?? (() => new Date());
  const fetch = options.fetch ?? globalThis.fetch;
  const db = options.db;
  const recipients = createPagarmeRecipientClient({ secretKey, fetch });
  const keys = new Map([
    [
      RECEIVING_FINGERPRINT_KEY_ID,
      deriveReceivingFingerprintKey(options.secret),
    ],
  ]);
  const setupRepository = createReceivingSetupRepository(db, {
    ...liveSitePolicy,
    mode,
    applicationEnvironment,
    policyVersion,
    maxAuthAgeMs,
    now,
  });
  const verification = createReceivingVerificationComposition({
    ...liveSitePolicy,
    db,
    mode,
    applicationEnvironment,
    platformRecipientId,
    recipients,
    repository: setupRepository,
    now,
  });
  const repository = createReceivingNominationRepository(db, {
    ...liveSitePolicy,
    mode,
    applicationEnvironment,
    maxAuthAgeMs,
    now,
    admission: setupRepository.admission,
  });
  const proofKey = new Uint8Array(
    hkdfSync(
      "sha256",
      options.secret,
      "entrelacos-financial-reauthentication-v1",
      "password-proof",
      32,
    ),
  );
  const nomination = createReceivingNominationComposition({
    ...liveSitePolicy,
    standardAuth: options.standardAuth,
    authentication: {
      db,
      secret: options.secret,
      baseURL: options.baseURL,
      adminOrigin: options.adminOrigin,
    },
    configuration: {
      mode,
      applicationEnvironment,
      policyVersion,
      requestIdentityVersion: "nr1",
    },
    nomination: {
      repository,
      admission: setupRepository.admission,
      generateId: () => randomUUID(),
      async loadSite(siteId) {
        const rows = await db
          .select({ siteId: site.id, isDemo: site.isDemo })
          .from(site)
          .where(eq(site.id, siteId))
          .limit(1);
        return rows[0] ?? null;
      },
    },
    reauthentication: {
      keyId: "financial-password-v1",
      key: proofKey,
      maxAgeMs: maxAuthAgeMs,
      password: createFinancialPasswordVerifier(db),
      rateLimit: createFinancialReauthenticationRateLimit(db, {
        maxAttempts: 5,
        windowMs: 300_000,
      }),
    },
    now,
  });
  proofKey.fill(0);
  const provisioning = createReceivingAccountProvisioning({
    repository: createReceivingAccountProvisioningRepository(db, {
      ...liveSitePolicy,
      mode,
      applicationEnvironment,
      maxAuthAgeMs,
      now,
      readCurrentPolicy: setupRepository.readCurrentProvisioningPolicy,
    }),
    fingerprintKeys: keys,
    activeFingerprintKeyId: RECEIVING_FINGERPRINT_KEY_ID,
    now,
    async readProvider(snapshot) {
      if (
        snapshot.environment !== mode ||
        snapshot.policyVersion !== policyVersion
      )
        return null;
      return {
        approved: true,
        environment: mode,
        parentAccountReference: platformRecipientId,
        policyVersion,
        recipients,
      };
    },
  });
  const setup = createReceivingSetupService({
    repository: setupRepository,
    nomination: nomination.receivingNomination,
    provisioning,
    recipients,
    async observe(_siteId, account) {
      if (stopped || !account.result || account.state !== "SUCCEEDED")
        return unavailable();
      const recipient = await recipients.getRecipient(
        account.result.recipientReference,
      );
      return {
        recipientId: recipient.id,
        status: recipient.status,
        observedAt: now().toISOString(),
      };
    },
  });
  let stopped = false;
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  function own<T>(operation: () => Promise<T>): Promise<T> {
    if (stopped)
      return Promise.reject(
        new Error("Receiving setup composition unavailable"),
      );
    const work = Promise.resolve().then(operation);
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  }
  const ports: ReceivingSetupComposition["ports"] = {
    ...nomination,
    ...((mode === "sandbox" && applicationEnvironment === "development") ||
    (mode === "live" && applicationEnvironment === "production")
      ? {
          receivingVerification: {
            verify: (...args: Parameters<typeof verification.verify>) =>
              own(() => verification.verify(...args)),
          },
        }
      : {}),
    readAdministrativeSession: (...args) =>
      own(() => nomination.readAdministrativeSession(...args)),
    financialReauthentication: {
      authenticate: (...args) =>
        own(() => nomination.financialReauthentication.authenticate(...args)),
      readProof: (...args) => {
        if (stopped) return unavailable();
        return nomination.financialReauthentication.readProof(...args);
      },
    },
    receivingNomination: {
      ...nomination.receivingNomination,
      nominate: (...args) =>
        own(() => nomination.receivingNomination.nominate(...args)),
    },
    receivingNominationContext: {
      ...nomination.receivingNominationContext,
      readContext: (...args) =>
        own(() => nomination.receivingNominationContext.readContext(...args)),
    },
    receivingSetup: {
      createKycLink: (...args) => own(() => setup.createKycLink(...args)),
      read: (...args) => own(() => setup.read(...args)),
      designate: (...args) => own(() => setup.designate(...args)),
      submit: (...args) => own(() => setup.submit(...args)),
      reconcile: (...args) => own(() => setup.reconcile(...args)),
    },
    kycRateLimit: createFinancialReauthenticationRateLimit(db, {
      namespace: "receiving-kyc-link-v1",
      maxAttempts: 3,
      windowMs: 60_000,
    }),
  };
  return Object.freeze({
    ports: Object.freeze(ports),
    refreshReceiving: (siteId: string) =>
      own(() => verification.refresh(siteId)),
    close() {
      if (closing) return closing;
      stopped = true;
      closing = (async () => {
        const draining = provisioning.close();
        await verification.close();
        await Promise.allSettled([...pending]);
        await draining;
        for (const key of keys.values()) key.fill(0);
        keys.clear();
      })();
      return closing;
    },
  });
}
