// @vitest-environment jsdom
import {
  meResponseSchema,
  type ReceivingSetupContext,
  receivingSetupDisclosure,
  type SiteAccess,
} from "@entrelacos/contracts";
import { toast } from "@entrelacos/ui";
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
  holderName: "FIXTURE HOLDER",
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
const reconcilePath = "/v1/sites/site-one/receiving/setup/reconcile";
const submitPath = "/v1/sites/site-one/receiving/setup";
/**
 * The panel of a holder whose dispatch is UNKNOWN. `answer` is what the
 * verification returns (or throws); `after` is the stored state it leaves.
 */
async function render(
  answer: () => Promise<unknown>,
  after: ReceivingSetupContext["accountState"],
  submit: () => Promise<unknown> = async () => ({ state: "STORED" }),
) {
  const owner = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    reportFailure: vi.fn(),
    isSuspended: () => false,
  };
  const snapshot = { status: "verified", sessionEpoch: 1, actor };
  let accountState: ReceivingSetupContext["accountState"] = "UNKNOWN";
  const request = vi.fn(
    async (
      path: string,
      options?: { method?: string; body?: unknown },
    ): Promise<unknown> => {
      if (path === "/v1/me") return actor;
      if (path === reconcilePath && options?.method === "POST") {
        const result = await answer();
        accountState = after;
        return result;
      }
      if (path === submitPath && options?.method === "POST") return submit();
      return { setup: { ...setup, accountState } };
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
  await vi.waitFor(() => expect(verifyButton()).not.toBeNull());
  return { owner, request };
}
function verifyButton() {
  return (
    [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Verificar situação",
    ) ?? null
  );
}
async function verify() {
  await act(async () => {
    verifyButton()?.click();
  });
}
function posts(request: ReturnType<typeof vi.fn>, path: string) {
  return request.mock.calls.filter(
    ([called, options]) => called === path && options?.method === "POST",
  );
}

describe("verifying an uncertain registration", () => {
  it("reopens the form with the saved holder name when Pagar.me never received it", async () => {
    const { request, owner } = await render(
      async () => ({ outcome: "RELEASED" }),
      "PENDING",
    );
    expect(container.querySelector("form")).toBeNull();
    await verify();
    await vi.waitFor(() =>
      expect(container.querySelector("form")).not.toBeNull(),
    );
    expect(posts(request, reconcilePath)).toHaveLength(1);
    expect(posts(request, reconcilePath)[0][1]?.body).toEqual({
      confirmReconcile: true,
    });
    expect(posts(request, submitPath)).toHaveLength(0);
    // The guard rereads the session and the setup before verifying.
    const order = request.mock.calls.map(([path]) => path);
    expect(order.indexOf("/v1/me")).toBeLessThan(order.indexOf(reconcilePath));
    expect(container.textContent).toContain(
      "A Pagar.me não recebeu seu cadastro.",
    );
    expect(field("name").value).toBe("Fixture Holder");
    // The bank holder name follows the saved name, so it is not marked.
    expect(field("holderName").value).toBe("FIXTURE HOLDER");
    expect(field("holderName").closest("[data-reentry]")).toBeNull();
    for (const name of Object.keys(values).filter(
      (name) => !["name", "accountType", "holderName"].includes(name),
    )) {
      expect(field(name).value).toBe("");
      expect(field(name).closest("[data-reentry]")).not.toBeNull();
    }
    expect(field("name").closest("[data-reentry]")).toBeNull();
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Enviar cadastro à Pagar.me",
      ),
    ).toBe(true);
    expect(owner.reportFailure).not.toHaveBeenCalled();
  });

  it("follows the bound flow when Pagar.me already holds the recipient", async () => {
    const { request } = await render(
      async () => ({ outcome: "STORED" }),
      "CREATED",
    );
    await verify();
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Cadastro criado na Pagar.me"),
    );
    expect(container.textContent).toContain("Acompanhar o status da conta");
    expect(container.querySelector("form")).toBeNull();
    expect(posts(request, submitPath)).toHaveLength(0);
  });

  it.each([
    [
      "PROVIDER_UNREACHABLE",
      async () => ({ outcome: "UNKNOWN", reason: "PROVIDER_UNREACHABLE" }),
    ],
    [
      "WINDOW_NOT_ELAPSED",
      async () => ({ outcome: "UNKNOWN", reason: "WINDOW_NOT_ELAPSED" }),
    ],
    [
      "an unavailable verification",
      async () => {
        throw new ApiError(503, "RECEIVING_SETUP_UNAVAILABLE");
      },
    ],
  ])(
    "keeps the uncertain state and asks to try again after %s",
    async (_label, answer) => {
      const { request, owner } = await render(answer, "UNKNOWN");
      await verify();
      await vi.waitFor(() =>
        expect(container.textContent).toContain("em alguns minutos"),
      );
      expect(verifyButton()).not.toBeNull();
      expect(container.querySelector("form")).toBeNull();
      expect(container.textContent).not.toContain("Configuração indisponível");
      expect(posts(request, submitPath)).toHaveLength(0);
      expect(owner.reportFailure).not.toHaveBeenCalled();
    },
  );

  it("keeps what was typed when the resubmission fails", async () => {
    const warning = vi.spyOn(toast, "warning");
    const { request } = await render(
      async () => ({ outcome: "RELEASED" }),
      "PENDING",
      async () => {
        throw new ApiError(503, "RECEIVING_SETUP_UNAVAILABLE");
      },
    );
    await verify();
    await vi.waitFor(() =>
      expect(container.querySelector("form")).not.toBeNull(),
    );
    await act(async () => {
      for (const [name, value] of Object.entries(values))
        type(field(name), value);
      (field("consent") as HTMLInputElement).click();
    });
    await act(async () => {
      container
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    await vi.waitFor(() =>
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("Seus dados continuam no formulário"),
      ),
    );
    expect(posts(request, submitPath)).toHaveLength(1);
    for (const [name, value] of Object.entries(values))
      expect(field(name).value).toBe(value);
  });
});
