import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminSession: vi.fn(),
  resolveSiteAccess: vi.fn(),
  AdminSessionRequiredError: class extends Error {},
}));
vi.mock("./authHttp", () => ({
  requireAdminSession: mocks.requireAdminSession,
  AdminSessionRequiredError: mocks.AdminSessionRequiredError,
}));
vi.mock("./siteAccess", () => ({ resolveSiteAccess: mocks.resolveSiteAccess }));

import { FinancialReauthenticationError } from "./financialReauthentication";
import { ReceivingProviderRejectedError } from "./receivingSetup";
import { createReceivingSetupHttpRouter } from "./receivingSetupHttp";
import { ReceivingSetupError } from "./receivingSetupRepository";

const origin = "http://localhost:3000";
const access = {
  siteId: "site-one",
  userId: "bride-one",
  membershipRole: "SITE_ADMIN",
  membershipId: "membership-one",
  capabilities: { configureReceiving: true, readFinance: true },
};
const FRESH = `fr1.${"a".repeat(80)}.${"b".repeat(43)}`;
const STALE = `fr1.${"c".repeat(80)}.${"d".repeat(43)}`;
const passwordProof = {
  proofKind: "PASSWORD_REAUTHENTICATION",
  verification: "verified",
  provenance: "backend",
  authenticatedAt: new Date("2026-10-16T12:00:00.000Z"),
  expiresAt: new Date("2026-10-16T12:05:00.000Z"),
};
function fixture(clock?: () => Date) {
  const designate = vi.fn(async () => {}),
    read = vi.fn(),
    submit = vi.fn(async () => ({ state: "STORED" })),
    reconcile = vi.fn(
      async (_actor: unknown): Promise<unknown> => ({
        outcome: "RELEASED",
      }),
    ),
    readProof = vi.fn((actor: object, _action: string, token: string) => {
      if (token !== FRESH)
        throw new FinancialReauthenticationError(403, "RECENT_AUTH_REQUIRED");
      return { ...actor, ...passwordProof };
    });
  const verifyIncoming = vi.fn(async () => ({
    siteId: "site-one",
    mode: "sandbox" as const,
    state: "READY" as const,
    reason: null,
    observedAt: "2026-10-19T12:00:00Z",
    destinationVersion: 2,
    catalogEligible: true,
  }));
  const router = createReceivingSetupHttpRouter({
    auth: {} as never,
    db: {} as never,
    adminOrigin: origin,
    receivingSetup: {
      read,
      designate,
      submit,
      reconcile,
    } as never,
    receivingVerification: { verify: verifyIncoming },
    ...(clock ? { clock } : {}),
    financialReauthentication: { readProof } as never,
  });
  return {
    router,
    verifyIncoming,
    designate,
    read,
    submit,
    reconcile,
    readProof,
  };
}
function request(path = "setup", body?: unknown, suppliedOrigin = origin) {
  return new Request(
    `http://localhost:8080/v1/sites/site-one/receiving/${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: { origin: suppliedOrigin, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdminSession.mockResolvedValue({
    user: { id: "bride-one", role: "SITE_ADMIN" },
    session: { id: "session-one" },
  });
  mocks.resolveSiteAccess.mockResolvedValue(access);
});
describe("receiving setup HTTP boundary", () => {
  it("uses the real holder session and explicit consent for initial incoming-bank verification", async () => {
    const v = fixture();
    const response = await v.router.fetch(
      request("incoming-verification", {
        confirmIncomingAccount: true,
      }),
    );
    expect(response.status).toBe(200);
    expect(v.verifyIncoming).toHaveBeenCalledWith({
      userId: "bride-one",
      siteId: "site-one",
      sessionId: "session-one",
    });
  });
  it.each([
    {},
    { confirmIncomingAccount: false, reauthenticationToken: "proof" },
    {
      confirmIncomingAccount: true,
      reauthenticationToken: "proof",
      bankReference: "browser-chosen",
    },
  ])(
    "rejects missing consent or browser-selected incoming bank %#",
    async (input) => {
      const v = fixture();
      expect(
        (await v.router.fetch(request("incoming-verification", input))).status,
      ).toBe(400);
      expect(v.verifyIncoming).not.toHaveBeenCalled();
    },
  );

  it("accepts initial holder setup without a password/token service and passes only real actor/access", async () => {
    const v = fixture();
    const input = {
      policyVersion: "policy-v1",
      consentVersion: "pagarme-receiving-v2",
      confirmHolder: true,
      consentToProvider: true,
      declareHolderIdentity: true,
      account: {
        name: "Maria da Silva",
        email: "maria@example.test",
        cpf: "12345678909",
        mobilePhone: "21994647568",
        birthDate: "1990-04-12",
        monthlyIncomeCents: 500000,
        professionalOccupation: "Professora",
        address: {
          street: "Av. General Justo",
          streetNumber: "375",
          neighborhood: "Centro",
          city: "Rio de Janeiro",
          state: "RJ",
          zipCode: "20021130",
          referencePoint: "Ao lado da banca",
        },
        bankAccount: {
          bank: "341",
          branchNumber: "1234",
          accountNumber: "12345",
          accountCheckDigit: "6",
          holderName: "MARIA DA SILVA",
          type: "checking",
        },
      },
    };
    const response = await v.router.request(request("setup", input));
    expect(response.status).toBe(200);
    expect(v.submit).toHaveBeenCalledExactlyOnceWith(input, {
      actor: {
        userId: "bride-one",
        siteId: "site-one",
        sessionId: "session-one",
      },
      access,
    });
    expect(
      (
        await v.router.request(
          request("setup", {
            ...input,
            reauthenticationToken: "obsolete-proof",
          }),
        )
      ).status,
    ).toBe(400);
  });
  it.each([
    ["MARIA APARECIDA DOS SANTOS LI", 200],
    ["MARIA APARECIDA DOS SANTOS LIM", 400],
  ] as const)(
    "limits the bank holder name to 29 characters (%s)",
    async (holderName, status) => {
      const v = fixture();
      const response = await v.router.request(
        request("setup", {
          policyVersion: "policy-v1",
          consentVersion: "pagarme-receiving-v2",
          confirmHolder: true,
          consentToProvider: true,
          declareHolderIdentity: true,
          account: {
            name: "Maria Aparecida dos Santos Lima",
            email: "maria@example.test",
            cpf: "12345678909",
            mobilePhone: "21994647568",
            birthDate: "1990-04-12",
            monthlyIncomeCents: 500000,
            professionalOccupation: "Professora",
            address: {
              street: "Av. General Justo",
              streetNumber: "375",
              neighborhood: "Centro",
              city: "Rio de Janeiro",
              state: "RJ",
              zipCode: "20021130",
            },
            bankAccount: {
              bank: "341",
              branchNumber: "1234",
              accountNumber: "12345",
              accountCheckDigit: "6",
              holderName,
              type: "checking",
            },
          },
        }),
      );
      expect(response.status).toBe(status);
      expect(v.submit).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
    },
  );
  it.each(["OWNER", "SITE_ASSISTANT"])(
    "does not let %s submit initial holder consent",
    async (role) => {
      const v = fixture();
      mocks.requireAdminSession.mockResolvedValue({
        user: { id: "bride-one", role },
        session: { id: "session-one" },
      });
      expect((await v.router.request(request("setup", {}))).status).toBe(403);
      expect(v.submit).not.toHaveBeenCalled();
    },
  );
  it("rejects a missing current session before setup submission", async () => {
    const v = fixture();
    mocks.requireAdminSession.mockRejectedValue(
      new mocks.AdminSessionRequiredError(),
    );
    expect((await v.router.request(request("setup", {}))).status).toBe(401);
    expect(v.submit).not.toHaveBeenCalled();
  });
  it("denies a foreign origin before reading authentication or performing actions", async () => {
    const v = fixture();
    expect(
      (
        await v.router.request(
          request(
            "holder",
            { holderUserId: "bride-one" },
            "https://foreign.test",
          ),
        )
      ).status,
    ).toBe(403);
    expect(mocks.requireAdminSession).not.toHaveBeenCalled();
    expect(v.designate).not.toHaveBeenCalled();
  });
  it("requires a site administrator's fresh password proof before designating", async () => {
    const v = fixture();
    const response = await v.router.request(
      request("holder", { holderUserId: "bride-one" }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "RECENT_AUTH_REQUIRED",
    });
    expect(v.designate).not.toHaveBeenCalled();
  });
  it("rejects a forged or expired site administrator proof", async () => {
    const v = fixture();
    const response = await v.router.request(
      request("holder", {
        holderUserId: "bride-one",
        reauthenticationToken: STALE,
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "RECENT_AUTH_REQUIRED",
    });
    expect(v.designate).not.toHaveBeenCalled();
  });
  it("lets a site administrator with configureReceiving designate a holder", async () => {
    const v = fixture();
    const response = await v.router.request(
      request("holder", {
        holderUserId: "groom-one",
        reauthenticationToken: FRESH,
      }),
    );
    expect(response.status).toBe(204);
    const actor = {
      userId: "bride-one",
      siteId: "site-one",
      sessionId: "session-one",
    };
    expect(mocks.resolveSiteAccess).toHaveBeenCalledWith(
      {},
      { userId: "bride-one", platformRole: "SITE_ADMIN", siteId: "site-one" },
    );
    expect(v.readProof).toHaveBeenCalledWith(
      actor,
      "CONFIGURE_RECEIVING",
      FRESH,
    );
    expect(v.designate).toHaveBeenCalledExactlyOnceWith(actor, "groom-one", {
      recentAuth: { ...actor, ...passwordProof },
    });
  });
  it.each([
    ["an administrator of another site", "SITE_ADMIN", null],
    ["a revoked membership", "SITE_ADMIN", null],
    [
      "an assistant",
      "SITE_ASSISTANT",
      { ...access, membershipRole: "SITE_ASSISTANT" },
    ],
    [
      "an administrator without configureReceiving",
      "SITE_ADMIN",
      {
        ...access,
        capabilities: { ...access.capabilities, configureReceiving: false },
      },
    ],
    [
      "access resolved for another site",
      "SITE_ADMIN",
      { ...access, siteId: "site-two" },
    ],
    [
      "access resolved for another user",
      "SITE_ADMIN",
      { ...access, userId: "groom-one" },
    ],
  ])("denies holder designation to %s", async (_label, role, resolved) => {
    const v = fixture();
    mocks.requireAdminSession.mockResolvedValue({
      user: { id: "bride-one", role },
      session: { id: "session-one" },
    });
    mocks.resolveSiteAccess.mockResolvedValue(resolved);
    const response = await v.router.request(
      request("holder", {
        holderUserId: "bride-one",
        reauthenticationToken: FRESH,
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "MEMBERSHIP_DENIED" });
    expect(v.readProof).not.toHaveBeenCalled();
    expect(v.designate).not.toHaveBeenCalled();
  });
  it.each([
    [409, "RECEIVING_HOLDER_ALREADY_DESIGNATED"],
    [409, "RECEIVING_BINDING_EXISTS"],
    [403, "RECEIVING_HOLDER_REQUIRED"],
  ] as const)(
    "answers a site administrator's refused designation with %s %s",
    async (status, code) => {
      const v = fixture();
      v.designate.mockRejectedValueOnce(new ReceivingSetupError(status, code));
      const response = await v.router.request(
        request("holder", {
          holderUserId: "groom-one",
          reauthenticationToken: FRESH,
        }),
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
    },
  );
  it("keeps the owner designation without a password proof", async () => {
    const v = fixture();
    mocks.requireAdminSession.mockResolvedValue({
      user: { id: "owner-one", role: "OWNER" },
      session: { id: "owner-session" },
    });
    expect(
      (
        await v.router.request(
          request("holder", {
            holderUserId: "bride-one",
            reauthenticationToken: FRESH,
          }),
        )
      ).status,
    ).toBe(400);
    expect(v.readProof).not.toHaveBeenCalled();
    expect(mocks.resolveSiteAccess).not.toHaveBeenCalled();
    expect(v.designate).not.toHaveBeenCalled();
  });
  it("allows the owner to designate an explicit identity without consenting on her behalf", async () => {
    const v = fixture();
    mocks.requireAdminSession.mockResolvedValue({
      user: { id: "owner-one", role: "OWNER" },
      session: { id: "owner-session" },
    });
    expect(
      (await v.router.request(request("holder", { holderUserId: "bride-one" })))
        .status,
    ).toBe(204);
    expect(v.designate).toHaveBeenCalledWith(
      { userId: "owner-one", sessionId: "owner-session", siteId: "site-one" },
      "bride-one",
    );
    expect(v.submit).not.toHaveBeenCalled();
  });
  it("rejects unknown input fields before setup submission", async () => {
    const v = fixture();
    expect(
      (await v.router.request(request("setup", { apiKey: "private" }))).status,
    ).toBe(400);
    expect(v.submit).not.toHaveBeenCalled();
  });
  it("answers a definitive Pagar.me refusal with an owner-safe 422 problem", async () => {
    const v = fixture();
    v.submit.mockRejectedValueOnce(
      new ReceivingProviderRejectedError({
        message: "Recebedor inválido",
        fields: [
          {
            field: "register_information.birthdate",
            messages: ["must be dd/mm/yyyy"],
          },
        ],
      }),
    );
    const response = await v.router.request(
      request("setup", {
        policyVersion: "policy-v1",
        consentVersion: "pagarme-receiving-v2",
        confirmHolder: true,
        consentToProvider: true,
        declareHolderIdentity: true,
        account: {
          name: "Maria da Silva",
          email: "maria@example.test",
          cpf: "12345678909",
          mobilePhone: "21994647568",
          birthDate: "1990-04-12",
          monthlyIncomeCents: 500000,
          professionalOccupation: "Professora",
          address: {
            street: "Av. General Justo",
            streetNumber: "375",
            neighborhood: "Centro",
            city: "Rio de Janeiro",
            state: "RJ",
            zipCode: "20021130",
          },
          bankAccount: {
            bank: "341",
            branchNumber: "1234",
            accountNumber: "12345",
            accountCheckDigit: "6",
            holderName: "MARIA DA SILVA",
            type: "checking",
          },
        },
      }),
    );
    expect(response.status).toBe(422);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      type: "about:blank",
      title: "Receiving setup unavailable",
      status: 422,
      code: "RECEIVING_PROVIDER_REJECTED",
      provider: {
        message: "Recebedor inválido",
        fields: [
          {
            field: "register_information.birthdate",
            messages: ["must be dd/mm/yyyy"],
          },
        ],
      },
    });
  });
  it("sanitizes unexpected provider failures", async () => {
    const v = fixture();
    v.read.mockRejectedValue(new Error("private database password"));
    const response = await v.router.request(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private database password");
  });
  it("rejects query-string capabilities", async () => {
    const v = fixture();
    const request = new Request(
      "http://localhost:8080/v1/sites/site-one/receiving/setup?token=secret",
      { headers: { origin } },
    );
    expect((await v.router.request(request)).status).toBe(400);
    expect(v.read).not.toHaveBeenCalled();
  });
});

describe("verifying an uncertain receiving setup over HTTP", () => {
  it.each([
    [{ outcome: "RELEASED" }, 200],
    [{ outcome: "STORED" }, 200],
    [{ outcome: "UNKNOWN", reason: "PROVIDER_UNREACHABLE" }, 202],
  ])(
    "answers the holder's verification %o with %s and no store",
    async (outcome, status) => {
      const v = fixture();
      v.reconcile.mockResolvedValueOnce(outcome);
      const response = await v.router.request(
        request("setup/reconcile", { confirmReconcile: true }),
      );
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual(outcome);
      expect(v.reconcile).toHaveBeenCalledExactlyOnceWith({
        userId: "bride-one",
        sessionId: "session-one",
        siteId: "site-one",
      });
      expect(v.submit).not.toHaveBeenCalled();
    },
  );
  it.each([
    {},
    { confirmReconcile: false },
    { confirmReconcile: true, account: { cpf: "12345678909" } },
  ])("rejects an unconfirmed or extended verification %#", async (input) => {
    const v = fixture();
    expect(
      (await v.router.request(request("setup/reconcile", input))).status,
    ).toBe(400);
    expect(v.reconcile).not.toHaveBeenCalled();
  });
  it.each(["OWNER", "SITE_ASSISTANT"])(
    "does not let %s verify on the holder's behalf",
    async (role) => {
      const v = fixture();
      mocks.requireAdminSession.mockResolvedValue({
        user: { id: "bride-one", role },
        session: { id: "session-one" },
      });
      expect(
        (
          await v.router.request(
            request("setup/reconcile", { confirmReconcile: true }),
          )
        ).status,
      ).toBe(403);
      expect(v.reconcile).not.toHaveBeenCalled();
    },
  );
  it("denies an administrator without the receiving capability", async () => {
    const v = fixture();
    mocks.resolveSiteAccess.mockResolvedValue({
      ...access,
      capabilities: { ...access.capabilities, configureReceiving: false },
    });
    expect(
      (
        await v.router.request(
          request("setup/reconcile", { confirmReconcile: true }),
        )
      ).status,
    ).toBe(403);
    expect(v.reconcile).not.toHaveBeenCalled();
  });
  it("requires a session and a trusted origin", async () => {
    const v = fixture();
    expect(
      (
        await v.router.request(
          request(
            "setup/reconcile",
            { confirmReconcile: true },
            "https://foreign.test",
          ),
        )
      ).status,
    ).toBe(403);
    expect(mocks.requireAdminSession).not.toHaveBeenCalled();
    mocks.requireAdminSession.mockRejectedValue(
      new mocks.AdminSessionRequiredError(),
    );
    expect(
      (
        await v.router.request(
          request("setup/reconcile", { confirmReconcile: true }),
        )
      ).status,
    ).toBe(401);
    expect(v.reconcile).not.toHaveBeenCalled();
  });
  it("reports a holder or account refusal as its problem code", async () => {
    const v = fixture();
    v.reconcile.mockRejectedValueOnce(
      new ReceivingSetupError(409, "RECEIVING_ACCOUNT_REQUIRED"),
    );
    const response = await v.router.request(
      request("setup/reconcile", { confirmReconcile: true }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "RECEIVING_ACCOUNT_REQUIRED",
    });
  });
});
const setupInput = {
  policyVersion: "policy-v1",
  consentVersion: "pagarme-receiving-v2",
  confirmHolder: true,
  consentToProvider: true,
  declareHolderIdentity: true,
  account: {
    name: "Maria da Silva",
    email: "maria@example.test",
    cpf: "12345678909",
    mobilePhone: "21994647568",
    birthDate: "2008-04-12",
    monthlyIncomeCents: 500000,
    professionalOccupation: "Professora",
    address: {
      street: "Av. General Justo",
      streetNumber: "375",
      neighborhood: "Centro",
      city: "Rio de Janeiro",
      state: "RJ",
      zipCode: "20021130",
    },
    bankAccount: {
      bank: "341",
      branchNumber: "1234",
      accountNumber: "12345",
      accountCheckDigit: "6",
      holderName: "MARIA DA SILVA",
      type: "checking",
    },
  },
};
describe("receiving holder identity checks at the HTTP boundary", () => {
  const onDay = (day: string) => () => new Date(`${day}T12:00:00.000Z`);
  const withAccount = (patch: object) => ({
    ...setupInput,
    account: { ...setupInput.account, ...patch },
  });
  it.each([
    ["an invalid CPF", withAccount({ cpf: "12345678900" })],
    [
      "a holder one day before the 18th birthday",
      withAccount({ birthDate: "2008-04-13" }),
    ],
    [
      "a bank account under another document",
      withAccount({
        bankAccount: {
          ...setupInput.account.bankAccount,
          holderDocument: "52998224725",
        },
      }),
    ],
    [
      "no identity declaration",
      { ...setupInput, declareHolderIdentity: undefined },
    ],
    ["no consent version", { ...setupInput, consentVersion: undefined }],
    [
      "the pre-declaration consent version",
      { ...setupInput, consentVersion: "pagarme-receiving-v1" },
    ],
  ])("answers 400 to %s without submitting", async (_label, input) => {
    const v = fixture(onDay("2026-04-12"));
    const response = await v.router.request(request("setup", input));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(v.submit).not.toHaveBeenCalled();
  });
  it("accepts a holder on the 18th birthday", async () => {
    const v = fixture(onDay("2026-04-12"));
    const response = await v.router.request(request("setup", setupInput));
    expect(response.status).toBe(200);
    expect(v.submit).toHaveBeenCalledOnce();
  });
});
describe("retired Pagar.me identity verification link", () => {
  it("no longer serves the kyc-link route", async () => {
    const v = fixture();
    mocks.requireAdminSession.mockResolvedValue({
      user: { id: "owner-one", role: "OWNER" },
      session: { id: "owner-session" },
    });
    const response = await v.router.request(
      new Request(
        "http://localhost:8080/v1/owner/sites/site-one/receiving/kyc-link",
        { method: "POST", headers: { origin } },
      ),
    );
    expect(response.status).toBe(404);
    expect(mocks.requireAdminSession).not.toHaveBeenCalled();
  });
  it("no longer serves the Pix destination routes", async () => {
    const v = fixture();
    expect((await v.router.request(request("pix-destination"))).status).toBe(
      404,
    );
  });
});
