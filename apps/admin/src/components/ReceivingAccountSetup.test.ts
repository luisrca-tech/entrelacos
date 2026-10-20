import {
  meResponseSchema,
  type ReceivingSetupContext,
  receivingSetupDisclosure,
  type SiteAccess,
} from "@entrelacos/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReceivingAccountSetupController,
  ReceivingAccountSetupView,
} from "./ReceivingAccountSetup";

beforeEach(() => vi.stubGlobal("__APP_ENV__", "development"));
afterEach(() => vi.unstubAllGlobals());

const access: SiteAccess = {
  siteId: "site-one",
  userId: "bride-one",
  membershipId: "membership-one",
  membershipRole: "SITE_ADMIN",
  capabilities: {
    configureReceiving: true,
    manageCatalog: true,
    manageInvitations: true,
    manageMessages: true,
    manageTeam: true,
    readFinance: true,
    requestWithdrawal: false,
  },
};
const setup: ReceivingSetupContext = {
  siteId: "site-one",
  mode: "sandbox",
  policyVersion: "policy-v1",
  holder: { userId: "bride-one", name: "Marina" },
  isHolder: true,
  consentRecorded: false,
  disclosure: receivingSetupDisclosure,
  accountState: "NOT_CREATED",
  providerStatus: null,
};
function fixture(initialSetup: ReceivingSetupContext = setup) {
  const actor = meResponseSchema.parse({
    user: {
      id: "bride-one",
      role: "SITE_ADMIN",
      name: "Marina",
      email: "bride@example.test",
    },
    session: { id: "session-one", expiresAt: "2026-10-19T12:00:00.000Z" },
    siteId: "site-one",
    memberships: [access],
  });
  let snapshot = { status: "verified", sessionEpoch: 1, actor };
  const listeners = new Set<() => void>();
  const owner = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reportFailure: vi.fn(),
    isSuspended: vi.fn(() => false),
  };
  const request = vi.fn(
    async (
      path: string,
      _options?: { method: string; body: unknown },
    ): Promise<unknown> =>
      path === "/v1/me" ? actor : { setup: initialSetup },
  );
  const change = vi.fn();
  const scope = { siteId: "site-one", access, sessionEpoch: 1 };
  const controller = createReceivingAccountSetupController(scope, change, {
    owner: owner as never,
    request,
    now: () => Date.parse("2026-10-16T12:00:00.000Z"),
  });
  return {
    controller,
    request,
    scope,
    owner,
    expire: () => {
      snapshot = { ...snapshot, sessionEpoch: 2 };
      for (const listener of listeners) listener();
    },
  };
}
describe("receiving account setup", () => {
  const createdSetup: ReceivingSetupContext = {
    ...setup,
    accountState: "CREATED",
    consentRecorded: true,
  };
  const readiness = {
    siteId: "site-one",
    state: "READY",
    reason: null,
    observedAt: "2026-10-16T12:00:00.000Z",
    destinationVersion: 1,
    catalogEligible: true,
    mode: "sandbox",
  } as const;
  it.each([
    ["development", "sandbox", true],
    ["production", "sandbox", false],
    ["development", "live", false],
    [undefined, "sandbox", false],
    ["staging", "sandbox", false],
  ] as const)(
    "limits incoming confirmation visibility and dispatch to development Sandbox (%s, %s)",
    async (environment, mode, allowed) => {
      vi.stubGlobal("__APP_ENV__", environment);
      const values = fixture({ ...createdSetup, mode });
      const original = values.request.getMockImplementation();
      values.request.mockImplementation(async (path, options) =>
        options?.method === "POST"
          ? { readiness: { ...readiness, mode } }
          : original?.(path, options),
      );
      await values.controller.refresh();
      const html = renderToStaticMarkup(
        createElement(ReceivingAccountSetupView, {
          scope: values.scope,
          state: values.controller.getState(),
          incomingGuard: values.controller.incomingGuard,
          onVerifyIncoming: vi.fn(),
        }),
      );
      expect(html.includes("Confirmar minha conta de recebimento")).toBe(
        allowed,
      );
      if (allowed) {
        const button = html.match(
          /<button[^>]*>Confirmar minha conta de recebimento<\/button>/,
        )?.[0];
        expect(button).toBeDefined();
        expect(button).not.toMatch(/\sdisabled(?:\s|=|>)/);
      }
      expect(html).toContain("Conta criada no Asaas");
      expect(html).toContain("Destino Pix para saques");
      await values.controller.verifyIncoming();
      expect(
        values.request.mock.calls.filter(
          ([, options]) => options?.method === "POST",
        ),
      ).toHaveLength(allowed ? 1 : 0);
      values.controller.dispose();
    },
  );
  it("confirms only the current holder's existing incoming account without a password or account selector", async () => {
    const values = fixture(createdSetup);
    const original = values.request.getMockImplementation();
    values.request.mockImplementation(async (path, options) =>
      options?.method === "POST" ? { readiness } : original?.(path, options),
    );
    await values.controller.refresh();
    expect(await values.controller.verifyIncoming()).toEqual(readiness);
    expect(values.request).toHaveBeenCalledWith("/v1/me");
    expect(values.request).toHaveBeenCalledWith(
      "/v1/sites/site-one/receiving/incoming-verification",
      { method: "POST", body: { confirmIncomingAccount: true } },
    );
    expect(values.controller.getState()).toMatchObject({
      status: "ready",
      setup: createdSetup,
    });
    values.controller.dispose();
  });
  it.each(["consent", "suspended", "holder", "not_created"])(
    "blocks incoming confirmation when %s is not current",
    async (blocked) => {
      const values = fixture({
        ...createdSetup,
        ...(blocked === "consent" ? { consentRecorded: false } : {}),
        ...(blocked === "holder"
          ? { isHolder: false, holder: { userId: "other", name: "Other" } }
          : {}),
        ...(blocked === "not_created"
          ? { accountState: "NOT_CREATED" as const }
          : {}),
      });
      await values.controller.refresh();
      if (blocked === "suspended")
        values.owner.isSuspended.mockReturnValue(true);
      await values.controller.verifyIncoming();
      expect(
        values.request.mock.calls.some(
          ([, options]) => options?.method === "POST",
        ),
      ).toBe(false);
      values.controller.dispose();
    },
  );
  it("rejects incoming readiness for a different site", async () => {
    const values = fixture(createdSetup);
    const original = values.request.getMockImplementation();
    values.request.mockImplementation(async (path, options) =>
      options?.method === "POST"
        ? { readiness: { ...readiness, siteId: "other-site" } }
        : original?.(path, options),
    );
    await values.controller.refresh();
    expect(await values.controller.verifyIncoming()).toBeUndefined();
    expect(values.controller.getState().status).toBe("unavailable");
    values.controller.dispose();
  });
  it.each([false, true])(
    "deduplicates an incoming confirmation and rejects obsolete completion (%s)",
    async (expired) => {
      const values = fixture(createdSetup);
      let resolve!: (value: unknown) => void;
      const pending = new Promise((yes) => {
        resolve = yes;
      });
      const original = values.request.getMockImplementation();
      values.request.mockImplementation(async (path, options) =>
        options?.method === "POST" ? pending : original?.(path, options),
      );
      await values.controller.refresh();
      const first = values.controller.verifyIncoming();
      expect(await values.controller.verifyIncoming()).toBeUndefined();
      await vi.waitFor(() =>
        expect(values.request).toHaveBeenCalledWith(
          "/v1/sites/site-one/receiving/incoming-verification",
          { method: "POST", body: { confirmIncomingAccount: true } },
        ),
      );
      if (expired) values.expire();
      resolve({ readiness });
      expect(await first).toEqual(expired ? undefined : readiness);
      expect(
        values.request.mock.calls.filter(
          ([, options]) => options?.method === "POST",
        ),
      ).toHaveLength(1);
      if (expired) expect(values.controller.getState().status).toBe("denied");
      values.controller.dispose();
    },
  );
  it("offers explicit incoming confirmation only to a consented designated holder", () => {
    const values = fixture(createdSetup);
    const props = {
      scope: values.scope,
      state: { status: "ready" as const, setup: createdSetup, message: null },
      incomingGuard: {
        isCurrent: () => true,
        validate: async () => true,
        subscribeInvalidation: () => () => {},
      },
      onVerifyIncoming: vi.fn(),
    };
    const holderHtml = renderToStaticMarkup(
      createElement(ReceivingAccountSetupView, props),
    );
    expect(holderHtml).toContain("Confirmar minha conta de recebimento");
    expect(holderHtml).not.toMatch(/type="password"|reauthenticationToken/);
    for (const overrides of [
      { platformOwner: true },
      {
        state: {
          ...props.state,
          setup: { ...createdSetup, consentRecorded: false },
        },
      },
      {
        state: { ...props.state, setup: { ...createdSetup, isHolder: false } },
      },
    ]) {
      const html = renderToStaticMarkup(
        createElement(ReceivingAccountSetupView, { ...props, ...overrides }),
      );
      expect(html).not.toContain("Confirmar minha conta de recebimento");
    }
    values.controller.dispose();
  });
  it("uses the conventional masculine holder labels in the registration form", async () => {
    const values = fixture();
    await values.controller.refresh();
    const html = renderToStaticMarkup(
      createElement(ReceivingAccountSetupView, {
        scope: values.scope,
        state: { status: "ready", setup, message: null },
        guard: values.controller.guard,
      }),
    );
    expect(html).toContain("Nome completo do titular");
    expect(html).toContain("E-mail do titular");
    expect(html).toContain("sou o titular designado");
    expect(html).not.toContain("da noiva");
    values.controller.dispose();
  });
  it("loads authoritative holder context and hides form from a planner", async () => {
    const values = fixture();
    await values.controller.refresh();
    expect(values.controller.getState()).toMatchObject({
      status: "ready",
      setup,
    });
    const html = renderToStaticMarkup(
      createElement(ReceivingAccountSetupView, {
        scope: values.scope,
        state: {
          status: "ready",
          setup: {
            ...setup,
            isHolder: false,
            holder: { userId: "other-bride", name: "Marina" },
          },
          message: null,
        },
        guard: values.controller.guard,
      }),
    );
    expect(html).toContain("Marina");
    expect(html).not.toContain('name="cpfCnpj"');
    values.controller.dispose();
  });
  it("discards a context that arrives after actor identity changed", async () => {
    const values = fixture();
    let resolve!: (value: unknown) => void;
    values.request.mockReturnValueOnce(
      new Promise((yes) => {
        resolve = yes;
      }),
    );
    const work = values.controller.refresh();
    values.expire();
    resolve({ setup });
    await work;
    expect(values.controller.getState()).toMatchObject({
      status: "denied",
      setup: null,
    });
    expect(values.controller.guard.isCurrent()).toBe(false);
    values.controller.dispose();
  });
  it("requires current server holder and session before submitting initial setup", async () => {
    const values = fixture();
    await values.controller.refresh();
    values.expire();
    await values.controller.submit({}, true);
    expect(
      values.request.mock.calls.every((call) => call[1]?.method !== "POST"),
    ).toBe(true);
    values.controller.dispose();
  });
  it("shows native rejected and expired status as actionable without claiming readiness", () => {
    const values = fixture();
    const html = renderToStaticMarkup(
      createElement(ReceivingAccountSetupView, {
        scope: values.scope,
        state: {
          status: "ready",
          setup: {
            ...setup,
            accountState: "CREATED",
            providerStatus: {
              commercialInfo: "REJECTED",
              bankAccountInfo: "PENDING",
              documentation: "PENDING",
              general: "PENDING",
              commercialInfoExpired: true,
              observedAt: "2026-10-16T12:00:00.000Z",
            },
          },
          message: null,
        },
      }),
    );
    expect(html).toContain("rejeitados");
    expect(html).toContain("expirados");
    expect(html).not.toContain("Pronto para receber");
    values.controller.dispose();
  });
  it("keeps access activation unconfirmed even when all registration checks are approved", async () => {
    const values = fixture({
      ...createdSetup,
      providerStatus: {
        commercialInfo: "APPROVED",
        bankAccountInfo: "APPROVED",
        documentation: "APPROVED",
        general: "APPROVED",
        commercialInfoExpired: false,
        observedAt: "2026-10-16T12:00:00.000Z",
      },
    });
    await values.controller.refresh();
    const html = renderToStaticMarkup(
      createElement(ReceivingAccountSetupView, {
        scope: values.scope,
        state: values.controller.getState(),
      }),
    );
    expect(html).toContain("Ativação e acesso ao Asaas");
    expect(html).toContain(
      "A ativação de acesso e o envio ou recebimento de e-mail não são consultados por este painel.",
    );
    expect(html).toContain("Se o Asaas exigir ativação por e-mail");
    expect(html).toContain("Em modalidades BaaS");
    expect(html).toContain("atualiza as verificações cadastrais do Asaas");
    expect(html).not.toMatch(/Reenviar|Ativação concluída|E-mail enviado/);
    expect(values.request).toHaveBeenCalledTimes(1);
    expect(values.request.mock.calls[0]?.[1]?.method).not.toBe("POST");
    values.controller.dispose();
  });
  it.each([
    ["development", "sandbox", true],
    ["production", "sandbox", false],
    ["development", "live", false],
    ["production", "live", false],
    ["test", "sandbox", false],
    [undefined, "sandbox", false],
  ] as const)(
    "limits redirected test-email guidance to development Sandbox (%s, %s)",
    (environment, mode, visible) => {
      vi.stubGlobal("__APP_ENV__", environment);
      const values = fixture();
      const html = renderToStaticMarkup(
        createElement(ReceivingAccountSetupView, {
          scope: values.scope,
          state: {
            status: "ready",
            setup: { ...createdSetup, mode },
            message: null,
          },
        }),
      );
      expect(html).toContain("Ativação e acesso ao Asaas");
      expect(html.includes("comunicações de teste são redirecionadas")).toBe(
        visible,
      );
      expect(html).toContain("Não foi possível consultar as verificações");
      expect(html).not.toContain("E-mail não enviado");
      expect(values.request).not.toHaveBeenCalled();
      values.controller.dispose();
    },
  );
  it.each(["NOT_CREATED", "PENDING", "UNKNOWN"] as const)(
    "does not imply an existing account can be activated while creation is %s",
    (accountState) => {
      const values = fixture();
      const html = renderToStaticMarkup(
        createElement(ReceivingAccountSetupView, {
          scope: values.scope,
          state: {
            status: "ready",
            setup: { ...setup, accountState },
            message: null,
          },
        }),
      );
      expect(html).not.toContain("Ativação e acesso ao Asaas");
      values.controller.dispose();
    },
  );
  it("hides registration after an uncertain original dispatch", () => {
    const values = fixture();
    const html = renderToStaticMarkup(
      createElement(ReceivingAccountSetupView, {
        scope: values.scope,
        state: {
          status: "ready",
          setup: { ...setup, accountState: "UNKNOWN" },
          message: null,
        },
      }),
    );
    expect(html).toContain("incerto");
    expect(html).not.toContain('name="cpfCnpj"');
    values.controller.dispose();
  });
  it("shows a named holder selection to an owner without a membership", () => {
    const html = renderToStaticMarkup(
      createElement(ReceivingAccountSetupView, {
        scope: { siteId: "site-one", access: null, sessionEpoch: 1 },
        platformOwner: true,
        state: {
          status: "ready",
          setup: {
            ...setup,
            holder: null,
            isHolder: false,
            holderCandidates: [
              {
                userId: "bride-one",
                name: "Marina",
                email: "marina@example.test",
              },
            ],
          },
          message: null,
        },
        onDesignate: vi.fn(),
      }),
    );
    expect(html).toContain("Marina");
    expect(html).toContain("marina@example.test");
    expect(html).not.toContain("ID da conta");
    expect(html).not.toContain('name="cpfCnpj"');
  });
  it("sends the validated initial setup after rechecking holder and policy without password confirmation", async () => {
    const values = fixture();
    const account = {
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
    };
    const original = values.request.getMockImplementation();
    values.request.mockImplementation(async (path, options) =>
      options?.method === "POST"
        ? { state: "STORED" }
        : original?.(path, options),
    );
    await values.controller.refresh();
    await values.controller.submit(account, true);
    expect(values.request).toHaveBeenCalledWith("/v1/me");
    expect(values.request).toHaveBeenCalledWith(
      "/v1/sites/site-one/receiving/setup",
      {
        method: "POST",
        body: {
          account,
          policyVersion: "policy-v1",
          consentVersion: receivingSetupDisclosure.version,
          confirmHolder: true,
          consentToAsaas: true,
        },
      },
    );
    values.controller.dispose();
  });
  it("can load owner setup without a site membership but cannot register as recipient", async () => {
    const captured = {
      status: "verified",
      sessionEpoch: 1,
      actor: {
        user: { id: "owner-one", role: "OWNER" },
        session: { id: "owner-session", expiresAt: "2026-10-19T12:00:00.000Z" },
      },
    };
    const request = vi.fn(async () => ({
      setup: {
        ...createdSetup,
        holder: { userId: "owner-one", name: "Owner" },
        isHolder: true,
      },
    }));
    const controller = createReceivingAccountSetupController(
      { siteId: "site-one", access: null, sessionEpoch: 1 },
      vi.fn(),
      {
        owner: {
          getSnapshot: () => captured,
          subscribe: () => () => {},
          reportFailure: vi.fn(),
        } as never,
        request,
        now: () => Date.parse("2026-10-16T12:00:00.000Z"),
      },
    );
    await controller.refresh();
    expect(controller.getState().status).toBe("ready");
    expect(controller.guard.isCurrent()).toBe(false);
    expect(controller.incomingGuard.isCurrent()).toBe(false);
    expect(await controller.verifyIncoming()).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
  it("never mounts recipient credentials or account submission for the platform OWNER", () => {
    const values = fixture();
    const html = renderToStaticMarkup(
      createElement(ReceivingAccountSetupView, {
        scope: { siteId: "site-one", access: null, sessionEpoch: 1 },
        platformOwner: true,
        state: { status: "ready", setup, message: null },
        guard: {
          isCurrent: () => true,
          validate: async () => true,
          subscribeInvalidation: () => () => {},
        },
      }),
    );
    expect(html).not.toMatch(
      /name="cpfCnpj"|type="password"|Enviar cadastro ao Asaas/,
    );
    values.controller.dispose();
  });
  it("renders an initially unchecked holder consent and account fields without a password form", () => {
    const values = fixture();
    const html = renderToStaticMarkup(
      createElement(ReceivingAccountSetupView, {
        scope: values.scope,
        state: { status: "ready", setup, message: null },
        guard: {
          isCurrent: () => true,
          validate: async () => true,
          subscribeInvalidation: () => () => {},
        },
        onSubmit: vi.fn(),
      }),
    );
    expect(html).toContain('name="cpfCnpj"');
    expect(html).toContain('name="consent"');
    expect(html).not.toMatch(/type="password"|senha|reauthenticationToken/);
    expect(html).not.toMatch(/name="consent"[^>]*checked/);
    values.controller.dispose();
  });
  it("does not submit without explicit consent or with invalid account fields", async () => {
    const values = fixture();
    await values.controller.refresh();
    await values.controller.submit({}, false);
    expect(values.request).toHaveBeenCalledTimes(1);
    await values.controller.submit({}, true);
    expect(
      values.request.mock.calls.every((call) => call[1]?.method !== "POST"),
    ).toBe(true);
    expect(values.controller.getState().message).toContain(
      "Confira os dados cadastrais",
    );
    values.controller.dispose();
  });
});
