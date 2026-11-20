// @vitest-environment jsdom
import {
  meResponseSchema,
  type ReceivingSetupContext,
  receivingSetupDisclosure,
  type SiteAccess,
} from "@entrelacos/contracts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/apiClient";
import { ReceivingAccountSetup } from "./ReceivingAccountSetup";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to: _to,
    params: _params,
    hash: _hash,
    ...props
  }: {
    children: React.ReactNode;
    to: string;
    params?: unknown;
    hash?: string;
  }) => createElement("a", props, children),
}));

const access: SiteAccess = {
  siteId: "site-one",
  userId: "holder-one",
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
const values: Record<string, string> = {
  name: "Fixture Holder",
  cpf: "123.456.789-09",
  birthDate: "1990-04-12",
  email: "holder@example.test",
  mobilePhone: "(21) 99464-7568",
  monthlyIncome: "5000",
  professionalOccupation: "Professora",
  zipCode: "20021-130",
  street: "Rua Fixture",
  streetNumber: "10",
  neighborhood: "Centro",
  city: "Rio de Janeiro",
  state: "RJ",
  accountType: "checking",
  bank: "341",
  branch: "1234",
  account: "12345-6",
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("__APP_ENV__", "production");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function type(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
    element,
    value,
  );
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}
function field(name: string) {
  const element = container.querySelector(`[name="${name}"]`);
  if (
    !(element instanceof HTMLInputElement) &&
    !(element instanceof HTMLSelectElement)
  )
    throw new Error(`missing field ${name}`);
  return element;
}

describe("registration refused by Pagar.me", () => {
  it("keeps the typed data and names the fields to fix", async () => {
    const actor = meResponseSchema.parse({
      user: {
        id: "holder-one",
        role: "SITE_ADMIN",
        name: "Fixture Holder",
        email: "holder@example.test",
      },
      session: { id: "session-one", expiresAt: "2026-10-25T20:00:00.000Z" },
      siteId: "site-one",
      memberships: [access],
    });
    const snapshot = { status: "verified", sessionEpoch: 1, actor };
    const owner = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      reportFailure: vi.fn(),
      isSuspended: () => false,
    };
    const setup: ReceivingSetupContext = {
      siteId: "site-one",
      mode: "live",
      policyVersion: "policy-v1",
      holder: { userId: "holder-one", name: "Fixture Holder" },
      isHolder: true,
      consentRecorded: true,
      disclosure: receivingSetupDisclosure,
      accountState: "UNKNOWN",
      providerStatus: null,
    };
    const request = vi.fn(
      async (
        path: string,
        options?: { method?: string; body?: unknown },
      ): Promise<unknown> => {
        if (path === "/v1/me") return actor;
        if (options?.method === "POST")
          throw new ApiError(422, "RECEIVING_PROVIDER_REJECTED", {
            code: "RECEIVING_PROVIDER_REJECTED",
            provider: {
              message: null,
              fields: [
                {
                  field: "register_information.birthdate",
                  messages: ["must be dd/mm/yyyy"],
                },
              ],
            },
          });
        return { setup: { ...setup, accountState: "PENDING" } };
      },
    );
    await act(async () => {
      root.render(
        createElement(ReceivingAccountSetup, {
          siteId: "site-one",
          access,
          sessionEpoch: 1,
          ports: {
            owner: owner as never,
            request,
            now: () => Date.parse("2026-10-24T20:00:00.000Z"),
          },
          section: "details",
        }),
      );
    });
    await vi.waitFor(() =>
      expect(container.querySelector("form")).not.toBeNull(),
    );
    await act(async () => {
      for (const [name, value] of Object.entries(values))
        type(field(name), value);
      const consent = field("consent") as HTMLInputElement;
      consent.click();
    });
    await act(async () => {
      container
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("A Pagar.me recusou o cadastro"),
    );
    const posts = request.mock.calls.filter(
      ([, options]) => options?.method === "POST",
    );
    expect(posts).toHaveLength(1);
    expect(container.textContent).toContain("Data de nascimento");
    expect(container.textContent).toContain("must be dd/mm/yyyy");
    for (const [name, value] of Object.entries(values))
      expect(field(name).value).toBe(value);
    expect(owner.reportFailure).not.toHaveBeenCalled();
  });
});
