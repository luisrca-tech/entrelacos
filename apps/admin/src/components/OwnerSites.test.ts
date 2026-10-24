// @vitest-environment jsdom
import type { MeResponse, SiteRecord } from "@entrelacos/contracts";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { apiRequest } from "../lib/apiClient";
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
  await act(async () => button("Novo casamento").click());
  const form = document.querySelector<HTMLFormElement>("form");
  if (!form) throw new Error("Expected create wedding form");
  for (const [name, value] of Object.entries({
    name: "Clara e Davi",
    slug: "clara-e-davi",
    key: "wedding-clara-davi-2027",
    first: "Davi",
    second: "Clara",
    date: "2027-08-12",
  })) {
    const field = form.querySelector<HTMLInputElement>(`[name="${name}"]`);
    if (!field) throw new Error(`Missing field: ${name}`);
    field.value = value;
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
  expect(container.textContent).not.toContain("Novo casamento");
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

it("filters loaded records by name and status without implying a complete database count", async () => {
  await verify();
  request.mockResolvedValueOnce({ sites, nextCursor: "page-2" });
  await mount();
  const search = container.querySelector<HTMLInputElement>('[type="search"]');
  const filter = container.querySelector<HTMLSelectElement>("select");
  if (!search || !filter)
    throw new Error("Expected owner search and lifecycle filter");
  expect(container.textContent).toContain("2 de 2 casamentos carregados");
  await change(search, "joao");
  expect(container.textContent).toContain("1 de 2 casamentos carregados");
  expect(container.textContent).not.toContain("Bia e Luís");
  await change(filter, "DRAFT");
  expect(container.textContent).toContain("Nenhum casamento encontrado");
  expect(button("Carregar mais").disabled).toBe(false);
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
      provisioningKey: "wedding-clara-davi-2027",
      displayName: "Clara e Davi",
      coupleNames: ["Davi", "Clara"],
      eventDate: "2027-08-12",
    },
  };
  expect(request).toHaveBeenLastCalledWith("/v1/owner/sites", expected);
  expect(
    document.querySelector('[name="key"]')?.getAttribute("required"),
  ).not.toBeNull();
  request.mockResolvedValueOnce({ site: { ...sites[0], id: "new-site" } });
  await submit(form);
  expect(request).toHaveBeenLastCalledWith("/v1/owner/sites", expected);
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
