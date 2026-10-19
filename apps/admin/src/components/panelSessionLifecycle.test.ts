// @vitest-environment jsdom
import {
  type MeResponse,
  receivingSetupDisclosure,
} from "@entrelacos/contracts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiRequest } from "../lib/apiClient";
import { Panel } from "./Panel";
import { panelActorOwner } from "./panelActor";
import { ReceivingAccountSetup } from "./ReceivingAccountSetup";

vi.mock("../lib/apiClient", async (original) => ({
  ...(await original<typeof import("../lib/apiClient")>()),
  apiRequest: vi.fn(),
}));
vi.mock("./AdminShell", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => children,
  ShellLoading: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("./SiteWorkspace", () => ({
  SiteWorkspace: (props: React.ComponentProps<typeof ReceivingAccountSetup>) =>
    createElement(ReceivingAccountSetup, props),
}));

const actor: MeResponse = {
  user: {
    id: "holder-one",
    role: "SITE_ADMIN",
    name: "Test Holder",
    email: "holder@example.test",
  },
  session: { id: "session-one", expiresAt: "2026-10-19T12:00:00.000Z" },
  siteId: "site-one",
  memberships: [
    {
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
    },
  ],
};
const setup = {
  siteId: "site-one",
  mode: "sandbox",
  policyVersion: "policy-v1",
  holder: { userId: "holder-one", name: "Test Holder" },
  isHolder: true,
  consentRecorded: false,
  disclosure: receivingSetupDisclosure,
  accountState: "NOT_CREATED",
  providerStatus: null,
};
let root: Root;
let container: HTMLDivElement;
function visibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}
beforeEach(async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T12:00:00.000Z"));
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  vi.mocked(apiRequest).mockImplementation(async (path) => {
    if (path === "/v1/me") return actor as never;
    return { setup } as never;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(Panel, { siteId: "site-one", area: "receiving" }),
    );
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  panelActorOwner.invalidate(false);
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe("panel session resume with a mounted receiving form", () => {
  it("loads identity in an initially hidden tab while keeping its form suspended", async () => {
    await act(async () => root.unmount());
    root = createRoot(container);
    vi.mocked(apiRequest).mockClear();
    visibility("hidden");
    await act(async () => {
      root.render(
        createElement(Panel, { siteId: "site-one", area: "receiving" }),
      );
    });
    expect(panelActorOwner.getSnapshot().status).toBe("verified");
    expect(panelActorOwner.isSuspended()).toBe(true);
    expect(apiRequest).toHaveBeenCalledWith("/v1/me");
    const name =
      container.querySelector<HTMLInputElement>('input[name="name"]');
    const form = name?.form;
    if (!name || !form) throw new Error("Missing receiving setup form");
    expect(name.matches(":disabled")).toBe(true);
    await act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(
      vi
        .mocked(apiRequest)
        .mock.calls.some(([, options]) => options?.method === "POST"),
    ).toBe(false);
  });

  it("preserves real input nodes and values while hidden, pending and revalidated", async () => {
    const name =
      container.querySelector<HTMLInputElement>('input[name="name"]')!;
    const address = container.querySelector<HTMLInputElement>(
      'input[name="address"]',
    )!;
    expect(name).not.toBeNull();
    name.value = "Filled holder";
    address.value = "Test Street";
    const snapshot = panelActorOwner.getSnapshot();
    let resolve!: (value: MeResponse) => void;
    vi.mocked(apiRequest).mockImplementationOnce(
      () =>
        new Promise((yes) => {
          resolve = yes as never;
        }),
    );
    await act(async () => visibility("hidden"));
    expect(container.querySelector('input[name="name"]')).toBe(name);
    await act(async () => {
      visibility("visible");
      window.dispatchEvent(new Event("focus"));
    });
    expect(container.querySelector('input[name="name"]')).toBe(name);
    expect(name.matches(":disabled")).toBe(true);
    expect(container.textContent).not.toContain("Verificando sessão");
    await act(async () => {
      name.form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(
      vi
        .mocked(apiRequest)
        .mock.calls.some(([, options]) => options?.method === "POST"),
    ).toBe(false);
    await act(async () => resolve(structuredClone(actor)));
    await flush();
    expect(panelActorOwner.getSnapshot()).toBe(snapshot);
    expect(container.querySelector('input[name="name"]')).toBe(name);
    expect(name.value).toBe("Filled holder");
    expect(address.value).toBe("Test Street");
    expect(name.matches(":disabled")).toBe(false);
  });

  it.each([401, 403, "membership", "session", "expiry"])(
    "clears mounted personal fields on %s",
    async (change) => {
      const input =
        container.querySelector<HTMLInputElement>('input[name="name"]')!;
      input.value = "Private draft";
      await act(async () => visibility("hidden"));
      if (typeof change === "number") {
        vi.mocked(apiRequest).mockRejectedValueOnce(
          new ApiError(change, "DENIED"),
        );
      } else {
        const changed = structuredClone(actor);
        if (change === "membership") changed.memberships = [];
        if (change === "session") changed.session.id = "session-two";
        if (change === "expiry")
          changed.session.expiresAt = new Date(Date.now() - 1).toISOString();
        vi.mocked(apiRequest).mockResolvedValueOnce(changed);
      }
      await act(async () => visibility("visible"));
      await flush();
      expect(input.isConnected).toBe(false);
      expect(input.value).toBe("");
      expect(container.textContent).not.toContain("Private draft");
    },
  );

  it.each(["identity", "holder"])(
    "blocks an already-started submission paused while checking %s",
    async (stage) => {
      const values = {
        name: "Fictional Person",
        email: "person@example.test",
        cpfCnpj: "12345678909",
        mobilePhone: "11999999999",
        incomeValue: "1000",
        address: "Fictional Road",
        addressNumber: "1",
        province: "District",
        postalCode: "12345678",
        birthDate: "1990-01-01",
      };
      for (const [key, value] of Object.entries(values))
        container.querySelector<HTMLInputElement>(
          `input[name="${key}"]`,
        )!.value = value;
      container.querySelector<HTMLInputElement>(
        'input[name="consent"]',
      )!.checked = true;
      let resolve!: (value: unknown) => void;
      if (stage === "holder")
        vi.mocked(apiRequest).mockResolvedValueOnce(actor);
      vi.mocked(apiRequest).mockImplementationOnce(
        () =>
          new Promise((yes) => {
            resolve = yes as never;
          }),
      );
      await act(async () => {
        container
          .querySelector("form")!
          .dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          );
      });
      expect(resolve).toBeTypeOf("function");
      await act(async () => visibility("hidden"));
      await act(async () => resolve(stage === "identity" ? actor : { setup }));
      expect(
        vi
          .mocked(apiRequest)
          .mock.calls.some(([, options]) => options?.method === "POST"),
      ).toBe(false);
      expect(container.querySelector('input[name="name"]')).not.toBeNull();
    },
  );
});
