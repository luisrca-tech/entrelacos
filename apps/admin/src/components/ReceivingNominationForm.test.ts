import type { SiteAccess } from "@entrelacos/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  mountReceivingNominationController,
  ReceivingNominationForm,
  ReceivingNominationView,
} from "./ReceivingNominationForm";
import type {
  ReceivingNominationScope,
  ReceivingNominationState,
} from "./receivingNominationClient";

const access: SiteAccess = {
  siteId: "wedding-a",
  userId: "admin-a",
  membershipId: "member-a",
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
const scope: ReceivingNominationScope = {
  siteId: "wedding-a",
  access,
  sessionEpoch: 1,
  requestId: "request-a",
  policyVersion: "server-policy-a",
};
const nomination = {
  siteId: scope.siteId,
  requestId: "request-a",
  state: "AWAITING_PROVIDER_VERIFICATION" as const,
  createdAt: "2026-10-12T18:00:00.000Z",
  mode: "sandbox" as const,
};
const token = `fr1.cHJvb2Y.${"A".repeat(43)}`;
const guard = {
  isCurrent: () => true,
  validate: async () => true,
  subscribeInvalidation: () => () => {},
};
function render(
  state: ReceivingNominationState,
  candidate = scope,
  confirmed = true,
  ready = true,
) {
  return renderToStaticMarkup(
    createElement(ReceivingNominationView, {
      scope: candidate,
      state,
      confirmed,
      ready,
      onConfirmChange: vi.fn(),
      onSubmit: vi.fn(),
    }),
  );
}
describe("unmounted receiving nomination form", () => {
  it("does not mount nomination or password actions without the reviewed context guard", () => {
    const html = renderToStaticMarkup(
      createElement(ReceivingNominationForm, scope),
    );
    expect(html).not.toContain('name="password"');
    expect(html).not.toContain("Confirmar minha indicação");
  });
  it("requires explicit self-indication and explains the pending verification boundary", () => {
    const html = render({ status: "idle", uncertain: false });
    expect(html).toContain(
      "Confirmo que estou me indicando como recebedor deste casamento",
    );
    expect(html).toContain("Confirmar minha indicação");
    expect(html).toContain('method="post"');
    expect(html).toContain("/api/v1/sites/wedding-a/receiving/nomination");
    expect(html).not.toMatch(
      /name="(reauthenticationToken|password|policyVersion|requestId)"/,
    );
    expect(html).not.toMatch(
      /conta aprovada|banco aprovado|READY|consentimento|transferir/i,
    );
  });
  it.each([
    [false, true],
    [true, false],
  ])(
    "keeps submit disabled without confirmation/hydration: %s/%s",
    (confirmed, ready) => {
      const html = render(
        { status: "idle", uncertain: false },
        scope,
        confirmed,
        ready,
      );
      expect(html).toMatch(
        /<button[^>]*disabled[^>]*>Confirmar minha indicação/,
      );
    },
  );
  it("does not expose a working nomination or password submit in initial SSR", () => {
    const html = renderToStaticMarkup(
      createElement(ReceivingNominationForm, { ...scope, guard }),
    );
    expect(html).toContain("Confirmar minha indicação");
    expect(html).toContain("Confirme sua senha");
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(1);
    expect(buttons.every((button) => /disabled/.test(button))).toBe(true);
  });
  it.each([
    "loading",
    "unavailable",
    "reauthentication_required",
    "unknown",
    "session_expired",
    "denied",
  ] as const)(
    "presents sanitized %s independently of an empty or successful nomination",
    (status) => {
      const html = render({ status, uncertain: status === "unknown" });
      expect(html).toMatch(/role="(status|alert)"/);
      expect(html).not.toContain("Indicação registrada");
      expect(html).not.toContain("private-provider");
      if (status === "loading")
        expect(html).toContain("Registrando sua indicação");
      if (status === "unavailable")
        expect(html).toContain("Indicação indisponível");
      if (status === "reauthentication_required")
        expect(html).toContain("Confirme sua senha novamente");
      if (status === "unknown")
        expect(html).toContain("Não foi possível verificar o resultado");
      if (status === "session_expired" || status === "denied")
        expect(html).not.toContain("Confirmar minha indicação");
    },
  );
  it("keeps prior uncertainty visible when the service becomes unavailable", () => {
    const html = render({ status: "unavailable", uncertain: true });
    expect(html).toContain("Não foi possível verificar o resultado");
    expect(html).toContain("Verificar esta indicação");
    expect(html).not.toContain("Nenhuma indicação foi registrada");
  });
  it.each(["sandbox", "live"] as const)(
    "renders only provider-verification pending after %s nomination",
    (mode) => {
      const html = render({
        status: "pending",
        uncertain: false,
        nomination: { ...nomination, mode },
      });
      expect(html).toContain("Indicação registrada");
      expect(html).toContain("Verificação do provedor pendente");
      expect(html).toContain(
        "Ainda não confirma a liberação para receber valores",
      );
      expect(html.includes("Ambiente de teste")).toBe(mode === "sandbox");
      expect(html).not.toContain("Confirmar minha indicação");
      expect(html).not.toContain(scope.requestId as string);
      expect(html).not.toContain(scope.policyVersion as string);
    },
  );
  it.each([
    { ...nomination, siteId: "wedding-b" },
    { ...nomination, requestId: "another-request" },
    { ...nomination, providerAccountId: "private-provider" },
  ])("never projects foreign/private pending response %j", (value) => {
    const html = render({
      status: "pending",
      uncertain: false,
      nomination: value,
    });
    expect(html).not.toContain("Indicação registrada");
    expect(html).not.toContain("private-provider");
    expect(html).toContain("Não foi possível verificar o resultado");
  });
  it.each([
    { sessionEpoch: null },
    { access: null },
    { siteId: "wedding-b" },
    { policyVersion: null },
    { requestId: null },
  ])(
    "cannot offer a nomination action with missing authoritative context %j",
    (extra) => {
      const html = render(
        { status: "idle", uncertain: false },
        { ...scope, ...extra },
      );
      expect(html).not.toContain("Confirmar minha indicação");
    },
  );
  it("recreates the nomination controller for StrictMode setup-cleanup-setup", async () => {
    const holder: Parameters<typeof mountReceivingNominationController>[0] = {
      current: null,
    };
    const request = vi.fn().mockResolvedValue({ nomination });
    const firstCleanup = mountReceivingNominationController(
      holder,
      scope,
      vi.fn(),
      { request },
    );
    firstCleanup();
    const nextCleanup = mountReceivingNominationController(
      holder,
      scope,
      vi.fn(),
      { request },
    );
    if (!holder.current) throw new Error("Expected mounted controller");
    await holder.current.submit(true, {
      scope: { ...scope, action: "CONFIGURE_RECEIVING" },
      consumeProof: () => token,
    });
    expect(holder.current.getState().status).toBe("pending");
    expect(request).toHaveBeenCalledTimes(1);
    nextCleanup();
  });
  it("does not dispose a replacement through an obsolete effect cleanup", async () => {
    const holder: Parameters<typeof mountReceivingNominationController>[0] = {
      current: null,
    };
    const request = vi.fn().mockResolvedValue({ nomination });
    const previousCleanup = mountReceivingNominationController(
      holder,
      scope,
      vi.fn(),
      { request },
    );
    const nextCleanup = mountReceivingNominationController(
      holder,
      scope,
      vi.fn(),
      { request },
    );
    previousCleanup();
    if (!holder.current) throw new Error("Expected current controller");
    await holder.current.submit(true, {
      scope: { ...scope, action: "CONFIGURE_RECEIVING" },
      consumeProof: () => token,
    });
    expect(holder.current.getState().status).toBe("pending");
    nextCleanup();
  });
});
