import type { ReceivingReadiness, SiteAccess } from "@entrelacos/contracts";
import { describe, expect, it } from "vitest";
import { buildSiteHomePlan } from "./siteHomePlan";

const access: SiteAccess = {
  siteId: "wedding-a",
  userId: "admin-a",
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
const site = {
  id: "wedding-a",
  lifecycle: "ACTIVE" as const,
  publicationState: "PUBLISHED" as const,
};
const pending: ReceivingReadiness = {
  siteId: site.id,
  state: "NOT_CONFIGURED",
  reason: "NOT_CONFIGURED",
  observedAt: null,
  destinationVersion: null,
  catalogEligible: false,
  mode: "sandbox",
};

describe("site home orientation", () => {
  it("offers a useful default without inventing receiving completion", () => {
    const plan = buildSiteHomePlan({
      site,
      access,
      owner: false,
      readiness: null,
    });
    expect(plan.next?.href).toBe("/sites/wedding-a/invitations");
    expect(plan.sections.map((x) => x.id)).toEqual([
      "invitations",
      "messages",
      "gifts",
      "receiving",
      "team",
    ]);
    expect(plan.receivingLabel).toBe("Status não consultado");
  });
  it("guides actionable receiving setup to activation, never to a transfer", () => {
    const plan = buildSiteHomePlan({
      site,
      access,
      owner: false,
      readiness: pending,
    });
    expect(plan.next?.href).toBe("/sites/wedding-a/receiving/activation");
    expect(plan.receivingLabel).toBe("Configuração pendente");
  });
  it.each(["ACCOUNT_UNDER_REVIEW", "PROVIDER_DISABLED"] as const)(
    "does not ask the user to repeat a provider-owned wait: %s",
    (reason) => {
      const readiness = { ...pending, state: "BLOCKED" as const, reason };
      const plan = buildSiteHomePlan({ site, access, owner: false, readiness });
      expect(plan.next?.href).toBe("/sites/wedding-a/invitations");
      expect(plan.receivingLabel).toBe(
        reason === "ACCOUNT_UNDER_REVIEW"
          ? "Em análise"
          : "Aguardando habilitação",
      );
    },
  );
  it("recognizes readiness only within the selected site", () => {
    const ready = {
      ...pending,
      state: "READY" as const,
      reason: null,
      catalogEligible: true,
    };
    expect(
      buildSiteHomePlan({ site, access, owner: false, readiness: ready })
        .receivingLabel,
    ).toBe("Recebimentos liberados");
    expect(
      buildSiteHomePlan({
        site,
        access,
        owner: false,
        readiness: { ...ready, siteId: "other" },
      }).receivingLabel,
    ).toBe("Status não consultado");
  });
  it.each(["ACCOUNT_BLOCKED", "ENVIRONMENT_MISMATCH"] as const)(
    "routes a provider or platform block to support-oriented status instead of setup: %s",
    (reason) => {
      const plan = buildSiteHomePlan({
        site,
        access,
        owner: false,
        readiness: { ...pending, state: "BLOCKED", reason },
      });
      expect(plan.receivingLabel).toBe(
        reason === "ACCOUNT_BLOCKED"
          ? "Recebimentos bloqueados"
          : "Revisão necessária",
      );
      expect(plan.next?.href).toBe("/sites/wedding-a/receiving");
      expect(plan.next?.description).toContain("suporte");
      expect(plan.next?.label).not.toContain("ativação");
    },
  );
  it("does not turn unavailable provider capabilities into a customer setup task", () => {
    const plan = buildSiteHomePlan({
      site,
      access,
      owner: false,
      readiness: {
        ...pending,
        state: "BLOCKED",
        reason: "CAPABILITY_UNAVAILABLE",
      },
    });
    expect(plan.receivingLabel).toBe("Aguardando habilitação");
    expect(plan.next?.href).toBe("/sites/wedding-a/invitations");
  });
  it("does not expose financial or team guidance to an assistant", () => {
    const assistant = {
      ...access,
      membershipRole: "SITE_ASSISTANT" as const,
      capabilities: {
        ...access.capabilities,
        readFinance: false,
        configureReceiving: false,
        manageTeam: false,
      },
    };
    const plan = buildSiteHomePlan({
      site,
      access: assistant,
      owner: false,
      readiness: pending,
    });
    expect(plan.sections.map((x) => x.id)).toEqual([
      "invitations",
      "messages",
      "gifts",
    ]);
    expect(plan.next?.href).toBe("/sites/wedding-a/invitations");
    expect(plan.receivingLabel).toBeNull();
  });
  it("prioritizes paused sites and owner publication without inventing permissions", () => {
    const paused = { ...site, lifecycle: "INACTIVE" as const };
    expect(
      buildSiteHomePlan({
        site: paused,
        access: null,
        owner: true,
        readiness: null,
      }).next?.href,
    ).toBe("/sites/wedding-a/settings");
    expect(
      buildSiteHomePlan({ site: paused, access, owner: false, readiness: null })
        .next?.href,
    ).toBe("/sites/wedding-a/invitations");
    expect(
      buildSiteHomePlan({
        site: { ...site, publicationState: "UNPUBLISHED" },
        access: null,
        owner: true,
        readiness: null,
      }).next?.href,
    ).toBe("/sites/wedding-a/settings");
  });
  it("does not admit another site's membership", () => {
    const plan = buildSiteHomePlan({
      site,
      access: { ...access, siteId: "other" },
      owner: false,
      readiness: pending,
    });
    expect(plan.sections).toEqual([]);
    expect(plan.next).toBeNull();
  });
});
