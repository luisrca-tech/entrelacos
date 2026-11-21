import assert from "node:assert/strict";
import {
  meResponseSchema,
  type ReceivingSetupContext,
  receivingSetupDisclosure,
  type SiteAccess,
} from "@entrelacos/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/apiClient";
import {
  createReceivingAccountSetupController,
  ReceivingAccountSetupView,
} from "./ReceivingAccountSetup";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    hash: _hash,
    ...props
  }: {
    children: React.ReactNode;
    to: string;
    params?: { siteId?: string; page?: string };
    hash?: string;
  }) =>
    createElement(
      "a",
      {
        ...props,
        href: to
          .replace("$siteId", params?.siteId ?? "")
          .replace("$page", params?.page ?? ""),
      },
      children,
    ),
}));

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
  const approved = {
    recipientStatus: "active",
    accountState: "APPROVED",
    receivingEnabled: true,
    observedAt: "2026-10-16T12:00:00.000Z",
  } as const;
  it("retains the known account after a temporary incoming verification failure", async () => {
    const v = fixture(createdSetup);
    await v.controller.refresh();
    const original = v.request.getMockImplementation();
    assert(original);
    v.request.mockImplementation(async (path, options) => {
      if (path.endsWith("/incoming-verification"))
        throw new ApiError(503, "RECEIVING_VERIFICATION_UNAVAILABLE");
      return original(path, options);
    });
    await v.controller.verifyIncoming();
    expect(v.controller.getState()).toMatchObject({
      status: "ready",
      setup: { accountState: "CREATED", consentRecorded: true },
    });
    expect(v.controller.getState().message).toContain(
      "configuração está salva",
    );
    v.controller.dispose();
  });
  it("still clears the account if the actor changes before a temporary failure returns", async () => {
    const v = fixture(createdSetup);
    await v.controller.refresh();
    const original = v.request.getMockImplementation();
    assert(original);
    let reject = (_error: Error) => {};
    v.request.mockImplementation((path, options) =>
      path.endsWith("/incoming-verification")
        ? new Promise((_resolve, no) => {
            reject = no;
          })
        : original(path, options),
    );
    const pending = v.controller.verifyIncoming();
    await vi.waitFor(() =>
      expect(
        v.request.mock.calls.some(([path]) =>
          path.endsWith("/incoming-verification"),
        ),
      ).toBe(true),
    );
    v.expire();
    reject(new ApiError(503, "RECEIVING_VERIFICATION_UNAVAILABLE"));
    await pending;
    expect(v.controller.getState()).toMatchObject({
      status: "denied",
      setup: null,
    });
    v.controller.dispose();
  });
  it.each([
    "UNVERIFIED",
    "ONBOARDING",
    "UNDER_REVIEW",
    "BLOCKED",
    "SUSPENDED",
  ] as const)(
    "does not prepare incoming payments while the Pagar.me account is %s",
    async (accountState) => {
      vi.stubGlobal("__APP_ENV__", "production");
      const v = fixture({
        ...createdSetup,
        mode: "live",
        providerStatus: { ...approved, accountState, receivingEnabled: false },
      });
      await v.controller.refresh();
      expect(
        v.request.mock.calls.some(([path]) =>
          path.endsWith("/incoming-verification"),
        ),
      ).toBe(false);
      const html = renderToStaticMarkup(
        createElement(ReceivingAccountSetupView, {
          scope: v.scope,
          state: v.controller.getState(),
          incomingGuard: v.controller.incomingGuard,
        }),
      );
      expect(html).not.toContain("Autorizar preparação automática do Pix");
      v.controller.dispose();
    },
  );
  it("keeps production registration free of Sandbox copy and without a separate Pix consent", async () => {
    vi.stubGlobal("__APP_ENV__", "production");
    const v = fixture({ ...setup, mode: "live" });
    await v.controller.refresh();
    const html = renderToStaticMarkup(
      createElement(ReceivingAccountSetupView, {
        scope: v.scope,
        state: v.controller.getState(),
        guard: v.controller.guard,
        section: "details",
      }),
    );
    expect(html).not.toContain("Sandbox");
    expect(html).not.toContain("operações são de teste");
    expect(html).not.toContain("Em teste, as operações");
    expect(html).toContain("Pagar.me");
    expect(html).not.toContain("chave Pix aleatória");
    v.controller.dispose();
  });
  it("automatically prepares an approved holder account after loading, without requiring a second setup action", async () => {
    vi.stubGlobal("__APP_ENV__", "production");
    const v = fixture({
      ...createdSetup,
      mode: "live",
      providerStatus: approved,
    });
    const original = v.request.getMockImplementation();
    assert(original);
    v.request.mockImplementation(async (path, options) =>
      path.endsWith("/incoming-verification")
        ? { readiness: { ...readiness, mode: "live" } }
        : original(path, options),
    );
    await v.controller.refresh();
    expect(
      v.request.mock.calls.filter(([path]) =>
        path.endsWith("/incoming-verification"),
      ),
    ).toEqual([
      [
        "/v1/sites/site-one/receiving/incoming-verification",
        { method: "POST", body: { confirmIncomingAccount: true } },
      ],
    ]);
    expect(v.controller.getState().status).toBe("ready");
    v.controller.dispose();
  });
  it("explains the review after identity verification without any Pix setup", () => {
    vi.stubGlobal("__APP_ENV__", "production");
    const v = fixture();
    const html = renderToStaticMarkup(
      createElement(ReceivingAccountSetupView, {
        scope: v.scope,
        state: {
          status: "ready",
          setup: { ...createdSetup, mode: "live", providerStatus: approved },
          message: null,
        },
      }),
    );
    expect(html).toContain("Depois: análise da Pagar.me");
    expect(html).not.toContain("chave Pix");
    expect(html).not.toContain("Confirmar minha conta de recebimento");
  });
  it("shows the live holder the identity check and the support contact", () => {
    vi.stubGlobal("__APP_ENV__", "production");
    const values = fixture();
    const html = renderToStaticMarkup(
      createElement(ReceivingAccountSetupView, {
        scope: values.scope,
        state: {
          status: "ready",
          setup: { ...createdSetup, mode: "live" },
          message: null,
        },
      }),
    );
    const visible = html.slice(0, html.indexOf('id="duvidas"'));
    expect(visible).toContain(">Verificar identidade<");
    expect(visible).toContain(
      'href="mailto:luisrcadev@gmail.com?subject=Ajuda%20com%20os%20recebimentos"',
    );
    const guidance = visible.slice(
      visible.indexOf('aria-label="Etapas na Pagar.me"'),
    );
    const steps = [
      "Dados do recebedor",
      "Verificação de identidade",
      "Pronto para receber",
      "Verificar identidade",
      "Depois: análise da Pagar.me",
    ];
    const positions = steps.map((step) => guidance.indexOf(step));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(
      positions.every(
        (position, index) => index === 0 || position > positions[index - 1],
      ),
    ).toBe(true);
    expect(guidance).toContain("Foto do documento e selfie");
    expect(html).not.toContain('autocomplete="one-time-code"');
    expect(html).not.toContain("Sandbox");
    expect(html).not.toContain("teste da Pagar.me");
    expect(values.request).not.toHaveBeenCalled();
    values.controller.dispose();
  });

  it.each(["other-holder", "ready", "uncreated", "review"])(
    "does not offer the identity check for %s",
    (scenario) => {
      vi.stubGlobal("__APP_ENV__", "production");
      const values = fixture();
      const html = renderToStaticMarkup(
        createElement(ReceivingAccountSetupView, {
          scope: values.scope,
          state: {
            status: "ready",
            setup: {
              ...createdSetup,
              mode: "live",
              isHolder: scenario !== "other-holder",
              accountState:
                scenario === "uncreated" ? "NOT_CREATED" : "CREATED",
              providerStatus:
                scenario === "uncreated"
                  ? null
                  : scenario === "review"
                    ? {
                        ...(createdSetup.providerStatus as NonNullable<
                          ReceivingSetupContext["providerStatus"]
                        >),
                        accountState: "UNDER_REVIEW",
                      }
                    : createdSetup.providerStatus,
            },
            message: null,
          },
          readiness:
            scenario === "ready" ? { ...readiness, mode: "live" } : null,
        }),
      );
      expect(html).not.toContain(">Verificar identidade<");
      values.controller.dispose();
    },
  );
  it.each([
    ["development", "sandbox", true],
    ["production", "live", true],
    ["production", "sandbox", false],
    ["development", "live", false],
    [undefined, "sandbox", false],
    ["staging", "sandbox", false],
  ] as const)(
    "limits incoming confirmation to supported matching application and provider environments (%s, %s)",
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
      expect(html.includes("Atualizar liberação dos recebimentos")).toBe(
        allowed,
      );
      if (allowed) {
        const button = html.match(
          /<button[^>]*>Atualizar liberação dos recebimentos<\/button>/,
        )?.[0];
        expect(button).toBeDefined();
        expect(button).not.toMatch(/\sdisabled(?:\s|=|>)/);
      }
      expect(html).toContain("Verifique sua identidade");
      expect(html).not.toContain("Destino Pix para saques");
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
    expect(holderHtml).toContain("Atualizar liberação dos recebimentos");
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
      expect(html).not.toContain("Atualizar liberação dos recebimentos");
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
        section: "details",
      }),
    );
    expect(html).toContain("Nome completo do titular");
    expect(html).toContain("E-mail do titular");
    expect(html).toContain("sou o titular designado");
    expect(html).not.toContain("da noiva");
    values.controller.dispose();
  });
  it("explains mandatory live account activation and documents before the first registration submit", async () => {
    vi.stubGlobal("__APP_ENV__", "production");
    const values = fixture({ ...setup, mode: "live" });
    await values.controller.refresh();
    const html = renderToStaticMarkup(
      createElement(ReceivingAccountSetupView, {
        scope: values.scope,
        state: values.controller.getState(),
        guard: values.controller.guard,
        onSubmit: vi.fn(),
        section: "details",
      }),
    );
    const afterForm = html.slice(html.indexOf("</form>"));
    expect(afterForm).toContain("O que vem depois");
    expect(afterForm).toContain("Verificação de identidade");
    expect(afterForm).toContain("documento e selfie");
    expect(afterForm).toContain("Análise da Pagar.me");
    expect(afterForm).toContain("Seus dados ficam seguros");
    expect(html).toContain("Enviar cadastro à Pagar.me");
    expect(html).toContain("Ler o termo completo");
    expect(html).toContain(
      receivingSetupDisclosure.text.split(" Em teste,")[0],
    );
    expect(html).not.toContain("Em teste, as operações");
    expect(
      values.request.mock.calls.some(
        ([, options]) => options?.method === "POST",
      ),
    ).toBe(false);
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
        section: "details",
      }),
    );
    expect(html).toContain("Marina");
    expect(html).not.toContain('name="cpf"');
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
  it("shows activation complete only for current authoritative readiness", () => {
    const values = fixture(createdSetup);
    const render = (current: unknown) =>
      renderToStaticMarkup(
        createElement(ReceivingAccountSetupView, {
          scope: values.scope,
          state: { status: "ready", setup: createdSetup, message: null },
          readiness: current as typeof readiness,
          incomingGuard: values.controller.incomingGuard,
        }),
      );
    const html = render(readiness);
    expect(html).toContain("Recebimentos liberados");
    expect(html).not.toContain("Atualizar liberação dos recebimentos");
    expect(html).not.toContain("A criação não confirma liberação");
    for (const other of [
      null,
      { ...readiness, siteId: "another-site" },
      { ...readiness, mode: "live" },
    ])
      expect(render(other)).not.toContain("Recebimentos liberados");
    values.controller.dispose();
  });
  it.each(["BLOCKED", "SUSPENDED"] as const)(
    "shows a %s Pagar.me recipient as actionable without claiming readiness",
    (accountState) => {
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
                recipientStatus: "blocked",
                accountState,
                receivingEnabled: false,
                observedAt: "2026-10-16T12:00:00.000Z",
              },
            },
            message: null,
          },
        }),
      );
      expect(html).toContain("A Pagar.me bloqueou ou suspendeu o recebedor.");
      expect(html).toContain("Precisa de ajuste</span>");
      expect(html).not.toContain("Recebimentos liberados");
      values.controller.dispose();
    },
  );
  it.each([
    ["UNVERIFIED", "A fazer"],
    ["ONBOARDING", "A fazer"],
    ["UNDER_REVIEW", "Em análise"],
  ] as const)(
    "shows %s without implying an unsubmitted account is under review",
    (accountState, label) => {
      const values = fixture();
      const html = renderToStaticMarkup(
        createElement(ReceivingAccountSetupView, {
          scope: values.scope,
          state: {
            status: "ready",
            setup: {
              ...createdSetup,
              providerStatus: {
                recipientStatus: "registration",
                accountState,
                receivingEnabled: false,
                observedAt: "2026-10-16T12:00:00.000Z",
              },
            },
            message: null,
          },
        }),
      );
      expect(html).toContain(`${label}</span>`);
      if (accountState !== "UNDER_REVIEW")
        expect(html).not.toContain("Em análise");
      values.controller.dispose();
    },
  );
  it("reports an approved Pagar.me recipient without offering another identity check", async () => {
    const values = fixture({
      ...createdSetup,
      providerStatus: {
        recipientStatus: "active",
        accountState: "APPROVED",
        receivingEnabled: true,
        observedAt: "2026-10-16T12:00:00.000Z",
      },
    });
    await values.controller.refresh(false);
    const html = renderToStaticMarkup(
      createElement(ReceivingAccountSetupView, {
        scope: values.scope,
        state: values.controller.getState(),
      }),
    );
    expect(html).toContain("Como o painel acompanha a análise?");
    expect(html).toContain("Verificar agora consulta a situação na hora.");
    expect(html).toContain("Recebedor: <strong>Ativo</strong>");
    expect(html).not.toContain(">Verificar identidade<");
    expect(html).not.toMatch(/Reenviar|senha de acesso|E-mail enviado/);
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
    "limits the test-environment guidance to development Sandbox (%s, %s)",
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
      expect(html).toContain("Como o painel acompanha a análise?");
      expect(html.includes("a verificação não analisa documentos reais")).toBe(
        visible,
      );
      expect(html.includes("Ambiente de teste da Pagar.me")).toBe(visible);
      expect(html).toContain("Ainda sem resposta da Pagar.me");
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
      expect(html).not.toContain('aria-label="Etapas na Pagar.me"');
      expect(html).not.toContain(">Verificar identidade<");
      expect(html).toContain("Primeiro, envie seus dados na etapa 2");
      values.controller.dispose();
    },
  );
  it("lets the holder resend after an uncertain dispatch, which Pagar.me is consulted for first", () => {
    const values = fixture();
    const html = renderToStaticMarkup(
      createElement(ReceivingAccountSetupView, {
        scope: values.scope,
        state: {
          status: "ready",
          setup: { ...setup, accountState: "UNKNOWN" },
          message: null,
          rejection: null,
        },
        guard: { isCurrent: () => true } as never,
        onSubmit: vi.fn(),
        section: "details",
      }),
    );
    expect(html).toContain("incerto");
    expect(html).toContain("consultamos a Pagar.me");
    expect(html).toContain('name="cpf"');
    values.controller.dispose();
  });
  it("shows a Pagar.me refusal with the fields to fix and keeps the form", async () => {
    const values = fixture();
    const original = values.request.getMockImplementation();
    values.request.mockImplementation(async (path, options) => {
      if (options?.method === "POST")
        throw new ApiError(422, "RECEIVING_PROVIDER_REJECTED", {
          code: "RECEIVING_PROVIDER_REJECTED",
          provider: {
            message: "Recebedor inválido",
            fields: [
              {
                field: "register_information.birthdate",
                messages: ["must be dd/mm/yyyy"],
              },
              { field: "default_bank_account.account_number", messages: [] },
            ],
          },
        });
      return original?.(path, options);
    });
    await values.controller.refresh();
    const outcome = await values.controller.submit(
      {
        name: "Fictional Person",
        email: "person@example.test",
        cpf: "12345678909",
        mobilePhone: "11999999999",
        birthDate: "1990-01-01",
        monthlyIncomeCents: 100000,
        professionalOccupation: "Engineer",
        address: {
          street: "Fictional Road",
          streetNumber: "1",
          neighborhood: "District",
          city: "Fictional City",
          state: "SP",
          zipCode: "12345678",
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
      true,
    );
    expect(outcome).toBe("rejected");
    const state = values.controller.getState();
    expect(state.status).toBe("ready");
    expect(state.message).toContain("A Pagar.me recusou o cadastro");
    expect(state.rejection).toEqual({
      message:
        "A Pagar.me recusou um dado do cadastro. Confira os dados e envie de novo. Detalhe da Pagar.me: Recebedor inválido",
      fields: [
        {
          field: "register_information.birthdate",
          label: "Data de nascimento",
          formField: "birthDate",
          messages: [
            "use uma data válida; o titular precisa ter 18 anos ou mais.",
          ],
        },
        {
          field: "default_bank_account.account_number",
          label: "Conta com dígito",
          formField: "account",
          messages: [],
        },
      ],
      formFields: ["birthDate", "account"],
    });
    expect(values.owner.reportFailure).not.toHaveBeenCalled();
    const html = renderToStaticMarkup(
      createElement(ReceivingAccountSetupView, {
        scope: values.scope,
        state: { ...state, setup: { ...setup, accountState: "PENDING" } },
        guard: { isCurrent: () => true } as never,
        onSubmit: vi.fn(),
        section: "details",
      }),
    );
    expect(html).toContain("A Pagar.me recusou o cadastro");
    expect(html).toContain("Data de nascimento");
    expect(html).toContain(
      "use uma data válida; o titular precisa ter 18 anos ou mais.",
    );
    expect(html).toContain("Detalhe da Pagar.me: Recebedor inválido");
    expect(html).toContain('name="cpf"');
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
        section: "holder",
      }),
    );
    expect(html).toContain("Marina");
    expect(html).toContain("marina@example.test");
    expect(html).not.toContain("ID da conta");
    expect(html).not.toContain('name="cpf"');
  });
  it("sends the validated initial setup after rechecking holder and policy without password confirmation", async () => {
    const values = fixture();
    const account = {
      name: "Fictional Person",
      email: "person@example.test",
      cpf: "12345678909",
      mobilePhone: "11999999999",
      birthDate: "1990-01-01",
      monthlyIncomeCents: 100000,
      professionalOccupation: "Engineer",
      address: {
        street: "Fictional Road",
        streetNumber: "1",
        neighborhood: "District",
        city: "Fictional City",
        state: "SP",
        zipCode: "12345678",
        referencePoint: "Near the park",
      },
      bankAccount: {
        bank: "341",
        branchNumber: "1234",
        accountNumber: "12345",
        accountCheckDigit: "6",
        holderName: "MARIA DA SILVA",
        type: "checking",
      },
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
          consentToProvider: true,
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
      /name="cpf"|type="password"|Enviar cadastro à Pagar.me/,
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
        section: "details",
      }),
    );
    for (const field of [
      "cpf",
      "monthlyIncome",
      "professionalOccupation",
      "street",
      "streetNumber",
      "complement",
      "neighborhood",
      "city",
      "state",
      "zipCode",
      "referencePoint",
      "bank",
      "branch",
      "account",
      "accountType",
    ])
      expect(html).toContain(`name="${field}"`);
    expect(html).not.toMatch(
      /name="(branchNumber|branchCheckDigit|accountNumber|accountCheckDigit)"/,
    );
    expect(html).toMatch(/<select[^>]*name="accountType"/);
    expect(html).toMatch(/<select[^>]*name="bank"/);
    expect(html).toContain('<option value="260">Nubank (260)</option>');
    expect(html).toContain('<option value="other">Outro banco</option>');
    // The free-text code only appears after choosing "Outro banco".
    expect(html).not.toContain('name="bankCode"');
    expect(html).toContain("Conta com dígito");
    expect(html).toMatch(/aria-live="polite"/);
    expect(html).toMatch(/name="complement"(?![^>]*required)[^>]*>/);
    expect(html).toMatch(/name="referencePoint"(?![^>]*required)[^>]*>/);
    expect(html).toContain("Ponto de referência (opcional)");
    expect(html).toContain('name="consent"');
    expect(html.match(/type="checkbox"/g)).toHaveLength(1);
    // No provider password exists: the form never asks for one.
    expect(html).not.toMatch(
      /type="password"|reauthenticationToken|Sua senha do EntreLaços/,
    );
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
