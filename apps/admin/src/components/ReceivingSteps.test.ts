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
  providerStatus: {
    recipientStatus: "registration",
    accountState: "ONBOARDING",
    receivingEnabled: false,
    observedAt: "2026-10-16T12:00:00.000Z",
  },
};

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
      destinationSaved: false,
    }),
    incomingAvailable: true,
    onRetry: vi.fn(),
  };
}

describe("receiving guided track", () => {
  it("shows one next step, the five steps and the guide on the overview", () => {
    const html = renderToStaticMarkup(
      createElement(ReceivingOverviewTrack, { context: context() }),
    );
    expect(html).toContain("3 de 5 concluídas");
    expect(html).toContain("Próximo passo · Etapa 3 de 5");
    expect(html.match(/Próximo passo/g)).toHaveLength(1);
    expect(html).toContain('href="/sites/site-one/receiving/activation"');
    // The next-step card offers a single action; a second link to the same
    // step only duplicated it.
    expect(html).not.toContain("Como funciona esta etapa");
    expect(html).not.toContain(
      'href="/sites/site-one/receiving/activation#duvidas"',
    );
    for (const label of ["Concluída", "Agora", "Pode fazer já"])
      expect(html).toContain(label);
    expect(html).toContain("Fazer agora");
    expect(html).toContain('href="/sites/site-one/receiving-guide"');
    expect(html).not.toContain("PENDING");
    expect(html).not.toContain("ONBOARDING");
  });

  it("keeps account and fee information accessible while Pagar.me reviews", () => {
    const html = renderToStaticMarkup(
      createElement(ReceivingOverviewTrack, {
        context: context({
          providerStatus: {
            ...(setup.providerStatus as NonNullable<
              ReceivingSetupContext["providerStatus"]
            >),
            accountState: "UNDER_REVIEW",
          },
        }),
      }),
    );
    expect(html).toContain("Próximo passo · Etapa 4 de 5");
    expect(html).toContain("Enquanto a Pagar.me analisa");
    expect(html).toContain("Em análise pela Pagar.me");
  });

  it("offers the Asaas checklist, the missing e-mail help and support", () => {
    const html = renderToStaticMarkup(
      createElement(ActivationStep, { context: context() }),
    );
    expect(supportMailto).toBe(
      "mailto:luisrcadev@gmail.com?subject=Ajuda%20com%20a%20ativa%C3%A7%C3%A3o%20no%20Asaas",
    );
    expect(html).toContain(`href="${supportMailto}"`);
    for (const task of [
      "Criar sua senha",
      "Confirmar o celular",
      "Enviar documentos e selfie",
    ])
      expect(html).toContain(task);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Não recebi o e-mail do Asaas");
    expect(html).toContain("Dúvidas desta etapa");
    expect(html).toContain(
      'href="https://sandbox.asaas.com/login/auth?customerSignUpOriginChannel=HOME"',
    );
    expect(html).toContain("Verificação pendente");
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
            providerStatus: {
              ...(setup.providerStatus as NonNullable<
                ReceivingSetupContext["providerStatus"]
              >),
              accountState,
            },
          }),
        }),
      );
    expect(status("UNDER_REVIEW")).toContain("Em análise");
    expect(status("APPROVED")).toContain("Feito");
    for (const state of ["BLOCKED", "SUSPENDED"] as const) {
      const html = status(state);
      expect(html).toContain("Bloqueada");
      expect(html).toContain("A Pagar.me bloqueou ou suspendeu o recebedor.");
    }
  });

  it("keeps the Asaas tasks read-only for someone who is not the holder", () => {
    const html = renderToStaticMarkup(
      createElement(ActivationStep, {
        context: context({
          isHolder: false,
          holder: { userId: "other", name: "Pedro" },
        }),
      }),
    );
    expect(html).toContain("Somente Pedro conclui estas tarefas no Asaas.");
    expect(html).not.toContain("Não recebi o e-mail do Asaas");
    expect(html).toMatch(/type="checkbox"[^>]*disabled=""/);
  });
});
