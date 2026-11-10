// @vitest-environment jsdom
import type { MeResponse, SiteAccess } from "@entrelacos/contracts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AdminShell } from "./AdminShell";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    activeOptions: _activeOptions,
    ...props
  }: {
    to: string;
    children: React.ReactNode;
    activeOptions?: unknown;
  }) => createElement("a", { ...props, href: to }, children),
}));
const actor: MeResponse = {
  user: {
    id: "admin-a",
    name: "Ana",
    email: "ana@example.test",
    role: "SITE_ADMIN",
  },
  session: { id: "session-a", expiresAt: "2027-01-01T00:00:00Z" },
  siteId: "wedding-a",
};

describe("Asaas financial disclosure", () => {
  it.each(["receiving", "receiving-guide"] as const)(
    "places a single disclosure between the %s content and the footer",
    (area) => {
      const node = document.createElement("div");
      node.innerHTML = renderToStaticMarkup(
        createElement(
          AdminShell,
          { actor, area, siteId: "wedding-a", onLogout: vi.fn() },
          createElement("h1", null, "Page content"),
        ),
      );
      const disclosures = node.querySelectorAll(
        '[aria-label="Prestador dos serviços financeiros"]',
      );
      const footer = node.querySelector("footer");
      const lastBlock = footer?.previousElementSibling;
      expect(disclosures).toHaveLength(1);
      expect(lastBlock?.contains(disclosures[0])).toBe(true);
      expect(node.querySelector("main")?.textContent).toBe("Page content");
    },
  );

  it("keeps the disclosure off unrelated pages", () => {
    const html = renderToStaticMarkup(
      createElement(AdminShell, {
        actor,
        area: "gifts",
        siteId: "wedding-a",
        onLogout: vi.fn(),
      }),
    );
    expect(html).not.toContain('alt="Serviços financeiros Asaas"');
  });
});

describe("mobile panel navigation", () => {
  it.each(["SITE_ADMIN", "SITE_ASSISTANT", "OWNER"] as const)(
    "opens the public FAQ in a new tab from the sidebar and More menu for %s",
    async (role) => {
      Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
      const node = document.createElement("div");
      document.body.append(node);
      const root = createRoot(node);
      try {
        await act(async () =>
          root.render(
            createElement(AdminShell, {
              actor: { ...actor, user: { ...actor.user, role } },
              siteId: "wedding-a",
              onLogout: vi.fn(),
            }),
          ),
        );
        const sidebar = node.querySelector(
          '#admin-primary-nav a[href="https://entrelacosbr.site/duvidas"]',
        );
        expect(sidebar?.textContent).toContain("Dúvidas frequentes");
        expect(sidebar?.getAttribute("target")).toBe("_blank");
        expect(sidebar?.getAttribute("rel")).toBe("noopener noreferrer");
        const more = node.querySelector<HTMLButtonElement>(
          'button[aria-label="Mais páginas"]',
        );
        expect(more).not.toBeNull();
        await act(async () => more?.click());
        const link = document.querySelector(
          'nav[aria-label="Outras páginas do casamento"] a[href="https://entrelacosbr.site/duvidas"]',
        );
        expect(link?.textContent).toContain("Dúvidas frequentes");
        expect(link?.getAttribute("target")).toBe("_blank");
        expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
      } finally {
        await act(async () => root.unmount());
        node.remove();
      }
    },
  );

  it("keeps the FAQ accessible from the account menu without a selected wedding", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    try {
      await act(async () =>
        root.render(createElement(AdminShell, { actor, onLogout: vi.fn() })),
      );
      await act(async () =>
        node
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Abrir menu de Ana"]',
          )
          ?.click(),
      );
      const links = document.querySelectorAll(
        'a[href="https://entrelacosbr.site/duvidas"]',
      );
      expect(links).toHaveLength(2);
      expect(
        [...links].every((link) => link.getAttribute("target") === "_blank"),
      ).toBe(true);
    } finally {
      await act(async () => root.unmount());
      node.remove();
    }
  });

  it("keeps four main destinations and opens the other pages on demand", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    try {
      await act(async () =>
        root.render(
          createElement(
            AdminShell,
            {
              actor,
              siteId: "wedding-a",
              siteName: "Ana e João",
              area: "home",
              onLogout: vi.fn(),
            },
            createElement("p", null, "Home"),
          ),
        ),
      );
      const mobile = node.querySelector(
        'nav[aria-label="Navegação do casamento no celular"]',
      );
      expect(mobile).not.toBeNull();
      expect(mobile?.querySelectorAll("a")).toHaveLength(4);
      expect(mobile?.textContent).toContain("Início");
      const more = mobile?.querySelector<HTMLButtonElement>(
        'button[aria-label="Mais páginas"]',
      );
      expect(more).not.toBeNull();
      await act(async () => more?.click());
      expect(
        document.querySelector('a[href="/sites/wedding-a/team"]'),
      ).not.toBeNull();
      expect(
        [...document.querySelectorAll('a[href="/sites/wedding-a/messages"]')]
          .length,
      ).toBeGreaterThan(1);
    } finally {
      await act(async () => root.unmount());
      node.remove();
    }
  });
  it("uses the current wedding role in the account menu", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    const access: SiteAccess = {
      siteId: "wedding-a",
      userId: actor.user.id,
      membershipId: "member-a",
      membershipRole: "SITE_ASSISTANT",
      capabilities: {
        manageInvitations: true,
        manageMessages: true,
        manageCatalog: true,
        manageTeam: false,
        readFinance: false,
        configureReceiving: false,
        requestWithdrawal: false,
      },
    };
    try {
      await act(async () =>
        root.render(
          createElement(
            AdminShell,
            {
              actor,
              siteId: access.siteId,
              siteAccess: access,
              area: "home",
              onLogout: vi.fn(),
            },
            createElement("p", null, "Home"),
          ),
        ),
      );
      await act(async () =>
        node
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Abrir menu de Ana"]',
          )
          ?.click(),
      );
      expect(document.body.textContent).toContain("Assessor do casamento");
      const mobile = node.querySelector(
        'nav[aria-label="Navegação do casamento no celular"]',
      );
      expect(mobile?.querySelectorAll("a")).toHaveLength(4);
      expect(mobile?.textContent).toContain("Mais");
      expect(mobile?.textContent).not.toContain("Recebimentos");
    } finally {
      await act(async () => root.unmount());
      node.remove();
    }
  });
});

describe("desktop navigation collapse", () => {
  async function mountShell(area: "home" | "gifts") {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    await act(async () =>
      root.render(
        createElement(
          AdminShell,
          { actor, siteId: "wedding-a", area, onLogout: vi.fn() },
          createElement("p", null, area),
        ),
      ),
    );
    const toggle = () => {
      const button = node.querySelector<HTMLButtonElement>(
        "#admin-primary-nav button[aria-expanded]",
      );
      if (!button) throw new Error("Missing collapse toggle");
      return button;
    };
    return {
      toggle,
      async unmount() {
        await act(async () => root.unmount());
        node.remove();
      },
    };
  }

  it("keeps the sidebar collapsed when a navigation remounts the shell", async () => {
    const home = await mountShell("home");
    expect(home.toggle().getAttribute("aria-expanded")).toBe("true");
    await act(async () => home.toggle().click());
    expect(home.toggle().getAttribute("aria-label")).toBe("Expandir navegação");
    await home.unmount();

    // Each route renders its own Panel, so navigating mounts a new shell.
    const gifts = await mountShell("gifts");
    try {
      expect(gifts.toggle().getAttribute("aria-expanded")).toBe("false");
      expect(window.localStorage.getItem("entrelacos.admin.navigation")).toBe(
        "collapsed",
      );
      await act(async () => gifts.toggle().click());
      expect(gifts.toggle().getAttribute("aria-expanded")).toBe("true");
      expect(window.localStorage.getItem("entrelacos.admin.navigation")).toBe(
        "expanded",
      );
    } finally {
      await gifts.unmount();
    }
  });
});

describe("mobile dock clearance", () => {
  it("reserves the measured dock height and updates it when labels wrap", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    let notify: ResizeObserverCallback | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          notify = callback;
        }
        observe = vi.fn();
        disconnect = disconnect;
      },
    );
    let dockHeight = 74;
    const box = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        return {
          height:
            this.getAttribute("aria-label") ===
            "Navegação do casamento no celular"
              ? dockHeight
              : 0,
        } as DOMRect;
      });
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    try {
      await act(async () =>
        root.render(
          createElement(
            AdminShell,
            {
              actor,
              siteId: "wedding-a",
              area: "receiving",
              onLogout: vi.fn(),
            },
            createElement("button", { type: "button" }, "Last page action"),
          ),
        ),
      );
      const shell = node.firstElementChild as HTMLElement;
      expect(shell.style.getPropertyValue("--admin-mobile-nav-height")).toBe(
        "74px",
      );
      dockHeight = 132;
      await act(async () => notify?.([], {} as ResizeObserver));
      expect(shell.style.getPropertyValue("--admin-mobile-nav-height")).toBe(
        "132px",
      );
      await act(async () => root.unmount());
      expect(disconnect).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      node.remove();
      box.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
