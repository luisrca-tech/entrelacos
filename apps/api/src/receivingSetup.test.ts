import { receivingSetupConsentVersion } from "@entrelacos/contracts";
import { describe, expect, it, vi } from "vitest";
import { createReceivingSetupService } from "./receivingSetup";

const actor = {
  userId: "bride-one",
  siteId: "site-one",
  sessionId: "session-one",
};
const holder = {
  id: "holder-one",
  siteId: "site-one",
  environment: "sandbox",
  holderUserId: "bride-one",
  holderName: "Marina",
  consentId: "consent-one",
  consentVersion: receivingSetupConsentVersion,
};
function fixture() {
  const sessionAuthentication = {
    ...actor,
    proofKind: "SESSION_AUTHENTICATION",
    provenance: "backend",
    verification: "verified",
    authenticatedAt: new Date("2026-10-16T10:00:00Z"),
    expiresAt: new Date("2026-10-23T10:00:00Z"),
  };
  const repository = {
    mode: "sandbox",
    policyVersion: "policy-v1",
    readHolder: vi.fn(async () => holder),
    requireHolder: vi.fn(async () => holder),
    readAccount: vi.fn(async () => null),
    consent: vi.fn(async () => {}),
    consentIncomingPix: vi.fn(async () => {}),
    designate: vi.fn(async () => {}),
    readSessionAuthentication: vi.fn(async () => sessionAuthentication),
  };
  const nomination = { accountId: "binding-one", operatorUserId: actor.userId };
  const nominate = vi.fn(async () => nomination);
  const completion = Promise.resolve();
  const begin = vi.fn((_input: unknown) => ({
    feedback: Promise.resolve({ state: "STORED" }),
    completion,
    cancel: vi.fn(),
  }));
  const observe = vi.fn();
  const options = {
    repository,
    nomination: { nominate },
    provisioning: { begin },
    observe,
  } as unknown as Parameters<typeof createReceivingSetupService>[0];
  return {
    repository,
    nominate,
    begin,
    observe,
    service: createReceivingSetupService(options),
  };
}
const input = {
  policyVersion: "policy-v1",
  consentVersion: receivingSetupConsentVersion,
  confirmHolder: true as const,
  consentToAsaas: true as const,
  account: {
    name: "Fictional Person",
    email: "person@example.test",
    cpfCnpj: "12345678909",
    mobilePhone: "11999999999",
    incomeValue: 1000,
    address: "Fictional Road",
    addressNumber: "1",
    province: "District",
    postalCode: "12345678",
    birthDate: "1990-01-01",
  },
};
const authorization = { actor } as Parameters<
  ReturnType<typeof createReceivingSetupService>["submit"]
>[1];
describe("receiving setup orchestration", () => {
  it("records the explicitly accepted Pix disclosure before original provider creation", async () => {
    const v = fixture();
    await v.service.submit(
      { ...input, pixConsentVersion: "asaas-incoming-pix-v1" },
      authorization,
    );
    expect(v.repository.consentIncomingPix).toHaveBeenCalledExactlyOnceWith(
      actor,
      "binding-one",
      "asaas-incoming-pix-v1",
    );
    expect(
      v.repository.consentIncomingPix.mock.invocationCallOrder[0],
    ).toBeLessThan(v.begin.mock.invocationCallOrder[0]);
  });
  it("shows a designation as distinct from consent and account creation", async () => {
    const values = fixture();
    expect(await values.service.read(actor)).toMatchObject({
      holder: { userId: "bride-one", name: "Marina" },
      isHolder: true,
      consentRecorded: true,
      accountState: "NOT_CREATED",
      providerStatus: null,
    });
    expect(values.begin).not.toHaveBeenCalled();
  });
  it("never exposes the account registration action to another site administrator", async () => {
    const values = fixture();
    expect(
      await values.service.read({ ...actor, userId: "planner-one" }),
    ).toMatchObject({ isHolder: false, accountState: "NOT_CREATED" });
    values.repository.requireHolder.mockRejectedValueOnce(
      new Error("holder required"),
    );
    await expect(
      values.service.submit(input, {
        ...authorization,
        actor: { ...actor, userId: "planner-one" },
      }),
    ).rejects.toThrow();
    expect(values.repository.consent).not.toHaveBeenCalled();
    expect(values.begin).not.toHaveBeenCalled();
  });
  it("persists the holder consent before nomination and one-time original provisioning", async () => {
    const values = fixture();
    expect(await values.service.submit(input, authorization)).toEqual({
      state: "STORED",
    });
    expect(values.repository.consent.mock.invocationCallOrder[0]).toBeLessThan(
      values.nominate.mock.invocationCallOrder[0],
    );
    expect(values.nominate.mock.invocationCallOrder[0]).toBeLessThan(
      values.begin.mock.invocationCallOrder[0],
    );
    expect(values.begin).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        action: "CREATE",
        confirmNativeCreation: true,
        input: { ...input.account, name: "FICTIONAL PERSON" },
      }),
    );
    expect(
      values.repository.readSessionAuthentication,
    ).toHaveBeenCalledExactlyOnceWith(actor);
    expect(values.begin.mock.calls[0]?.[0]).toMatchObject({
      authorization: {
        recentAuth: {
          proofKind: "SESSION_AUTHENTICATION",
          authenticatedAt: new Date("2026-10-16T10:00:00Z"),
        },
      },
    });
  });
  it("does not create another provider account when a previous dispatch is uncertain", async () => {
    const values = fixture();
    values.repository.readAccount.mockResolvedValueOnce({
      state: "CLAIMED",
      operatorUserId: actor.userId,
    } as never);
    expect(await values.service.submit(input, authorization)).toEqual({
      state: "UNKNOWN",
    });
    expect(values.nominate).not.toHaveBeenCalled();
    expect(values.begin).not.toHaveBeenCalled();
  });
  it("rejects a stale policy without recording consent or dispatching", async () => {
    const values = fixture();
    await expect(
      values.service.submit(
        { ...input, policyVersion: "old-policy" },
        authorization,
      ),
    ).rejects.toMatchObject({ code: "RECEIVING_SETUP_POLICY_CHANGED" });
    expect(values.repository.consent).not.toHaveBeenCalled();
    expect(values.begin).not.toHaveBeenCalled();
  });
  it("does not repeat successful provisioning", async () => {
    const values = fixture();
    values.repository.readAccount.mockResolvedValueOnce({
      state: "SUCCEEDED",
      operatorUserId: actor.userId,
    } as never);
    expect(await values.service.submit(input, authorization)).toEqual({
      state: "STORED",
    });
    expect(values.nominate).not.toHaveBeenCalled();
    expect(values.begin).not.toHaveBeenCalled();
  });
});
