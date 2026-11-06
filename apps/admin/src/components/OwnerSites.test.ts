// @vitest-environment jsdom
import type { MeResponse, SiteRecord } from "@entrelacos/contracts";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError, apiRequest } from "../lib/apiClient";
import { OwnerSites } from "./OwnerSites";
import { panelActorOwner } from "./panelActor";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("../lib/apiClient", async (original) => ({
  ...(await original<typeof import("../lib/apiClient")>()),
  apiRequest: vi.fn(),
}));
vi.mock("@entrelacos/ui", async (original) => ({
  ...(await original<object>()),
  toast: { error: toastError },
  DatePicker: ({
    name,
    required,
    disabled,
  }: {
    name: string;
    required?: boolean;
    disabled?: boolean;
  }) => createElement("input", { name, required, disabled, type: "date" }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
    ...rest
  }: {
    to: string;
    params?: { siteId: string };
    children: ReactNode;
  }) =>
    createElement(
      "a",
      { ...rest, href: to.replace("$siteId", params?.siteId ?? "") },
      children,
    ),
}));

const actor: MeResponse = {
  user: {
    id: "owner-1",
    name: "Owner",
    email: "owner@example.test",
    role: "OWNER",
  },
  session: { id: "session-1", expiresAt: "2026-10-25T12:00:00.000Z" },
  siteId: null,
};
const sites = [
  {
    id: "site-1",
    displayName: "Ana e João",
    coupleNames: ["Ana", "João"],
    eventDate: "2027-01-01",
    lifecycle: "ACTIVE",
  },
  {
    id: "site-2",
    displayName: "Bia e Luís",
    coupleNames: ["Bia", "Luís"],
    eventDate: "2027-02-01",
    lifecycle: "DRAFT",
  },
] as SiteRecord[];
let root: Root;
let container: HTMLDivElement;
const request = vi.mocked(apiRequest);
const navigate = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-24T12:00:00.000Z"));
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  request.mockReset();
  toastError.mockReset();
  navigate.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  panelActorOwner.invalidate(false);
  vi.useRealTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
});
async function verify() {
  request.mockResolvedValueOnce(actor);
  await panelActorOwner.load();
}
async function mount() {
  await act(async () => root.render(createElement(OwnerSites, { navigate })));
}
function button(label: string) {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((entry) => entry.textContent === label);
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}
async function change(
  input: HTMLInputElement | HTMLSelectElement,
  value: string,
) {
  const prototype =
    input instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLSelectElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
  await act(async () =>
    input.dispatchEvent(
      new Event(input instanceof HTMLInputElement ? "input" : "change", {
        bubbles: true,
      }),
    ),
  );
}
async function invitationForm() {
  await act(async () => button("Criar casamento").click());
  await act(async () => button("Alterar").click());
  const form = document.querySelector<HTMLFormElement>("form");
  if (!form) throw new Error("Expected create wedding form");
  for (const [name, value] of Object.entries({
    name: "Clara e Davi",
    slug: "clara-e-davi",
    first: "Davi",
    second: "Clara",
    date: "2027-08-12",
  })) {
    const field = form.querySelector<HTMLInputElement>(`[name="${name}"]`);
    if (!field) throw new Error(`Missing field: ${name}`);
    await change(field, value);
  }
  return form;
}
async function submit(form: HTMLFormElement) {
  await act(async () =>
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
}

it("does not load sites or expose create controls before a verified owner session", async () => {
  await mount();
  expect(request).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("Criar casamento");
});

it("distinguishes loading from empty and retries a safe loading error", async () => {
  await verify();
  let reject!: (cause: Error) => void;
  request.mockImplementationOnce(
    () =>
      new Promise((_, no) => {
        reject = no;
      }),
  );
  await mount();
  expect(container.textContent).toContain("Carregando casamentos");
  expect(container.textContent).not.toContain("Nenhum casamento cadastrado");
  await act(async () => reject(new Error("private raw backend details")));
  expect(container.textContent).not.toContain("private raw backend details");
  request.mockResolvedValueOnce({ sites, nextCursor: null });
  await act(async () => button("Tentar novamente").click());
  expect(container.textContent).toContain("Ana e João");
  expect(
    container.querySelector('a[href="/sites/site-1/home"]'),
  ).not.toBeNull();
});

it("debounces name search and resets the cursor when the lifecycle changes", async () => {
  await verify();
  request.mockResolvedValueOnce({ sites, nextCursor: "page-2" });
  await mount();
  const search = container.querySelector<HTMLInputElement>('[type="search"]');
  const filter = container.querySelector<HTMLSelectElement>("select");
  if (!search || !filter)
    throw new Error("Expected owner search and lifecycle filter");
  expect(container.textContent).toContain("2 de 2 casamentos carregados");
  request.mockResolvedValueOnce({
    sites: [sites[0]],
    nextCursor: null,
    totals: { ACTIVE: 1, DRAFT: 0, IN_REVIEW: 0, INACTIVE: 0 },
  });
  await change(search, "joao");
  expect(request.mock.lastCall?.[0]).toBe("/v1/owner/sites");
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(request.mock.lastCall?.[0]).toBe("/v1/owner/sites?search=joao");
  expect(container.textContent).toContain("1 de 1 casamentos carregados");
  expect(container.textContent).not.toContain("Bia e Luís");
  request.mockResolvedValueOnce({
    sites: [],
    nextCursor: null,
    totals: { ACTIVE: 1, DRAFT: 0, IN_REVIEW: 0, INACTIVE: 0 },
  });
  await change(filter, "DRAFT");
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(request.mock.lastCall?.[0]).toBe(
    "/v1/owner/sites?search=joao&lifecycle=DRAFT",
  );
  expect(container.textContent).toContain("Nenhum casamento encontrado");
});

it("prevents duplicate next-page requests and preserves records when retrying a failed page", async () => {
  await verify();
  request.mockResolvedValueOnce({ sites: [sites[0]], nextCursor: "page-2" });
  await mount();
  let reject!: (cause: Error) => void;
  request.mockImplementationOnce(
    () =>
      new Promise((_, no) => {
        reject = no;
      }),
  );
  await act(async () => {
    button("Carregar mais").click();
    button("Carregar mais").click();
  });
  expect(
    request.mock.calls.filter(([path]) => path.includes("cursor=")),
  ).toHaveLength(1);
  expect(container.textContent).toContain("Ana e João");
  await act(async () => reject(new Error("page unavailable")));
  request.mockResolvedValueOnce({ sites: [sites[1]], nextCursor: null });
  await act(async () => button("Tentar novamente").click());
  expect(request.mock.lastCall?.[0]).toBe("/v1/owner/sites?cursor=page-2");
  expect(container.textContent).toContain("Ana e João");
  expect(container.textContent).toContain("Bia e Luís");
});

it("preserves all create fields and the registration reference after failure, then opens home", async () => {
  await verify();
  request.mockResolvedValueOnce({ sites, nextCursor: null });
  await mount();
  const form = await invitationForm();
  request.mockRejectedValueOnce(new Error("create unavailable"));
  await submit(form);
  const expected = {
    method: "POST",
    body: {
      repositorySlug: "clara-e-davi",
      provisioningKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      displayName: "Clara e Davi",
      coupleNames: ["Davi", "Clara"],
      eventDate: "2027-08-12",
    },
  };
  expect(request).toHaveBeenLastCalledWith("/v1/owner/sites", expected);
  const initial = request.mock.lastCall;
  expect(document.querySelector('[name="key"]')).toBeNull();
  request.mockResolvedValueOnce({ site: { ...sites[0], id: "new-site" } });
  request.mockResolvedValueOnce({ sites, nextCursor: null });
  await submit(form);
  expect(
    request.mock.calls.filter(([, options]) => options?.method === "POST"),
  ).toEqual([initial, initial]);
  expect(document.body.textContent).toContain("Casamento criado");
  await act(async () => button("Abrir casamento").click());
  expect(navigate).toHaveBeenCalledWith("/sites/new-site/home");
});

it("ignores a delayed create after session ownership is lost", async () => {
  await verify();
  request.mockResolvedValueOnce({ sites, nextCursor: null });
  await mount();
  const form = await invitationForm();
  let resolve!: (value: unknown) => void;
  request.mockImplementationOnce(
    () =>
      new Promise((yes) => {
        resolve = yes;
      }),
  );
  await submit(form);
  await act(async () => panelActorOwner.invalidate(false));
  await act(async () => resolve({ site: sites[0] }));
  expect(navigate).not.toHaveBeenCalled();
  expect(toastError).not.toHaveBeenCalled();
  expect(document.querySelector("form")).toBeNull();
});

type Route = (options?: { method?: string; body?: unknown }) => unknown;
function routeRequests(routes: Record<string, Route>) {
  request.mockImplementation(async (path, options) => {
    const method = options?.method ?? "GET";
    const route = routes[`${method} ${path.split("?")[0]}`];
    if (!route) throw new Error(`Unexpected request: ${method} ${path}`);
    return route(options);
  });
}
function calls(method: string, path: string) {
  return request.mock.calls.filter(
    ([called, options]) =>
      (options?.method ?? "GET") === method && called.split("?")[0] === path,
  );
}
function checkbox(label: string) {
  const found = [...document.querySelectorAll("label")]
    .find((entry) => entry.textContent?.trim() === label)
    ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!found) throw new Error(`Checkbox not found: ${label}`);
  return found;
}
function field(name: string) {
  const found = document.querySelector<HTMLInputElement>(`[name="${name}"]`);
  if (!found) throw new Error(`Missing field: ${name}`);
  return found;
}
const createdSite = {
  ...sites[0],
  id: "new-site",
  displayName: "Davi & Clara",
  coupleNames: ["Davi", "Clara"],
  eventDate: "2027-08-12",
  publicUrl: null,
} as SiteRecord;

it("keeps the couple step editable after the site exists and finishes without access when it is unchecked", async () => {
  await verify();
  const adminBodies: unknown[] = [];
  routeRequests({
    "GET /v1/owner/sites": () => ({ sites, nextCursor: null }),
    "POST /v1/owner/sites": () => ({ site: createdSite }),
    "POST /v1/owner/sites/new-site/admins": (options) => {
      adminBodies.push(options?.body);
      throw new ApiError(400, "VALIDATION_ERROR");
    },
  });
  await mount();
  const form = await invitationForm();
  await act(async () => checkbox("Cadastrar alguém do casal agora").click());
  await change(field("adminName"), "Clara");
  await change(field("adminEmail"), "clara@example.test");
  const listLoads = calls("GET", "/v1/owner/sites").length;
  await submit(form);
  expect(document.body.textContent).toContain(
    "O casamento já foi criado. Tente cadastrar a pessoa novamente.",
  );
  expect(calls("GET", "/v1/owner/sites").length).toBeGreaterThan(listLoads);
  expect(field("first").disabled).toBe(true);
  expect(field("slug").disabled).toBe(true);
  expect(field("adminName").disabled).toBe(false);
  expect(field("adminEmail").disabled).toBe(false);
  expect(checkbox("Cadastrar alguém do casal agora").disabled).toBe(false);
  await change(field("adminEmail"), "clara.davi@example.test");
  await submit(form);
  expect(adminBodies).toEqual([
    { name: "Clara", email: "clara@example.test" },
    { name: "Clara", email: "clara.davi@example.test" },
  ]);
  await act(async () => checkbox("Cadastrar alguém do casal agora").click());
  await submit(form);
  expect(calls("POST", "/v1/owner/sites")).toHaveLength(1);
  expect(adminBodies).toHaveLength(2);
  expect(document.body.textContent).toContain("Casamento criado");
  expect(document.body.textContent).toContain(
    "Ninguém do casal foi cadastrado",
  );
});

it("shows the server record on success and refreshes the list after an in-flight load", async () => {
  await verify();
  let releaseList!: () => void;
  let deferList = false;
  routeRequests({
    "GET /v1/owner/sites": () =>
      deferList
        ? new Promise((resolve) => {
            deferList = false;
            releaseList = () => resolve({ sites, nextCursor: null });
          })
        : { sites, nextCursor: null },
    "POST /v1/owner/sites": () => {
      deferList = true;
      return { site: { ...createdSite, displayName: "Clara e Davi oficial" } };
    },
    "POST /v1/owner/sites/new-site/admins": () => ({ userId: "person-a" }),
  });
  await mount();
  const form = await invitationForm();
  await act(async () => checkbox("Cadastrar alguém do casal agora").click());
  await change(field("adminName"), "Clara");
  await change(field("adminEmail"), "clara@example.test");
  const listLoads = calls("GET", "/v1/owner/sites").length;
  await submit(form);
  expect(document.body.textContent).toContain("Casamento criado");
  expect(document.body.textContent).toContain("Clara e Davi oficial");
  expect(calls("GET", "/v1/owner/sites")).toHaveLength(listLoads + 1);
  await act(async () => releaseList());
  expect(calls("GET", "/v1/owner/sites")).toHaveLength(listLoads + 2);
});

it("asks for another identifier when the repository slug is already in use", async () => {
  await verify();
  routeRequests({
    "GET /v1/owner/sites": () => ({ sites, nextCursor: null }),
    "POST /v1/owner/sites": () => {
      throw new ApiError(409, "REPOSITORY_SLUG_CONFLICT");
    },
  });
  await mount();
  await act(async () => button("Criar casamento").click());
  await change(field("first"), "Davi");
  await change(field("second"), "Clara");
  await change(field("date"), "2027-08-12");
  const form = document.querySelector<HTMLFormElement>("form");
  if (!form) throw new Error("Expected create wedding form");
  await submit(form);
  expect(document.body.textContent).toContain(
    "Esse identificador já está em uso. Escolha outro.",
  );
  expect(field("slug").disabled).toBe(false);
});

it("starts over with a new registration key after a provisioning key conflict", async () => {
  await verify();
  routeRequests({
    "GET /v1/owner/sites": () => ({ sites, nextCursor: null }),
    "POST /v1/owner/sites": () => {
      throw new ApiError(409, "PROVISIONING_KEY_CONFLICT");
    },
  });
  await mount();
  const form = await invitationForm();
  await submit(form);
  expect(document.body.textContent).toContain(
    "Uma tentativa anterior já usou este cadastro com outros dados.",
  );
  await act(async () => button("Recomeçar com novo cadastro").click());
  await submit(form);
  const keys = calls("POST", "/v1/owner/sites").map(
    ([, options]) =>
      (options as { body: { provisioningKey: string } }).body.provisioningKey,
  );
  expect(keys).toHaveLength(2);
  expect(keys[0]).not.toBe(keys[1]);
});

it("clears previous weddings when the first page of a new filter fails", async () => {
  await verify();
  request.mockResolvedValueOnce({ sites, nextCursor: null });
  await mount();
  expect(container.textContent).toContain("Ana e João");
  const filter = container.querySelector<HTMLSelectElement>("select");
  if (!filter) throw new Error("Expected lifecycle filter");
  request.mockRejectedValueOnce(new Error("filter unavailable"));
  await change(filter, "DRAFT");
  expect(container.textContent).toContain(
    "Não foi possível carregar os casamentos.",
  );
  expect(container.textContent).not.toContain("Ana e João");
});

it("points the empty state to the create action label", async () => {
  await verify();
  request.mockResolvedValueOnce({ sites: [], nextCursor: null });
  await mount();
  expect(container.textContent).toContain("Comece em Criar casamento.");
});

it("shows lifecycle and stored receiving account state as badges with an outline open action", async () => {
  await verify();
  request.mockResolvedValueOnce({
    sites: [
      { ...sites[0], receivingAccount: "CREATED" },
      { ...sites[1], receivingAccount: "MISSING" },
      {
        ...sites[1],
        id: "site-3",
        displayName: "Caio e Lia",
        receivingAccount: null,
      },
    ],
    nextCursor: "page-2",
    totals: { ACTIVE: 1, DRAFT: 5, IN_REVIEW: 0, INACTIVE: 0 },
  });
  await mount();
  const table = container.querySelector("table");
  if (!table) throw new Error("Expected weddings table");
  const headers = [...table.querySelectorAll("th")].map(
    (cell) => cell.textContent,
  );
  expect(headers).toContain("Recebimentos");
  const rows = [...table.querySelectorAll("tbody tr")];
  const cell = (row: number, column: number) =>
    rows[row]?.querySelectorAll("td")[column];
  expect(
    cell(0, 2)?.querySelector('[data-slot="status-badge"]')?.textContent,
  ).toBe("Ativo");
  expect(cell(0, 3)?.textContent).toBe("Conta criada");
  expect(cell(1, 3)?.textContent).toBe("Sem conta");
  expect(cell(2, 3)?.textContent).toBe("Desativado");
  const open = cell(0, 5)?.querySelector("a");
  expect(open?.textContent).toBe("Abrir");
  expect(open?.getAttribute("data-variant")).toBe("outline");
  const footer = container.querySelector('[data-slot="owner-sites-footer"]');
  expect(footer?.textContent).toContain(
    "3 de 6 casamentos carregados · Carregue mais para ampliar a busca.",
  );
  expect(footer?.textContent).toContain("Carregar mais");
});
