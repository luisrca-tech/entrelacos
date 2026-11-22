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
  // Pagar.me asked for the selfie and document: the only state with a link.
  providerStatus: {
    recipientStatus: "affiliation",
    accountState: "UNDER_REVIEW",
    receivingEnabled: false,
    kycStatus: "partially_denied",
    kycStatusReason: "additional_documents_required",
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
  verify: setup.providerStatus as Provider,
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
    for (const label of ["Concluída", "Agora"]) expect(html).toContain(label);
    expect(html).toContain('href="/sites/site-one/receiving-guide"');
    expect(html).not.toContain("PENDING");
    expect(html).not.toContain("ONBOARDING");
  });

  it.each([
    ["registration", providers.registration],
    ["affiliation with KYC pending", providers.pending],
  ])(
    "explains the Pagar.me initial analysis on the overview (%s)",
    (_label, providerStatus) => {
      const html = renderToStaticMarkup(
        createElement(ReceivingOverviewTrack, {
          context: context({ providerStatus }),
        }),
      );
      expect(html).toContain("Próximo passo · Etapa 3 de 4");
      expect(html).toContain("até 24 horas");
      expect(html).toContain("selfie");
      expect(html).toContain("Em análise pela Pagar.me");
      expect(html).toContain(">Acompanhar análise<");
    },
  );

  it("offers the identity check on the overview once Pagar.me asks for it", () => {
    const html = renderToStaticMarkup(
      createElement(ReceivingOverviewTrack, { context: context() }),
    );
    expect(html).toContain("A Pagar.me pediu a foto de um documento");
    expect(html).not.toContain("24 horas");
  });

  it("tells the overview the selfie is being analysed", () => {
    const html = renderToStaticMarkup(
      createElement(ReceivingOverviewTrack, {
        context: context({ providerStatus: providers.sent }),
      }),
    );
    expect(html).toContain("analisando o documento e a selfie");
    expect(html).not.toContain("24 horas");
  });

  it.each([
    ["KYC denied", providers.denied],
    ["recipient refused", providers.refused],
  ])(
    "sends a refused identity check to support on the overview (%s)",
    (_label, providerStatus) => {
      const html = renderToStaticMarkup(
        createElement(ReceivingOverviewTrack, {
          context: context({ providerStatus }),
        }),
      );
      expect(html).toContain("A Pagar.me recusou a verificação de identidade");
      expect(html).toContain("suporte");
    },
  );

  it("offers the Pagar.me identity check, its status and support", () => {
    const html = renderToStaticMarkup(
      createElement(ActivationStep, { context: context() }),
    );
    expect(supportMailto).toBe(
      "mailto:luisrcadev@gmail.com?subject=Ajuda%20com%20os%20recebimentos",
    );
    expect(html).toContain(`href="${supportMailto}"`);
    for (const task of [
      "Dados do recebedor",
      "Verificação de identidade",
      "Pronto para receber",
    ])
      expect(html).toContain(task);
    expect(html).toContain("Etapa 3 de 4");
    expect(html).toContain(">Verificar identidade<");
    expect(html).toContain("Aguardando documento e selfie");
    expect(html).toContain("Situação na Pagar.me");
    expect(html).toContain("Dúvidas desta etapa");
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('role="alert"');
  });

  it("derives the identity badge from the Pagar.me account state", () => {
    const status = (
      accountState: NonNullable<
        ReceivingSetupContext["providerStatus"]
      >["accountState"],
    ) =>
      renderToStaticMarkup(
        createElement(ActivationStep, {
          context: context({
            providerStatus: { ...providers.registration, accountState },
          }),
        }),
      );
    expect(status("UNDER_REVIEW")).toContain("Em análise");
    expect(status("UNDER_REVIEW")).not.toContain(">Verificar identidade<");
    expect(status("APPROVED")).toContain("Feito");
    for (const state of ["BLOCKED", "SUSPENDED"] as const) {
      const html = status(state);
      expect(html).toContain("Precisa de ajuste");
      expect(html).toContain("A Pagar.me bloqueou ou suspendeu o recebedor.");
    }
  });

  it.each([
    ["registration", providers.registration, false],
    ["affiliation with KYC pending", providers.pending, false],
    ["affiliation after the selfie", providers.sent, false],
    ["affiliation with KYC partially denied", providers.verify, true],
    ["active with KYC approved", providers.active, false],
    ["KYC denied", providers.denied, false],
    ["recipient refused", providers.refused, false],
  ] as const)(
    "offers the Verificar identidade button only when Pagar.me asks (%s)",
    (_label, providerStatus, offered) => {
      const html = renderToStaticMarkup(
        createElement(ActivationStep, {
          context: context({ providerStatus }),
        }),
      );
      expect(html.includes(">Verificar identidade<")).toBe(offered);
    },
  );

  it("explains the initial analysis on the identity step", () => {
    const html = renderToStaticMarkup(
      createElement(ActivationStep, {
        context: context({ providerStatus: providers.registration }),
      }),
    );
    expect(html).toContain("até 24 horas");
    expect(html).toContain("o botão Verificar identidade aparece aqui");
    expect(html).toContain("Em análise");
    expect(html).not.toContain('role="alert"');
  });

  it.each([
    ["KYC denied", providers.denied],
    ["recipient refused", providers.refused],
  ])(
    "blocks a refused identity check with support guidance (%s)",
    (_label, providerStatus) => {
      const html = renderToStaticMarkup(
        createElement(ActivationStep, {
          context: context({ providerStatus }),
        }),
      );
      expect(html).toContain("Precisa de ajuste");
      expect(html).toContain('role="alert"');
      expect(html).toContain("A Pagar.me recusou a verificação de identidade");
      expect(html).toContain(`href="${supportMailto}"`);
    },
  );

  it("leaves the identity check to the holder", () => {
    const html = renderToStaticMarkup(
      createElement(ActivationStep, {
        context: context({
          isHolder: false,
          holder: { userId: "other", name: "Pedro" },
        }),
      }),
    );
    expect(html).toContain("Somente Pedro verifica a identidade na Pagar.me.");
    expect(html).not.toContain(">Verificar identidade<");
  });

  it("lets the platform owner open the identity check for the holder", () => {
    const html = renderToStaticMarkup(
      createElement(ActivationStep, {
        context: {
          ...context({
            isHolder: false,
            holder: { userId: "other", name: "Pedro" },
          }),
          owner: true,
        },
      }),
    );
    expect(html).toContain("Verificar identidade");
  });
});
