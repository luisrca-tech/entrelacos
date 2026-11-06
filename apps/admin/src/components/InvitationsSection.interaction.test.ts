// @vitest-environment jsdom
import type { MeResponse } from "@entrelacos/contracts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InvitationsSection } from "./InvitationsSection";
import { panelActorOwner } from "./panelActor";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../lib/apiClient", async (original) => ({
  ...(await original<object>()),
  apiRequest: request,
}));
vi.mock("@entrelacos/ui", async (original) => ({
  ...(await original<object>()),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
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
const invitation = (id: string, name: string) => ({
  id,
  siteId: "site-1",
  name,
  phone: "+5511999999999",
  email: null,
  guests: [
    {
      id: `${id}-guest`,
      fullName: `${name} convidado`,
      guestType: "ADULT",
      rsvpState: "CONFIRMED",
      rsvpRevision: 0,
    },
  ],
  createdAt: "2026-10-01T12:00:00.000Z",
  updatedAt: "2026-10-01T12:00:00.000Z",
});
type Route = (path: string) => unknown;
let routes: Record<string, Route>;
let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-24T12:00:00.000Z"));
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.matchMedia = vi.fn(() => ({ matches: false })) as never;
  request.mockReset();
  request.mockResolvedValueOnce(actor);
  await panelActorOwner.load();
  routes = {
    "/rsvp/deadline": () => ({ deadlineAt: null, deadlineTimezone: null }),
    "/home-summary": () => ({
      invitations: { total: 45, confirmed: 20, pending: 15, declined: 5 },
    }),
    "/invitations": () => ({
      invitations: [invitation("inv-1", "Família Souza")],
      nextCursor: "page-2",
    }),
    "/access-pin": () => ({ accessPin: "1234" }),
  };
  request.mockImplementation(async (path: string) => {
    const pathname = path.split("?")[0];
    const match = Object.keys(routes).find((suffix) =>
      pathname.endsWith(suffix),
    );
    if (!match) throw new Error(`Unexpected request ${path}`);
    return routes[match](path);
  });
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
async function mount() {
  await act(async () => {
    root.render(
      createElement(InvitationsSection, {
        siteId: "site-1",
        lifecycle: "ACTIVE",
        sessionEpoch: panelActorOwner.getSnapshot().sessionEpoch,
      }),
    );
  });
  await act(async () => vi.advanceTimersByTimeAsync(0));
}
async function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set?.call(input, value);
  await act(async () =>
    input.dispatchEvent(new Event("input", { bubbles: true })),
  );
}
function search() {
  const found = container.querySelector<HTMLInputElement>("#invitation-search");
  if (!found) throw new Error("Missing search");
  return found;
}

it("summarizes every invitation of the wedding instead of the loaded page", async () => {
  await mount();
  const summary = container.querySelector('[aria-label="Resumo dos convites"]');
  expect(summary?.textContent).toContain("20 de 40 convidados irão comparecer");
  expect(summary?.textContent).toContain("45 convites");
  expect(summary?.textContent).toContain("Respostas dos convidados");
});

it("labels a loaded-only summary honestly when site totals are unavailable", async () => {
  routes["/home-summary"] = () => {
    throw new Error("summary unavailable");
  };
  await mount();
  const summary = container.querySelector('[aria-label="Resumo dos convites"]');
  expect(summary?.textContent).toContain("1 de 1 convidados irão comparecer");
  expect(summary?.textContent).toContain("convites carregados");
});

it("keeps rows and the open detail mounted while a search reloads, then clears stale rows when it fails", async () => {
  await mount();
  const row = [...container.querySelectorAll("button")].find((entry) =>
    entry.textContent?.includes("Família Souza"),
  );
  if (!row) throw new Error("Missing invitation row");
  await act(async () => row.click());
  await act(async () => vi.advanceTimersByTimeAsync(0));
  const heading = container.querySelector("#invitation-detail-title");
  expect(heading).not.toBeNull();
  let reject!: (cause: Error) => void;
  routes["/invitations"] = () =>
    new Promise((_, no) => {
      reject = no;
    });
  search().focus();
  await type(search(), "Lima");
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(container.textContent).toContain("Família Souza");
  expect(container.textContent).not.toContain("Carregando convites…");
  expect(container.textContent).toContain("Atualizando convites…");
  expect(container.querySelector("#invitation-detail-title")).toBe(heading);
  expect(document.activeElement).toBe(search());
  await act(async () => reject(new Error("search unavailable")));
  expect(container.textContent).not.toContain("Família Souza");
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
});

it("describes the export scope without the loaded page count", async () => {
  await mount();
  const exportButton = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent === "Exportar",
  );
  await act(async () => exportButton?.click());
  expect(document.body.textContent).toContain("todos os convites do casamento");
  expect(document.body.textContent).not.toMatch(/filtros ativos em \d+/);
});
