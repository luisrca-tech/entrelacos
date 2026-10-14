import type { ReceivingReadiness, SiteAccess } from "@entrelacos/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ReceivingStatusCard } from "./ReceivingStatusCard";

const allowedAccess: SiteAccess = {
  siteId: "wedding-a",
  userId: "user-a",
  membershipId: "membership-a",
  membershipRole: "SITE_ADMIN",
  capabilities: {
    manageInvitations: true,
    manageMessages: true,
    manageCatalog: true,
    manageTeam: true,
    readFinance: true,
    configureReceiving: true,
    requestWithdrawal: false,
  },
};

const ready: ReceivingReadiness = {
  siteId: "wedding-a",
  state: "READY",
  reason: null,
  observedAt: "2026-10-12T12:00:00.000Z",
  destinationVersion: 1,
  catalogEligible: true,
  mode: "live",
};

function readiness(overrides: Partial<ReceivingReadiness>): ReceivingReadiness {
  return {
    siteId: "wedding-a",
    state: "NOT_CONFIGURED",
    reason: "NOT_CONFIGURED",
    observedAt: null,
    destinationVersion: null,
    catalogEligible: false,
    mode: "disabled",
    ...overrides,
  };
}

function render(
  props: Partial<{
    siteId: string;
    readiness: ReceivingReadiness | null;
    access: SiteAccess | null;
    error: boolean;
    onRetry: () => void;
  }> = {},
) {
  return renderToStaticMarkup(
    createElement(ReceivingStatusCard, {
      siteId: "wedding-a",
      readiness: ready,
      access: allowedAccess,
      onRetry: vi.fn(),
      ...props,
    }),
  );
}

describe("receiving status card", () => {
  it("blocks missing, assistant, owner, cross-site, and incapable access", () => {
    const restrictedAccess: Array<SiteAccess | null> = [
      null,
      { ...allowedAccess, membershipRole: "SITE_ASSISTANT" },
      { ...allowedAccess, membershipRole: "OWNER" },
      { ...allowedAccess, siteId: "wedding-b" },
      {
        ...allowedAccess,
        capabilities: {
          ...allowedAccess.capabilities,
          configureReceiving: false,
        },
      },
    ];

    for (const access of restrictedAccess) {
      const html = render({ access });
      expect(html).toContain("Apenas o administrador do site pode consultar");
      expect(html).not.toContain("Recebimentos verificados");
      expect(html).not.toContain("Ambiente de testes");
      expect(html).not.toContain("<button");
      expect(html).not.toContain("<form");
      expect(html).not.toContain("<input");
      expect(html).not.toContain("<a ");
    }
  });

  it("shows loading and an authorized retry after a readiness error", () => {
    const loading = render({ readiness: null });
    expect(loading).toContain("Verificando os recebimentos");
    expect(loading).not.toContain("Recebimentos verificados");

    const failed = render({ readiness: null, error: true });
    expect(failed).toContain("Não foi possível verificar os recebimentos");
    expect(failed).toContain("Tentar novamente");
    expect(failed).not.toContain("Recebimentos verificados");
    expect(failed).not.toContain("<input");
  });

  it("keeps the disabled state pending and explains how to activate receiving", () => {
    const html = render({ readiness: readiness({}) });
    expect(html).toContain("Os recebimentos ainda não foram configurados");
    expect(html).toContain(
      "Para ativar, o recebedor e a conta de destino precisam ser verificados no fluxo do Asaas.",
    );
    expect(html).toContain(
      "A ativação ainda depende da habilitação dos recebimentos.",
    );
    expect(html).not.toContain("fluxo aprovado");
    expect(html).not.toContain("este cartão");
    expect(html).not.toContain("Configurar recebimentos");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("href=");
  });

  it("explains bank verification, stale evidence, and blocked receiving in Portuguese", () => {
    const cases = [
      [
        readiness({
          state: "BANK_VALIDATION_PENDING",
          reason: "BANK_VERIFICATION_REQUIRED",
        }),
        "A conta de destino ainda precisa ser verificada",
      ],
      [
        readiness({ state: "UNDER_REVIEW", reason: "EVIDENCE_STALE" }),
        "A verificação dos recebimentos precisa ser atualizada",
      ],
      [
        readiness({ state: "BLOCKED", reason: "ACCOUNT_BLOCKED" }),
        "Os recebimentos estão bloqueados",
      ],
    ] as const;

    for (const [projection, message] of cases) {
      const html = render({ readiness: projection });
      expect(html).toContain(message);
      expect(html).not.toContain("<form");
      expect(html).not.toContain("<input");
    }
  });

  it("rejects private fields, contradictory projections, and another site's readiness", () => {
    const privateProjection = {
      ...ready,
      accountNumber: "123456-7",
    } as ReceivingReadiness;
    const contradictoryProjection = {
      ...ready,
      reason: "BANK_VERIFICATION_REQUIRED",
    } as ReceivingReadiness;

    for (const projection of [
      privateProjection,
      contradictoryProjection,
      { ...ready, siteId: "wedding-b" },
    ]) {
      const html = render({ readiness: projection });
      expect(html).toContain(
        "Não foi possível confirmar o status dos recebimentos",
      );
      expect(html).not.toContain("Recebimentos verificados");
      expect(html).not.toContain("123456-7");
    }
  });

  it("shows verified status only for a valid live projection", () => {
    const html = render({ readiness: ready });
    expect(html).toContain("Recebimentos verificados");
    expect(html).toContain(
      "O cadastro e a conta de destino foram verificados para este casamento.",
    );
    expect(html).not.toContain("Ambiente de testes");
    expect(html).not.toContain("projeção de prontidão");
  });

  it("labels sandbox status without implying movement of real money", () => {
    const html = render({ readiness: { ...ready, mode: "sandbox" } });
    expect(html).toContain("Sandbox —");
    expect(html).toContain("Pronto no ambiente de testes");
    expect(html).not.toContain("Recebimentos verificados");
    expect(html).toContain("sem movimentação de dinheiro real");
    expect(html).not.toContain("fluxo aprovado");

    const pendingSandbox = render({
      readiness: readiness({
        state: "BANK_VALIDATION_PENDING",
        reason: "BANK_VERIFICATION_REQUIRED",
        mode: "sandbox",
      }),
    });
    expect(pendingSandbox).toContain("Sandbox —");
    expect(pendingSandbox).toContain("sem movimentação de dinheiro real");
    expect(pendingSandbox).not.toContain("Recebimentos verificados");
  });
});
