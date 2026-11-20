import type { ReceivingReadiness, SiteAccess } from "@entrelacos/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paymentsAvailabilityStore } from "../lib/paymentsAvailability";
import { buildSiteHomePlan } from "./siteHomePlan";

// The API reports payments as available unless a test says otherwise.
beforeEach(() => paymentsAvailabilityStore.reportMode("sandbox"));
afterEach(() => paymentsAvailabilityStore.reset());

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

it("counts calendar days in São Paulo across UTC midnight", async () => {
  const { daysUntilWedding } = await import("./siteHomePlan");
  expect(daysUntilWedding("2027-03-14", new Date("2027-03-14T02:59:00Z"))).toBe(
    1,
  );
  expect(daysUntilWedding("2027-03-14", new Date("2027-03-14T03:00:00Z"))).toBe(
    0,
  );
  expect(daysUntilWedding("2027-03-14", new Date("2027-03-15T03:00:00Z"))).toBe(
    -1,
  );
});

describe("site home with money gifts switched off", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("hides receiving cards, labels and next steps", () => {
    vi.stubEnv("PUBLIC_GIFT_PAYMENTS_ENABLED", "false");
    for (const readiness of [
      null,
      pending,
      {
        ...pending,
        state: "BLOCKED" as const,
        reason: "ACCOUNT_BLOCKED" as const,
      },
    ]) {
      const plan = buildSiteHomePlan({ site, access, owner: true, readiness });
      expect(plan.sections.map((x) => x.id)).not.toContain("receiving");
      expect(plan.receivingLabel).toBeNull();
      expect(plan.next?.href ?? "").not.toContain("receiving");
    }
  });
});

describe("site home when the API reports payments disabled", () => {
  const site = {
    id: "site-1",
    lifecycle: "ACTIVE",
    publicationState: "PUBLISHED",
  } as const;
  const readiness: ReceivingReadiness = {
    siteId: "site-1",
    state: "BLOCKED",
    reason: "PROVIDER_DISABLED",
    observedAt: null,
    destinationVersion: null,
    catalogEligible: false,
    mode: "disabled",
  };
  it("offers no receiving card, label or setup step", () => {
    const plan = buildSiteHomePlan({
      site,
      access: null,
      owner: true,
      readiness,
      paymentsOpen: false,
    });
    expect(plan.sections.map((section) => section.id)).toEqual([
      "invitations",
      "messages",
      "gifts",
      "team",
      "settings",
    ]);
    expect(plan.receivingLabel).toBeNull();
    expect(plan.next?.href).toBe("/sites/site-1/invitations");
  });
  it("keeps the receiving card when payments are open", () => {
    const plan = buildSiteHomePlan({
      site,
      access: null,
      owner: true,
      readiness: null,
      paymentsOpen: true,
    });
    expect(plan.sections.map((section) => section.id)).toContain("receiving");
    expect(plan.receivingLabel).toBe("Status não consultado");
  });
  it("follows the API availability when the caller does not pass one", () => {
    paymentsAvailabilityStore.reportMode("disabled");
    const plan = buildSiteHomePlan({
      site,
      access: null,
      owner: true,
      readiness,
    });
    expect(plan.sections.map((section) => section.id)).not.toContain(
      "receiving",
    );
  });
});
