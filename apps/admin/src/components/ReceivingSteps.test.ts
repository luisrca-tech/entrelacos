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
  pixConsentRecorded: true,
  disclosure: receivingSetupDisclosure,
  accountState: "CREATED",
  providerStatus: {
    commercialInfo: "APPROVED",
    bankAccountInfo: "PENDING",
    documentation: "PENDING",
    general: "PENDING",
    commercialInfoExpired: false,
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
      feesChosen: false,
    }),
    feesChosen: false,
    incomingAvailable: true,
    onRetry: vi.fn(),
  };
}

describe("receiving guided track", () => {
  it("shows one next step, the five steps and the guide on the overview", () => {
    const html = renderToStaticMarkup(
      createElement(ReceivingOverviewTrack, { context: context() }),
    );
    expect(html).toContain("2 de 5 concluídas");
    expect(html).toContain("Próximo passo · Etapa 3 de 5");
    expect(html.match(/Próximo passo/g)).toHaveLength(1);
    expect(html).toContain('href="/sites/site-one/receiving/activation"');
    expect(html).toContain(
      'href="/sites/site-one/receiving/activation#duvidas"',
    );
    for (const label of ["Concluída", "Agora", "Pode fazer já"])
      expect(html).toContain(label);
    expect(html).toContain("Fazer agora");
    expect(html).toContain('href="/sites/site-one/receiving-guide"');
    expect(html).not.toContain("PENDING");
    expect(html).not.toContain("AWAITING_APPROVAL");
  });

  it("lets the couple advance steps 4 and 5 while Asaas reviews", () => {
    const html = renderToStaticMarkup(
      createElement(ReceivingOverviewTrack, {
        context: context({
          providerStatus: {
            ...(setup.providerStatus as NonNullable<
              ReceivingSetupContext["providerStatus"]
            >),
            general: "AWAITING_APPROVAL",
          },
        }),
      }),
    );
    expect(html).toContain("Próximo passo · Etapa 4 de 5");
    expect(html).toContain("Enquanto o Asaas analisa");
    expect(html).toContain("Em análise pelo Asaas");
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
