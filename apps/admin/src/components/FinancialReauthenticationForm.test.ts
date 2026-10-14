import type { SiteAccess } from "@entrelacos/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  FinancialReauthenticationForm,
  FinancialReauthenticationView,
  mountFinancialReauthenticationController,
  submitFinancialPassword,
} from "./FinancialReauthenticationForm";
import type {
  FinancialReauthenticationScope,
  FinancialReauthenticationState,
} from "./financialReauthenticationClient";

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
const scope: FinancialReauthenticationScope = {
  siteId: "wedding-a",
  access,
  action: "CONFIGURE_RECEIVING",
  sessionEpoch: 1,
};
const now = Date.parse("2026-10-12T18:00:00.000Z");
const guard = {
  isCurrent: () => true,
  validate: async () => true,
  subscribeInvalidation: () => () => {},
};
function render(state: FinancialReauthenticationState, candidate = scope) {
  return renderToStaticMarkup(
    createElement(FinancialReauthenticationView, {
      scope: candidate,
      state,
      ready: true,
      now,
      onSubmit: vi.fn(),
    }),
  );
}
describe("financial password confirmation form", () => {
  it("does not mount a password action without the reviewed context guard", () => {
    const html = renderToStaticMarkup(
      createElement(FinancialReauthenticationForm, scope),
    );
    expect(html).not.toContain('name="password"');
    expect(html).toContain("restrito");
  });
  it("creates a working controller for StrictMode setup-cleanup-setup", async () => {
    const holder: Parameters<
      typeof mountFinancialReauthenticationController
    >[0] = { current: null };
    const request = vi.fn().mockResolvedValue({
      reauthenticationToken: `fr1.cHJvb2Y.${"A".repeat(43)}`,
      expiresAt: "2026-10-12T18:03:00.000Z",
    });
    const options = { request, now: () => now };
    const firstCleanup = mountFinancialReauthenticationController(
      holder,
      scope,
      vi.fn(),
      options,
    );
    firstCleanup();
    const secondCleanup = mountFinancialReauthenticationController(
      holder,
      scope,
      vi.fn(),
      options,
    );
    if (!holder.current) throw new Error("Expected active mounted controller");
    await holder.current.submit("dummy-password");
    expect(request).toHaveBeenCalledTimes(1);
    expect(holder.current.getState().status).toBe("verified");
    secondCleanup();
  });
  it("never lets obsolete cleanup dispose a replacement controller", async () => {
    const holder: Parameters<
      typeof mountFinancialReauthenticationController
    >[0] = { current: null };
    const request = vi.fn().mockResolvedValue({
      reauthenticationToken: `fr1.cHJvb2Y.${"A".repeat(43)}`,
      expiresAt: "2026-10-12T18:03:00.000Z",
    });
    const options = { request, now: () => now };
    const firstCleanup = mountFinancialReauthenticationController(
      holder,
      scope,
      vi.fn(),
      options,
    );
    const first = holder.current;
    const secondCleanup = mountFinancialReauthenticationController(
      holder,
      scope,
      vi.fn(),
      options,
    );
    expect(holder.current).not.toBe(first);
    firstCleanup();
    if (!holder.current) throw new Error("Expected replacement controller");
    await holder.current.submit("dummy-password");
    expect(request).toHaveBeenCalledTimes(1);
    secondCleanup();
    expect(holder.current).toBeNull();
  });
  it("requires current password and protected POST without rendering proof fields or operation actions", () => {
    const html = render({ status: "idle" });
    expect(html).toContain('method="post"');
    expect(html).toContain(
      'action="/api/v1/sites/wedding-a/financial-reauthentication"',
    );
    expect(html).toMatch(/autocomplete="current-password"/i);
    expect(html).toMatch(/maxlength="200"/i);
    expect(html).toContain('type="password"');
    expect(html).toContain("Confirmar senha");
    expect(html).toContain(
      "não altera o responsável financeiro nem movimenta valores",
    );
    expect(html).not.toMatch(
      /name="(?:token|reauthenticationToken|sessionId)"|fr1\.|<button[^>]*>(?:Solicitar saque|Configurar recebimento)/,
    );
  });
  it.each([
    ["CONFIGURE_RECEIVING", "Confirmação para configurar o recebimento"],
    ["REQUEST_WITHDRAWAL", "Confirmação para solicitar um saque"],
  ] as const)("clearly shows the %s confirmation purpose", (action, text) => {
    expect(render({ status: "idle" }, { ...scope, action })).toContain(text);
  });
  it.each([
    ["loading", "Confirmando sua senha"],
    ["error", "Não foi possível confirmar a senha"],
    ["unavailable", "Confirmação de senha indisponível"],
    ["expired", "Esta confirmação não está mais válida"],
    ["consumed", "Confirmação utilizada"],
    ["session_expired", "Sua sessão expirou"],
    ["rate_limited", "Muitas tentativas"],
    ["denied", "Acesso financeiro restrito"],
  ] as const)(
    "shows truthful %s state without asserting confirmation",
    (status, text) => {
      const html = render({ status });
      expect(html).toContain(text);
      expect(html).not.toContain("Senha confirmada para esta finalidade");
      if (status === "denied" || status === "session_expired")
        expect(html).not.toContain('name="password"');
    },
  );
  it("renders verified expiry without any raw token", () => {
    const html = render({
      status: "verified",
      expiresAt: "2026-10-12T18:03:00.000Z",
    });
    expect(html).toContain("Senha confirmada para esta finalidade");
    expect(html).toContain("15:03");
    expect(html).not.toContain("fr1.");
  });
  it.each(["invalid", "2026-10-12T17:59:00.000Z"])(
    "does not render confirmation with invalid or already expired dates",
    (expiresAt) => {
      const html = render({ status: "verified", expiresAt });
      expect(html).toContain("Esta confirmação não está mais válida");
      expect(html).not.toContain("Senha confirmada para esta finalidade");
    },
  );
  it.each([
    null,
    { ...access, siteId: "wedding-b" },
    { ...access, membershipRole: "OWNER" },
    { ...access, membershipRole: "SITE_ASSISTANT" },
  ])(
    "hides the password form and claimed proof for unauthorized access",
    (candidate) => {
      const html = render(
        { status: "verified", expiresAt: "2026-10-12T18:03:00.000Z" },
        { ...scope, access: candidate as SiteAccess | null },
      );
      expect(html).toContain("Acesso financeiro restrito");
      expect(html).not.toMatch(
        /name="password"|Senha confirmada|Confirmar senha/,
      );
    },
  );
  it("keeps the initial SSR password controls disabled before hydration", () => {
    const html = renderToStaticMarkup(
      createElement(FinancialReauthenticationForm, { ...scope, guard }),
    );
    expect(html).toMatch(/<input[^>]*disabled=""/);
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>Confirmar senha<\/button>/,
    );
    expect(html).not.toContain('value="dummy-password"');
  });
  it("remounts secret ownership on site, access, purpose or session changes", () => {
    const initial = FinancialReauthenticationForm({ ...scope, guard });
    for (const candidate of [
      {
        ...scope,
        siteId: "wedding-b",
        access: { ...access, siteId: "wedding-b" },
      },
      { ...scope, action: "REQUEST_WITHDRAWAL" as const },
      { ...scope, sessionEpoch: 2 },
      { ...scope, access: { ...access, userId: "admin-b" } },
    ])
      expect(
        FinancialReauthenticationForm({ ...candidate, guard }).key,
      ).not.toBe(initial.key);
  });
  it("clears the DOM password before waiting for server confirmation", async () => {
    const input = { value: "dummy-password" };
    let resolve!: () => void;
    const submit = vi.fn((password: string) => {
      expect(password).toBe("dummy-password");
      expect(input.value).toBe("");
      return new Promise<void>((yes) => {
        resolve = yes;
      });
    });
    const pending = submitFinancialPassword({ submit }, input);
    expect(input.value).toBe("");
    expect(submit).toHaveBeenCalledTimes(1);
    resolve();
    await pending;
  });
});
