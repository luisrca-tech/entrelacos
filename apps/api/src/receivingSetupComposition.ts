import { hkdfSync, randomUUID } from "node:crypto";
import { receivingSetupConsentVersion } from "@entrelacos/contracts";
import type { DatabaseConnection } from "@entrelacos/database";
import { site } from "@entrelacos/database/schema";
import { eq } from "drizzle-orm";
import { createAsaasAccountProvisioningClient } from "./asaasAccountProvisioningClient";
import type { AuthInstance } from "./authHttp";
import { createFinancialPasswordVerifier } from "./financialPasswordVerifier";
import { createFinancialReauthenticationRateLimit } from "./financialReauthenticationRateLimit";
import type { GiftPaymentConfig } from "./giftPaymentConfig";
import {
  decryptProviderCredential,
  type ProviderCredentialContext,
} from "./providerCredentials";
import { createReceivingAccountProvisioning } from "./receivingAccountProvisioning";
import { createReceivingAccountProvisioningRepository } from "./receivingAccountProvisioningRepository";
import {
  createReceivingNominationComposition,
  type ReceivingNominationCompositionPorts,
} from "./receivingNominationComposition";
import { createReceivingNominationRepository } from "./receivingNominationRepository";
import { createReceivingPixDestinationLookup } from "./receivingPixDestination";
import { createReceivingPixDestinationSetup } from "./receivingPixDestinationSetup";
import { createReceivingPixDestinationSetupRepository } from "./receivingPixDestinationSetupRepository";
import {
  createReceivingSetupService,
  type ReceivingSetupService,
} from "./receivingSetup";
import {
  createReceivingSetupAsaasObserver,
  normalizeReceivingSetupAsaasAccount,
} from "./receivingSetupAsaas";
import type { ReceivingSetupHttpOptions } from "./receivingSetupHttp";
import {
  createReceivingSetupRepository,
  ReceivingSetupError,
} from "./receivingSetupRepository";
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
  const {
    applicationEnvironment,
    credentialKeyId,
    platformAccountId,
    platformApiKey,
  } = config;
  const policyVersion = "receiving-setup-v1";
  const maxAuthAgeMs = 300_000;
  const now = options.now ?? (() => new Date());
  const fetch = options.fetch ?? globalThis.fetch;
  const db = options.db;
  const keys = new Map(
    [...config.credentialKeyring].map(([id, key]) => [id, new Uint8Array(key)]),
  );
  const setupRepository = createReceivingSetupRepository(db, {
    mode,
    applicationEnvironment,
    policyVersion,
    maxAuthAgeMs,
    now,
  });
  const verification = createReceivingVerificationComposition({
    db,
    mode,
    applicationEnvironment,
    platformAccountReference: platformAccountId,
    keyring: keys,
    repository: setupRepository,
    fetch,
    now,
  });
  const repository = createReceivingNominationRepository(db, {
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
      mode,
      applicationEnvironment,
      maxAuthAgeMs,
      now,
      readCurrentPolicy: setupRepository.readCurrentProvisioningPolicy,
    }),
    fingerprintKeys: keys,
    activeFingerprintKeyId: credentialKeyId,
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
        parentAccountReference: platformAccountId,
        policyVersion,
        createClient(context) {
          return createAsaasAccountProvisioningClient({
            environment: mode,
            parentAccountReference: platformAccountId,
            parentCredential: platformApiKey,
            credentialContext: context,
            credentialKeys: keys,
            activeCredentialKeyId: credentialKeyId,
            fetch,
            normalizeOriginalResult: normalizeReceivingSetupAsaasAccount,
          });
        },
      };
    },
  });
  const observers = new Set<
    ReturnType<typeof createReceivingSetupAsaasObserver>
  >();
  const pixLookupLimit = createFinancialReauthenticationRateLimit(db, {
    maxAttempts: 5,
    windowMs: 60000,
    namespace: "receiving-pix-destination-lookup-v1",
  });
  const pixDestinationSetup = createReceivingPixDestinationSetup({
    repository: createReceivingPixDestinationSetupRepository(db, {
      mode,
      applicationEnvironment,
      now,
      maxAuthAgeMs,
    }),
    mode,
    keyring: keys,
    keyId: credentialKeyId,
    now,
  });
  const pixDestination = createReceivingPixDestinationLookup({
    mode,
    fetch,
    now,
    issueReview: (actor, account, input, review) =>
      pixDestinationSetup.issueReview(actor, account, input, review),
    consume: (accountId) => pixLookupLimit.consume(accountId),
    async authorize(actor) {
      await setupRepository.readSessionAuthentication(actor);
      const holder = await setupRepository.requireHolder(actor);
      if (
        !holder.consentId ||
        holder.consentVersion !== receivingSetupConsentVersion
      )
        throw new ReceivingSetupError(403, "RECEIVING_CONSENT_REQUIRED");
      const account = await setupRepository.readAccount(actor.siteId);
      if (
        !account ||
        !account.result ||
        account.state !== "SUCCEEDED" ||
        account.operatorUserId !== actor.userId
      )
        throw new ReceivingSetupError(409, "RECEIVING_ACCOUNT_REQUIRED");
      return account;
    },
    credential(account) {
      if (!account.result) return unavailable();
      return decryptProviderCredential(
        account.result.credential,
        {
          provider: "ASAAS",
          siteId: account.nomination.siteId,
          accountBindingId: account.accountId,
          environment: mode,
        },
        keys,
      );
    },
  });
  const setup = createReceivingSetupService({
    pixDestination,
    pixDestinationSetup,
    repository: setupRepository,
    nomination: nomination.receivingNomination,
    provisioning,
    async observe(siteId, account) {
      if (
        stopped ||
        !account.result ||
        account.state !== "SUCCEEDED" ||
        !account.accountId
      )
        return unavailable();
      const context: ProviderCredentialContext = {
        provider: "ASAAS",
        siteId,
        accountBindingId: account.accountId,
        environment: mode,
      };
      const observer = createReceivingSetupAsaasObserver({
        binding: {
          ...context,
          accountReference: account.result.accountReference,
          recipientReference: account.result.recipientReference,
        },
        accessToken: decryptProviderCredential(
          account.result.credential,
          context,
          keys,
        ),
        fetch,
        now,
      });
      observers.add(observer);
      try {
        return await observer.readStatus();
      } finally {
        await observer.close();
        observers.delete(observer);
      }
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
    ...(mode === "sandbox" && applicationEnvironment === "development"
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
      readPixDestination: (...args) =>
        own(() => setup.readPixDestination(...args)),
      confirmPixDestination: (...args) =>
        own(() => setup.confirmPixDestination(...args)),
      lookupPixDestination: (...args) =>
        own(() => setup.lookupPixDestination(...args)),
      read: (...args) => own(() => setup.read(...args)),
      designate: (...args) => own(() => setup.designate(...args)),
      submit: (...args) => own(() => setup.submit(...args)),
    },
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
        await Promise.allSettled(
          [...observers].map((observer) => observer.close()),
        );
        await Promise.allSettled([...pending]);
        await draining;
        pixDestinationSetup.close();
        for (const key of keys.values()) key.fill(0);
        keys.clear();
      })();
      return closing;
    },
  });
}
