import {
  type ReceivingSetupContext,
  receivingSetupDisclosure,
} from "@entrelacos/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActivationStep,
  ReceivingOverviewTrack,
  type ReceivingStepsContext,
  supportMailto,
} from "./ReceivingSteps";
import { deriveReceivingTrack } from "./receivingTrack";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    hash,
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
        href: `${to
          .replace("$siteId", params?.siteId ?? "")
          .replace("$page", params?.page ?? "")}${hash ? `#${hash}` : ""}`,
      },
      children,
    ),
}));

beforeEach(() => vi.stubGlobal("__APP_ENV__", "development"));
const forbidden =
  /selfie|prova de vida|QR Code|link seguro|Verificar identidade/i;
afterEach(() => vi.unstubAllGlobals());

const setup: ReceivingSetupContext = {
  siteId: "site-one",
  mode: "sandbox",
  policyVersion: "policy-v1",
  holder: { userId: "holder-one", name: "Ana Souza" },
  isHolder: true,
  consentRecorded: true,
  disclosure: receivingSetupDisclosure,
  accountState: "CREATED",
  // Created and still being activated by Pagar.me.
  providerStatus: {
    recipientStatus: "affiliation",
    accountState: "UNDER_REVIEW",
    receivingEnabled: false,
    kycStatus: "pending",
    kycStatusReason: "in_analysis",
    observedAt: "2026-10-16T12:00:00.000Z",
  },
};
type Provider = NonNullable<ReceivingSetupContext["providerStatus"]>;
const observedAt = "2026-10-16T12:00:00.000Z";
const providers = {
  registration: {
    recipientStatus: "registration",
    accountState: "ONBOARDING",
    receivingEnabled: false,
    kycStatus: null,
    kycStatusReason: null,
    observedAt,
  },
  pending: {
    recipientStatus: "affiliation",
    accountState: "UNDER_REVIEW",
    receivingEnabled: false,
    kycStatus: "pending",
    kycStatusReason: "in_analysis",
    observedAt,
  },
  sent: {
    recipientStatus: "affiliation",
    accountState: "UNDER_REVIEW",
    receivingEnabled: false,
    kycStatus: "pending",
    kycStatusReason: "answered_waiting_analysis",
    observedAt,
  },
  documents: {
    recipientStatus: "affiliation",
    accountState: "UNDER_REVIEW",
    receivingEnabled: false,
    kycStatus: "partially_denied",
    kycStatusReason: "additional_documents_required",
    observedAt,
  },
  active: {
    recipientStatus: "active",
    accountState: "APPROVED",
    receivingEnabled: true,
    kycStatus: "approved",
    kycStatusReason: null,
    observedAt,
  },
  denied: {
    recipientStatus: "affiliation",
    accountState: "UNDER_REVIEW",
    receivingEnabled: false,
    kycStatus: "denied",
    kycStatusReason: "fully_denied",
    observedAt,
  },
  refused: {
    recipientStatus: "refused",
    accountState: "BLOCKED",
    receivingEnabled: false,
    kycStatus: null,
    kycStatusReason: null,
    observedAt,
  },
  blocked: {
    recipientStatus: "blocked",
    accountState: "BLOCKED",
    receivingEnabled: false,
    kycStatus: null,
    kycStatusReason: null,
    observedAt,
  },
  suspended: {
    recipientStatus: "suspended",
    accountState: "SUSPENDED",
    receivingEnabled: false,
    kycStatus: null,
    kycStatusReason: null,
    observedAt,
  },
} satisfies Record<string, Provider>;

function context(
  overrides: Partial<ReceivingSetupContext> = {},
): ReceivingStepsContext {
  const current = { ...setup, ...overrides };
  return {
    scope: { siteId: "site-one", access: null, sessionEpoch: 1 },
    setup: current,
    status: "ready",
    busy: false,
    owner: false,
    canSubmit: false,
    receivingReady: false,
    readiness: null,
    ...deriveReceivingTrack({
      holder: !!current.holder,
      accountState: current.accountState,
      provider: current.providerStatus,
      ready: false,
    }),
    incomingAvailable: true,
    onRetry: vi.fn(),
  };
}

describe("receiving guided track", () => {
  it("shows one next step, the four steps and the guide on the overview", () => {
    const html = renderToStaticMarkup(
      createElement(ReceivingOverviewTrack, { context: context() }),
    );
    expect(html).toContain("3 de 4 concluídas");
    expect(html).toContain("Próximo passo · Etapa 3 de 4");
    expect(html.match(/Próximo passo/g)).toHaveLength(1);
    expect(html).toContain('href="/sites/site-one/receiving/activation"');
    // The next-step card offers a single action; a second link to the same
    // step only duplicated it.
    expect(html).not.toContain("Como funciona esta etapa");
    expect(html).not.toContain(
      'href="/sites/site-one/receiving/activation#duvidas"',
    );
    for (const label of ["Concluída", "Em ativação na Pagar.me"])
      expect(html).toContain(label);
    expect(html).toContain('href="/sites/site-one/receiving-guide"');
    expect(html).not.toContain("PENDING");
    expect(html).not.toContain("ONBOARDING");
  });

  it.each([
    ["registration", providers.registration],
    ["affiliation with KYC pending", providers.pending],
    ["affiliation answered, waiting for analysis", providers.sent],
  ])(
    "explains the activation on the overview (%s)",
    (_label, providerStatus) => {
      const html = renderToStaticMarkup(
        createElement(ReceivingOverviewTrack, {
          context: context({ providerStatus }),
        }),
      );
      expect(html).toContain("Próximo passo · Etapa 3 de 4");
      expect(html).toContain("ativando a conta");
      expect(html).toContain("Em ativação na Pagar.me");
      expect(html).toContain(">Acompanhar ativação<");
      expect(html).not.toMatch(forbidden);
    },
  );

  it("sends an unexpected document request to support on the overview", () => {
    const html = renderToStaticMarkup(
      createElement(ReceivingOverviewTrack, {
        context: context({ providerStatus: providers.documents }),
      }),
    );
    expect(html).toContain("A Pagar.me pediu documentos");
    expect(html).toContain("suporte do EntreLaços");
    expect(html).toContain("Precisa de ajuste");
    expect(html).not.toMatch(forbidden);
  });

  it.each([
    ["KYC denied", providers.denied],
    ["recipient refused", providers.refused],
  ])(
    "sends a refused recipient to support on the overview (%s)",
    (_label, providerStatus) => {
      const html = renderToStaticMarkup(
        createElement(ReceivingOverviewTrack, {
          context: context({ providerStatus }),
        }),
      );
      expect(html).toContain("A Pagar.me recusou o cadastro");
      expect(html).toContain("suporte");
    },
  );

  it("follows the activation with its status and support, without an identity action", () => {
    const html = renderToStaticMarkup(
      createElement(ActivationStep, { context: context() }),
    );
    expect(supportMailto).toBe(
      "mailto:luisrcadev@gmail.com?subject=Ajuda%20com%20os%20recebimentos",
    );
    for (const task of ["Dados do casal", "Conta bancária", "Status da conta"])
      expect(html).toContain(task);
    expect(html).toContain("Etapa 3 de 4");
    expect(html).toContain("costuma ser rápida");
    expect(html).toContain("Em ativação");
    expect(html).toContain("Situação na Pagar.me");
    expect(html).toContain("Dúvidas desta etapa");
    expect(html).not.toMatch(forbidden);
    expect(html).not.toContain("kyc-link");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('role="alert"');
  });

  it.each([
    ["active", providers.active, "Feito", false],
    ["refused", providers.refused, "Precisa de ajuste", true],
    ["KYC denied", providers.denied, "Precisa de ajuste", true],
    ["blocked", providers.blocked, "Precisa de ajuste", true],
    ["suspended", providers.suspended, "Precisa de ajuste", true],
    ["documents requested", providers.documents, "Precisa de ajuste", true],
    ["activating", providers.registration, "Em ativação", false],
  ] as const)(
    "shows the %s account status on the activation step",
    (_label, providerStatus, badge, alert) => {
      const html = renderToStaticMarkup(
        createElement(ActivationStep, {
          context: context({ providerStatus }),
        }),
      );
      expect(html).toContain(badge);
      expect(html.includes('role="alert"')).toBe(alert);
      if (alert) expect(html).toContain(`href="${supportMailto}"`);
      expect(html).not.toMatch(forbidden);
      expect(html).not.toMatch(/href="https?:\/\/[^"]*pagar/i);
    },
  );

  it.each([
    ["blocked", providers.blocked],
    ["suspended", providers.suspended],
  ])("explains a %s recipient", (_label, providerStatus) => {
    const html = renderToStaticMarkup(
      createElement(ActivationStep, { context: context({ providerStatus }) }),
    );
    expect(html).toContain("A Pagar.me bloqueou ou suspendeu a conta.");
  });

  it("tells the couple to talk to Entrelaços support about an unexpected document request", () => {
    const html = renderToStaticMarkup(
      createElement(ActivationStep, {
        context: context({ providerStatus: providers.documents }),
      }),
    );
    expect(html).toContain("A Pagar.me pediu documentos");
    expect(html).toContain("Documentos pedidos, fale com o suporte");
    expect(html).toContain(`href="${supportMailto}"`);
    expect(html).toContain("Falar com o suporte do EntreLaços");
  });

  it("shows no identity action to the holder, another administrator or the owner", () => {
    for (const overrides of [
      {},
      { isHolder: false, holder: { userId: "other", name: "Pedro" } },
    ])
      for (const owner of [false, true]) {
        const html = renderToStaticMarkup(
          createElement(ActivationStep, {
            context: {
              ...context({ ...overrides, providerStatus: providers.documents }),
              owner,
            },
          }),
        );
        expect(html).not.toMatch(forbidden);
        expect(html).not.toContain("verifica a identidade");
      }
  });
});
