import { createHash } from "node:crypto";
import { receivingSetupConsentVersion } from "@entrelacos/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createAsaasReceivingVerification,
  prepareAsaasReceivingVerification,
} from "./asaasReceivingVerification";
import { encryptProviderCredential } from "./providerCredentials";
import { deriveReceivingProvisioningContext } from "./receivingAccountProvisioning";
import { readReceivingNominationSnapshot } from "./receivingNomination";
import type { ReceivingSetupAsaasObservation } from "./receivingSetupAsaas";
import {
  prepareReceivingVerificationObservation,
  type ReceivingVerificationFence,
  readReceivingVerificationCandidate,
} from "./receivingVerification";

function fixture(environment: "sandbox" | "live" = "sandbox") {
  const keyring = new Map([["key-one", new Uint8Array(32).fill(12)]]);
  const input = {
    name: "Fictional Holder",
    email: "holder@example.test",
    cpfCnpj: "12345678909",
    mobilePhone: "11999999999",
    incomeValue: 1000,
    address: "Fictional Street",
    addressNumber: "1",
    province: "Fictional District",
    postalCode: "12345678",
    birthDate: "1990-01-01",
  };
  const nomination = readReceivingNominationSnapshot({
    state: "AWAITING_PROVIDER_VERIFICATION",
    siteId: "site-one",
    requestId: "request-one",
    operatorUserId: "holder-one",
    environment,
    policyVersion: "policy-one",
    accountId: "account-one",
    operationId: "operation-one",
    createdAt: "2026-10-13T00:00:00.000Z",
    requestHash: createHash("sha256")
      .update(
        JSON.stringify([
          "receiving.self-nomination.v1",
          "site-one",
          "request-one",
          "holder-one",
          environment,
          "policy-one",
          true,
        ]),
      )
      .digest("hex"),
    authentication: {
      userId: "holder-one",
      siteId: "site-one",
      sessionId: "session-one",
      proofKind: "PASSWORD_REAUTHENTICATION",
      authenticatedAt: "2026-10-12T23:59:30.000Z",
      expiresAt: "2026-10-13T00:04:00.000Z",
    },
  });
  const provision = deriveReceivingProvisioningContext(
    nomination,
    "parent-one",
    "key-one",
    input,
    keyring,
  );
  const scope = {
    provider: "ASAAS" as const,
    siteId: "site-one",
    accountId: "account-one",
    operatorUserId: "holder-one",
    environment,
    operatorReference: "simulation-local-correlation",
    accountReference: "native-one",
    recipientReference: "wallet-one",
  };
  const fence: ReceivingVerificationFence = {
    scope,
    account: {},
    operation: {
      request_snapshot: {
        version: "receiving.account-provisioning.v1",
        nomination,
        provision: {
          ...provision,
          dispatch: {
            leaseOwner: "owner-one",
            leaseToken: "token-one",
            leaseExpiresAtMicroseconds: "1791849660000000",
            possibleDispatch: true,
          },
        },
        sealedResult: null,
      },
    },
    destinations: [],
    evidence: [],
  };
  const observed: ReceivingSetupAsaasObservation = {
    siteId: scope.siteId,
    accountBindingId: scope.accountId,
    environment,
    accountReference: scope.accountReference,
    recipientReference: scope.recipientReference,
    observedAt: "2026-10-19T12:00:00.000Z",
    status: {
      id: "native-status-one",
      commercialInfo: "APPROVED",
      bankAccountInfo: "APPROVED",
      documentation: "APPROVED",
      general: "APPROVED",
    },
    commercialInfoExpired: null,
    verificationFacts: {
      commercialInfo: { ...input, status: "APPROVED" },
      accountNumber: { agency: "0001", account: "123456", accountDigit: "7" },
      activePixKey: { id: "key-one", status: "ACTIVE", type: "EVP" },
    },
  };
  return { keyring, fence, observed };
}

describe("authenticated native incoming Asaas verification", () => {
  it.each(["sandbox", "live"] as const)(
    "binds %s incoming account and original holder without exposing profile or bank numbers",
    (environment) => {
      const v = fixture(environment);
      const facts = prepareAsaasReceivingVerification(
        v.fence,
        v.observed,
        v.keyring,
      );
      expect(readReceivingVerificationCandidate(facts.candidate)).toEqual(
        facts.candidate,
      );
      expect(facts.candidate.bankReference).toMatch(
        /^asaas-bank-[a-f0-9]{64}$/,
      );
      expect(facts.candidate.scope.operatorReference).toBe(
        v.fence.scope.operatorReference,
      );
      expect(JSON.stringify(facts)).not.toMatch(
        /12345678909|holder@example|Fictional Holder|123456/,
      );
      expect(facts.observation).toBeNull();
      const selected = {
        ...v.fence,
        destinations: [
          {
            id: "destination-two",
            version: 2,
            bank_reference: facts.candidate.bankReference,
            is_current: true,
          },
        ],
      };
      const observation = prepareAsaasReceivingVerification(
        selected,
        v.observed,
        v.keyring,
      ).observation;
      if (!observation) throw new Error("Missing selected native observation");
      expect(
        prepareReceivingVerificationObservation(observation)
          .verificationReference.length,
      ).toBeLessThanOrEqual(256);
      expect(observation).toMatchObject({
        destination: { id: "destination-two", version: 2 },
        account: {
          state: "APPROVED",
          receiving: true,
          withdrawal: true,
          commercial: true,
        },
        bank: { state: "VERIFIED" },
      });
    },
  );
  it.each(["name", "cpfCnpj", "email", "address"])(
    "rejects changed accepted profile field %s",
    (field) => {
      const v = fixture();
      const facts = v.observed.verificationFacts;
      if (!facts) throw new Error("Missing native fixture");
      facts.commercialInfo[field] = "foreign";
      expect(() =>
        prepareAsaasReceivingVerification(v.fence, v.observed, v.keyring),
      ).toThrow();
    },
  );
  it.each(["sandbox", "live"] as const)(
    "requires an active %s Pix key before selecting the native incoming bank",
    (environment) => {
      const v = fixture(environment);
      if (!v.observed.verificationFacts)
        throw new Error("Missing fixture facts");
      Object.assign(v.observed.verificationFacts.activePixKey, {
        status: "AWAITING_ACTIVATION",
      });
      expect(() =>
        prepareAsaasReceivingVerification(v.fence, v.observed, v.keyring),
      ).toThrow();
    },
  );
  it("rejects cross-environment observations", () => {
    const v = fixture("live");
    v.observed.environment = "sandbox";
    expect(() =>
      prepareAsaasReceivingVerification(v.fence, v.observed, v.keyring),
    ).toThrow();
  });
  it.each(["sandbox", "live"] as const)(
    "cannot certify %s approval from status alone or a foreign wallet",
    (environment) => {
      const v = fixture(environment);
      delete v.observed.verificationFacts;
      expect(() =>
        prepareAsaasReceivingVerification(v.fence, v.observed, v.keyring),
      ).toThrow();
      const other = fixture(environment);
      other.observed.recipientReference = "foreign-wallet";
      expect(() =>
        prepareAsaasReceivingVerification(
          other.fence,
          other.observed,
          other.keyring,
        ),
      ).toThrow();
    },
  );
  it("does not match a simulated or external payout destination to its incoming bank", () => {
    const v = fixture();
    v.fence = {
      ...v.fence,
      destinations: [
        {
          id: "simulated-one",
          version: 1,
          bank_reference: "simulation:bank",
          is_current: true,
        },
      ],
    };
    expect(
      prepareAsaasReceivingVerification(v.fence, v.observed, v.keyring)
        .observation,
    ).toBeNull();
  });
});

describe("native verification transport and retained authority", () => {
  it.each([
    ["live", "development"],
    ["sandbox", "production"],
    ["sandbox", "test"],
  ] as const)(
    "rejects mismatched or unsupported %s/%s verification before network access",
    async (mode, applicationEnvironment) => {
      const v = fixture(mode);
      const fetch = vi.fn();
      const native = createAsaasReceivingVerification({
        mode,
        applicationEnvironment,
        platformAccountReference: "parent-one",
        keyring: v.keyring,
        fetch,
        now: () => new Date(v.observed.observedAt),
      });
      const owner = native.observer.acquire(
        "SELECT",
        v.fence,
        new AbortController().signal,
      );
      await expect(owner.result).rejects.toThrow();
      await owner.completion;
      expect(fetch).not.toHaveBeenCalled();
      await native.observer.close();
    },
  );
  it.each(["sandbox", "live"] as const)(
    "accepts only internally observed %s own-account facts and does not trust mutated caller receipts",
    async (environment) => {
      const v = fixture(environment);
      const context = {
        provider: "ASAAS" as const,
        siteId: v.fence.scope.siteId,
        accountBindingId: v.fence.scope.accountId,
        environment,
      };
      const envelope = encryptProviderCredential(
        "synthetic-subaccount-token",
        context,
        v.keyring,
        "key-one",
      );
      v.fence = {
        ...v.fence,
        account: {
          credential_version: envelope.version,
          credential_key_id: envelope.keyId,
          credential_nonce: envelope.nonce,
          credential_ciphertext: envelope.ciphertext,
          credential_tag: envelope.tag,
        },
      };
      const facts = v.observed.verificationFacts;
      if (!facts) throw new Error("Missing fixture facts");
      const fetch = vi.fn(
        async (url: string | URL | Request, request?: RequestInit) => {
          expect(request?.method).toBe("GET");
          expect(request?.body).toBeUndefined();
          expect(new Headers(request?.headers).get("access_token")).toBe(
            "synthetic-subaccount-token",
          );
          const providerUrl = new URL(String(url));
          expect(providerUrl.origin).toBe(
            environment === "live"
              ? "https://api.asaas.com"
              : "https://api-sandbox.asaas.com",
          );
          const path = providerUrl.pathname;
          if (path === "/v3/wallets/")
            return Response.json({
              data: [{ id: v.fence.scope.recipientReference }],
              hasMore: false,
            });
          if (path === "/v3/myAccount/status/")
            return Response.json(v.observed.status);
          if (path === "/v3/myAccount/commercialInfo/")
            return Response.json({
              ...facts.commercialInfo,
              commercialInfoExpiration: null,
            });
          if (path === "/v3/myAccount/accountNumber")
            return Response.json(facts.accountNumber);
          if (path === "/v3/pix/addressKeys")
            return Response.json({
              data: [facts.activePixKey],
              hasMore: false,
            });
          throw new Error("Unexpected provider path");
        },
      );
      const native = createAsaasReceivingVerification({
        mode: environment,
        applicationEnvironment:
          environment === "live" ? "production" : "development",
        platformAccountReference: "parent-one",
        keyring: v.keyring,
        fetch: fetch as typeof globalThis.fetch,
        now: () => new Date(v.observed.observedAt),
      });
      const owner = native.observer.acquire(
        "SELECT",
        v.fence,
        new AbortController().signal,
      );
      const candidate = await owner.result;
      await owner.completion;
      expect(fetch).toHaveBeenCalledTimes(5);
      const tx = {
        execute: vi.fn(async () => ({
          rows: [
            {
              holderUserId: "holder-one",
              consentId: "consent-one",
              consentVersion: receivingSetupConsentVersion,
              consentAt: new Date("2026-10-13T00:00:00Z"),
            },
          ],
        })),
      } as never;
      expect(
        await native.readCurrentPolicy(
          "SELECT",
          v.fence,
          tx,
          candidate as never,
        ),
      ).toBe(true);
      const forged = { ...candidate, bankReference: "client-replacement-bank" };
      expect(
        await native.readCurrentPolicy("SELECT", v.fence, tx, forged as never),
      ).toBe(false);
      await native.observer.close();
      expect(await native.readObserverPolicy(v.fence.scope)).toBe(false);
    },
  );
  it.each(["sandbox", "live"] as const)(
    "requires all four %s approvals alongside the original account facts",
    (environment) => {
      const v = fixture(environment);
      const first = prepareAsaasReceivingVerification(
        v.fence,
        v.observed,
        v.keyring,
      );
      v.fence = {
        ...v.fence,
        destinations: [
          {
            id: "destination-one",
            version: 1,
            bank_reference: first.candidate.bankReference,
            is_current: true,
          },
        ],
      };
      v.observed.status.documentation = "PENDING";
      expect(
        prepareAsaasReceivingVerification(v.fence, v.observed, v.keyring)
          .observation,
      ).toMatchObject({
        account: {
          state: "UNDER_REVIEW",
          receiving: false,
          withdrawal: false,
          commercial: false,
        },
      });
    },
  );
});
