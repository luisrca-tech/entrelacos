// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MessagesSection } from "./MessagesSection";

const { request, success, error } = vi.hoisted(() => ({
  request: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../lib/apiClient", async (original) => ({
  ...(await original<object>()),
  apiRequest: request,
}));
vi.mock("@entrelacos/ui", async (original) => ({
  ...(await original<object>()),
  toast: { success, error },
}));

const message = {
  id: "message-1",
  authorName: "Ana",
  text: "Felicidades!",
  createdAt: "2026-10-01T12:00:00.000Z",
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  request.mockReset();
  success.mockReset();
  error.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
});
async function mount() {
  await act(async () => {
    root.render(
      createElement(MessagesSection, { siteId: "site-1", lifecycle: "ACTIVE" }),
    );
  });
  await act(async () => {
    await vi.runAllTimersAsync();
  });
}
function button(label: string) {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((entry) => entry.textContent === label);
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}

it("keeps mural changes unavailable until its setting loads and offers a safe retry", async () => {
  request.mockRejectedValueOnce(new Error("private backend failure"));
  request.mockResolvedValueOnce({ enabled: true });
  await mount();
  expect(container.textContent).not.toContain("private backend failure");
  expect(
    container.querySelector<HTMLButtonElement>("#mural-enabled")?.disabled,
  ).toBe(true);
  request.mockImplementation(async (path: string) =>
    path.endsWith("/mural")
      ? { enabled: true }
      : { messages: [message], nextCursor: null },
  );
  await act(async () => button("Tentar novamente").click());
  expect(container.textContent).toContain("Felicidades!");
  expect(
    container.querySelector<HTMLButtonElement>("#mural-enabled")?.disabled,
  ).toBe(false);
});

it("keeps loaded messages visible and prevents duplicate pagination while a page is loading", async () => {
  request.mockImplementation(async (path: string) =>
    path.endsWith("/mural")
      ? { enabled: true }
      : { messages: [message], nextCursor: "page-2" },
  );
  await mount();
  let resolvePage!: (value: unknown) => void;
  request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolvePage = resolve;
      }),
  );
  await act(async () => button("Ver mais mensagens").click());
  expect(container.textContent).toContain("Felicidades!");
  expect(button("Carregando mais…").disabled).toBe(true);
  await act(async () =>
    resolvePage({
      messages: [{ ...message, id: "message-2", text: "Parabéns!" }],
      nextCursor: null,
    }),
  );
  expect(container.textContent).toContain("Parabéns!");
  expect(container.textContent).toContain("Felicidades!");
});

it("retries the failed next page without dropping messages already loaded", async () => {
  request.mockImplementation(async (path: string) =>
    path.endsWith("/mural")
      ? { enabled: true }
      : { messages: [message], nextCursor: "page-2" },
  );
  await mount();
  request.mockRejectedValueOnce(new Error("page failed"));
  await act(async () => button("Ver mais mensagens").click());
  expect(container.textContent).toContain("Felicidades!");
  request.mockResolvedValueOnce({
    messages: [{ ...message, id: "message-2", text: "Parabéns!" }],
    nextCursor: null,
  });
  await act(async () => button("Tentar novamente").click());
  expect(request.mock.lastCall?.[0]).toContain("cursor=page-2");
  expect(container.textContent).toContain("Felicidades!");
  expect(container.textContent).toContain("Parabéns!");
});

it("requires confirmation before removing the selected message and uses transient feedback", async () => {
  request.mockImplementation(
    async (path: string, options?: { method?: string }) => {
      if (options?.method === "DELETE") return { ok: true };
      return path.endsWith("/mural")
        ? { enabled: true }
        : { messages: [message], nextCursor: null };
    },
  );
  await mount();
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Remover mensagem de Ana"]',
      )
      ?.click(),
  );
  expect(
    request.mock.calls.some(([, options]) => options?.method === "DELETE"),
  ).toBe(false);
  const dialog = document.querySelector('[role="alertdialog"]');
  expect(dialog?.textContent).toContain("não poderá ser recuperado");
  const confirm = [
    ...(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []),
  ].find((entry) => entry.textContent === "Remover mensagem");
  await act(async () => confirm?.click());
  expect(request).toHaveBeenCalledWith("/v1/sites/site-1/messages/message-1", {
    method: "DELETE",
    body: undefined,
  });
  expect(success).toHaveBeenCalledWith("Mensagem removida do mural.");
});

it("keeps inactive sites readable and disables mural changes and message removal", async () => {
  request.mockImplementation(async (path: string) =>
    path.endsWith("/mural")
      ? { enabled: true }
      : { messages: [message], nextCursor: null },
  );
  await act(async () =>
    root.render(
      createElement(MessagesSection, {
        siteId: "site-1",
        lifecycle: "INACTIVE",
      }),
    ),
  );
  await act(async () => {
    await vi.runAllTimersAsync();
  });
  expect(container.textContent).toContain("Felicidades!");
  expect(
    container.querySelector<HTMLButtonElement>("#mural-enabled")?.disabled,
  ).toBe(true);
  expect(
    container.querySelector<HTMLButtonElement>(
      '[aria-label="Remover mensagem de Ana"]',
    )?.disabled,
  ).toBe(true);
  expect(request.mock.calls.every(([, options]) => options === undefined)).toBe(
    true,
  );
});
