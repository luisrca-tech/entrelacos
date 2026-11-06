// @vitest-environment jsdom
import { act, type ComponentProps, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SiteSettingsView } from "./SiteSettingsView";

vi.mock("./OverflowMenu", () => ({
  OverflowMenu: ({
    label,
    items,
    disabled,
    onSelect,
  }: {
    label: string;
    items: { id: string; label: string }[];
    disabled: boolean;
    onSelect: (id: string) => void;
  }) =>
    createElement(
      "div",
      { "aria-label": label },
      items.map((item) =>
        createElement(
          "button",
          {
            key: item.id,
            type: "button",
            disabled,
            onClick: () => onSelect(item.id),
          },
          item.label,
        ),
      ),
    ),
}));

let container: HTMLDivElement;
let root: Root;
let props: ComponentProps<typeof SiteSettingsView>;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  props = {
    site: {
      displayName: "Maria e João",
      coupleNames: ["Maria", "João"],
      lifecycle: "ACTIVE",
      publicationState: "PUBLISHED",
      eventDate: "2027-06-12",
      publicUrl: "https://wedding.example.test",
      termStartsOn: "2026-06-12",
      termEndsOn: "2027-06-12",
      repositorySlug: "maria-joao",
    },
    admins: [],
    domains: [],
    labels: { ACTIVE: "Ativo", PENDING: "Pendente", PUBLISHED: "Publicado" },
    pending: false,
    onEditRecord: vi.fn(),
    onLifecycleAction: vi.fn(),
    onAddAdmin: vi.fn(),
    onAdminAction: vi.fn(),
    onAddDomain: vi.fn(),
    onEditDomain: vi.fn(),
    onSaveAddress: vi.fn().mockResolvedValue(true),
    generated: null,
    onDismissGenerated: vi.fn(),
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render() {
  await act(async () => root.render(createElement(SiteSettingsView, props)));
}
async function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`Missing action ${label}`);
  await act(async () => button.click());
}

describe("owner settings overview", () => {
  it("offers explicit approval when an active legacy wedding has no term", async () => {
    props.site.termStartsOn = null;
    props.site.termEndsOn = null;
    await render();
    await click("Aprovar e iniciar vigência");
    expect(props.onLifecycleAction).toHaveBeenCalledExactlyOnceWith(
      "review/approve",
    );
    expect(props.onEditRecord).not.toHaveBeenCalled();
  });

  it("shows the wedding data and keeps access and publication in their own sections", async () => {
    await render();
    expect(container.textContent).toContain("12/06/2027");
    expect(container.textContent).toContain("https://wedding.example.test");
    expect(container.textContent).not.toContain("Registrar publicação");
    await click("Publicação");
    expect(container.textContent).toContain("Publicação do site");
    await click("Acessos do casal");
    expect(container.textContent).toContain(
      "Nenhuma pessoa do casal cadastrada.",
    );
    expect(container.textContent).not.toContain("Registrar publicação");
  });

  it("only asks to link the public address while the site is unlinked", async () => {
    await render();
    expect(container.textContent).toContain("wedding.example.test");
    expect(container.textContent).not.toContain(
      "Vincule o endereço quando o site estiver no ar.",
    );
    props.site.publicUrl = null;
    await render();
    expect(container.textContent).toContain("Site não vinculado");
    expect(container.textContent).toContain(
      "Vincule o endereço quando o site estiver no ar.",
    );
  });

  it("submits the public address and trusted origins independently", async () => {
    await render();
    await click("Endereço do site");
    const slug = container.querySelector<HTMLInputElement>(
      "#site-repository-slug",
    );
    expect(slug?.readOnly).toBe(true);
    expect(slug?.value).toBe("maria-joao");
    const address =
      container.querySelector<HTMLInputElement>("#site-public-url");
    const origins = container.querySelector<HTMLTextAreaElement>(
      "#site-trusted-origins",
    );
    if (!address || !origins) throw new Error("Missing address forms");
    const submit = (form: HTMLFormElement | null) =>
      act(async () =>
        form?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
      );
    address.value = "https://wedding.example.test/invalid";
    await submit(address.form);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "endereço público",
    );
    expect(props.onSaveAddress).not.toHaveBeenCalled();
    address.value = "https://wedding.example.test";
    await submit(address.form);
    origins.value = "https://guest.example.test";
    await submit(origins.form);
    expect(props.onSaveAddress).toHaveBeenNthCalledWith(1, {
      publicUrl: "https://wedding.example.test",
    });
    expect(props.onSaveAddress).toHaveBeenNthCalledWith(2, {
      trustedOrigins: ["https://guest.example.test"],
    });
  });

  it("keeps each core edit and lifecycle action connected to its existing flow", async () => {
    await render();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Editar nome do casamento"]',
        )
        ?.click(),
    );
    await click("Datas e vigência");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Editar vigência"]')
        ?.click(),
    );
    await click("Publicação");
    await click("Registrar publicação");
    expect(props.onEditRecord).toHaveBeenNthCalledWith(1, "profile");
    expect(props.onEditRecord).toHaveBeenNthCalledWith(2, "dates");
    expect(props.onEditRecord).toHaveBeenNthCalledWith(3, "publication");
    await click("Inativar casamento");
    expect(props.onLifecycleAction).toHaveBeenCalledExactlyOnceWith(
      "deactivate",
    );
  });

  it("preserves person-specific access actions and domain editing", async () => {
    const admin = {
      userId: "person-one",
      siteId: "site-one",
      role: "SITE_ADMIN" as const,
      name: "Ana",
      email: "ana@example.test",
      state: "PENDING" as const,
      pendingAccess: {
        purpose: "ACTIVATION" as const,
        expiresAt: "2027-01-01T00:00:00.000Z",
      },
    };
    const domain = {
      id: "domain-one",
      siteId: "site-one",
      hostname: "wedding.example.test",
      state: "ACTIVE" as const,
      isPrimary: true,
      expiresOn: "2027-01-10",
      verifiedAt: null,
      createdAt: "2026-01-10T00:00:00Z",
      updatedAt: "2026-01-10T00:00:00Z",
    };
    props.admins = [admin];
    props.domains = [domain];
    await render();
    await click("Acessos do casal");
    expect(container.textContent).toContain("ana@example.test");
    await click("Gerar novo link");
    expect(props.onAdminAction).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "O link anterior deixará de funcionar",
    );
    await click("Confirmar novo link");
    expect(props.onAdminAction).toHaveBeenCalledWith("issue-access", admin);
    await click("Revogar link");
    expect(props.onAdminAction).toHaveBeenCalledWith("revoke-access", admin);
    await click("Desativar acesso");
    expect(props.onAdminAction).toHaveBeenCalledWith("disable-access", admin);
    await click("Endereço do site");
    expect(container.textContent).toContain("Principal");
    await click("Editar domínio");
    expect(props.onEditDomain).toHaveBeenCalledExactlyOnceWith(domain);
  });

  it("blocks all settings actions during a pending mutation", async () => {
    props.pending = true;
    await render();
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    await click("Inativar casamento");
    expect(props.onLifecycleAction).not.toHaveBeenCalled();
    expect(props.onAddAdmin).not.toHaveBeenCalled();
  });
});

describe("owner settings status strip and dates", () => {
  it("leads the strip with the next lifecycle step and keeps other actions in the menu", async () => {
    props.site.lifecycle = "DRAFT";
    props.labels = { ...props.labels, DRAFT: "Rascunho" };
    await render();
    const strip = container.querySelector(
      '[aria-label="Situação do casamento"]',
    );
    expect(strip?.textContent).toContain("Rascunho");
    expect(strip?.textContent).toContain("Casamento em rascunho");
    const menu = container.querySelector(
      '[aria-label="Ações da situação do casamento"]',
    );
    expect(menu?.textContent).not.toContain("Enviar para revisão");
    await click("Enviar para revisão");
    expect(props.onLifecycleAction).toHaveBeenCalledExactlyOnceWith(
      "review/start",
    );
  });

  it("describes the active term in the strip", async () => {
    await render();
    const strip = container.querySelector(
      '[aria-label="Situação do casamento"]',
    );
    expect(strip?.textContent).toContain("Casamento ativo");
    expect(strip?.textContent).toContain(
      "Vigência de 12/06/2026 a 12/06/2027. A publicação é conferida separadamente.",
    );
  });

  it("shows the wedding weekday, countdown and recorded approval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-06-02T12:00:00.000Z"));
    try {
      props.site = {
        ...props.site,
        reviewApprovedAt: "2026-06-12T15:00:00.000Z",
      };
      await render();
      await click("Datas e vigência");
      const text = container.textContent ?? "";
      expect(text).toContain("Data do evento e período contratado.");
      expect(text).toContain("Sábado · faltam 10 dias");
      expect(text).toContain("Aprovado em 12/06/2026");
      expect(text).toContain("Período contratado: 12/06/2026 a 12/06/2027.");
      props.site = { ...props.site, reviewApprovedAt: null };
      await render();
      expect(container.textContent).toContain("Ainda não aprovado");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("owner couple access rows", () => {
  it("identifies each person with initials and keeps the status in its own column", async () => {
    props.admins = [
      {
        userId: "person-one",
        siteId: "site-one",
        role: "SITE_ADMIN",
        name: "Rita Souza",
        email: "rita@example.test",
        state: "ACTIVE",
        pendingAccess: null,
      },
    ];
    await render();
    await click("Acessos do casal");
    const row = container.querySelector('[data-slot="couple-access-row"]');
    expect(row?.querySelector('[data-slot="person-avatar"]')?.textContent).toBe(
      "RS",
    );
    expect(row?.textContent).toContain("rita@example.test");
    expect(
      row?.querySelector(
        '[data-slot="access-status"] [data-slot="status-badge"]',
      )?.textContent,
    ).toBe("Acesso ativado");
    expect(
      row?.querySelector('[data-slot="access-actions"]')?.textContent,
    ).toContain("Gerar link de recuperação");
    expect(container.textContent).toContain("1 pessoa");
  });
});

describe("owner publication and access link lifetime", () => {
  it("addresses the owner who records the manual publication", async () => {
    await render();
    await click("Publicação");
    const text = container.textContent ?? "";
    expect(text).toContain("A equipe Entrelaços publica o site");
    expect(text).toContain("Confira o site no ar");
    expect(text).toContain("Esta ação não altera a hospedagem.");
    expect(text).not.toMatch(/Vocês abrem|Vocês conferem|Registrem/);
  });

  it("lists every publication state as a badge and separates it from the wedding lifecycle", async () => {
    props.labels = {
      ...props.labels,
      UNPUBLISHED: "Não publicado",
      PLACEHOLDER: "Página neutra",
    };
    await render();
    await click("Publicação");
    const badges = Array.from(
      container.querySelectorAll(
        'section:not([aria-label]) [data-slot="status-badge"]',
      ),
    ).map((badge) => badge.textContent);
    expect(badges).toEqual([
      "Publicado",
      "Não publicado",
      "Publicado",
      "Página neutra",
    ]);
    expect(container.textContent).toContain(
      "é independente da publicação. Reativar ou inativar o casamento não publica nem tira o site do ar.",
    );
  });

  it("does not bring back a link generated before the access tab was reopened", async () => {
    window.history.replaceState(null, "", "/sites/site-1/settings?tab=access");
    props.generated = { userId: "admin-1", url: "https://panel/ativar#x" };
    try {
      await render();
      expect(props.onDismissGenerated).toHaveBeenCalled();
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });
});
