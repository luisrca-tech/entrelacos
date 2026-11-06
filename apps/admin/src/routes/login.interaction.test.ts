// @vitest-environment jsdom
import { act, type ComponentType, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { apiRequest } from "../lib/apiClient";
import { Route } from "./login";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({
    options,
    useSearch: () => ({ email: "ana@example.test", next: "/" }),
  }),
  Link: ({ children }: { children: React.ReactNode }) =>
    createElement("a", { href: "/" }, children),
}));

vi.mock("../lib/apiClient", async (original) => ({
  ...(await original<typeof import("../lib/apiClient")>()),
  apiRequest: vi.fn(),
}));

it("keeps the sign-in failure beside the form and enables retry", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(apiRequest).mockRejectedValueOnce(new Error("Denied"));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    const Login = Route.options.component as ComponentType;
    await act(async () => root.render(createElement(Login)));
    const form = container.querySelector("form");
    expect(form).not.toBeNull();
    await act(async () =>
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Não foi possível entrar.",
    );
    expect(
      container.querySelector<HTMLButtonElement>('button[type="submit"]')
        ?.disabled,
    ).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
