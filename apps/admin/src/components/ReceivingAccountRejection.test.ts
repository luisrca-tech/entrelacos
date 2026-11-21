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
/** The holder's panel; `post` answers the registration submit. */
async function renderPanel(post: () => Promise<unknown>) {
  const snapshot = { status: "verified", sessionEpoch: 1, actor };
  const owner = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    reportFailure: vi.fn(),
    isSuspended: () => false,
  };
  const request = vi.fn(
    async (
      path: string,
      options?: { method?: string; body?: unknown },
    ): Promise<unknown> => {
      if (path === "/v1/me") return actor;
      if (options?.method === "POST") return post();
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
  return {
    owner,
    request,
    posts: () =>
      request.mock.calls.filter(([, options]) => options?.method === "POST"),
  };
}
async function fill(entries: Record<string, string> = values) {
  await act(async () => {
    for (const [name, value] of Object.entries(entries))
      type(field(name), value);
    const consent = field("consent") as HTMLInputElement;
    if (!consent.checked) consent.click();
  });
}
async function submit() {
  await act(async () => {
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
const holderRefusal = () =>
  new ApiError(422, "RECEIVING_PROVIDER_REJECTED", {
    code: "RECEIVING_PROVIDER_REJECTED",
    provider: {
      message: "The request is invalid.",
      fields: [
        {
          field: "default_bank_account.holder_name",
          messages: [
            "Bank account holder name must be lower than 30 characters",
          ],
        },
      ],
    },
  });

describe("registration refused by Pagar.me", () => {
  it("keeps the typed data and names the fields to fix", async () => {
    const { owner, posts } = await renderPanel(async () => {
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
    });
    await fill();
    await submit();
    await vi.waitFor(() =>
      expect(container.textContent).toContain("A Pagar.me recusou o cadastro"),
    );
    expect(posts()).toHaveLength(1);
    expect(container.textContent).toContain(
      "Data de nascimento: use uma data válida; o titular precisa ter 18 anos ou mais.",
    );
    expect(field("birthDate").getAttribute("aria-invalid")).toBe("true");
    for (const [name, value] of Object.entries(values))
      expect(field(name).value).toBe(value);
    expect(owner.reportFailure).not.toHaveBeenCalled();
  });

  it("explains the holder name refusal, highlights its field and keeps every value while the send is pending", async () => {
    let refuse!: (error: unknown) => void;
    const { posts } = await renderPanel(
      () =>
        new Promise((_resolve, reject) => {
          refuse = reject;
        }),
    );
    await fill();
    await submit();
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    // The send is in flight: the form stays with what was typed.
    expect(container.querySelector("form")).not.toBeNull();
    await act(async () => refuse(holderRefusal()));
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "Nome do titular da conta: use até 30 caracteres, como aparece no banco.",
      ),
    );
    expect(container.textContent).not.toContain("must be lower than");
    expect(field("holderName").getAttribute("aria-invalid")).toBe("true");
    expect(field("name").getAttribute("aria-invalid")).toBeNull();
    for (const [name, value] of Object.entries(values))
      expect(field(name).value).toBe(value);
    expect((field("consent") as HTMLInputElement).checked).toBe(true);
  });
});

describe("bank account holder name in the form", () => {
  it("shows the field error before sending a 31-character holder name", async () => {
    const { posts } = await renderPanel(async () => ({ state: "STORED" }));
    await fill({ ...values, holderName: "MARIA APARECIDA DOS SANTOS LIMA" });
    await submit();
    expect(posts()).toHaveLength(0);
    expect(field("holderName").getAttribute("aria-invalid")).toBe("true");
    expect(container.textContent).toContain(
      "Nome do titular da conta: use de 2 a 30 caracteres",
    );
    expect(field("holderName").value).toBe("MARIA APARECIDA DOS SANTOS LIMA");
  });

  it("sends the holder name apart from the full name", async () => {
    const { request, posts } = await renderPanel(async () => ({
      state: "STORED",
    }));
    await fill({
      ...values,
      name: "Fixture Aparecida Fernanda da Silva Holder",
      holderName: "fixture  a f da s holder",
    });
    await submit();
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    const body = request.mock.calls.find(
      ([, options]) => options?.method === "POST",
    )?.[1]?.body as { account: Record<string, Record<string, unknown>> };
    expect(body.account.name).toBe(
      "Fixture Aparecida Fernanda da Silva Holder",
    );
    expect(body.account.bankAccount.holderName).toBe("FIXTURE A F DA S HOLDER");
  });

  it("suggests the holder name from the full name until it is edited", async () => {
    await renderPanel(async () => ({ state: "STORED" }));
    await fill({ name: "Maria Aparecida Fernanda Silva Santos" });
    expect(field("holderName").value).toBe("MARIA A F S SANTOS");
    await fill({ name: "Luis Felipe Da Rocha" });
    expect(field("holderName").value).toBe("LUIS FELIPE DA ROCHA");
    await fill({ holderName: "LUIS F ROCHA" });
    await fill({ name: "Luis Felipe Da Rocha Neto" });
    expect(field("holderName").value).toBe("LUIS F ROCHA");
  });
});
