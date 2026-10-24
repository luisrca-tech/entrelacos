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

  it("shows useful core values and leaves administrative details collapsed", async () => {
    await render();
    expect(container.textContent).toContain("Dados do casamento");
    expect(container.textContent).toContain("Datas e vigência");
    expect(container.textContent).toContain("Publicação do site");
    expect(container.textContent).toContain("12-06-2027");
    expect(container.textContent).toContain("https://wedding.example.test");
    const details = Array.from(container.querySelectorAll("details"));
    expect(details).toHaveLength(2);
    expect(details.every((detail) => !detail.open)).toBe(true);
    expect(details[0].querySelector("summary")?.textContent).toContain(
      "0 administradores",
    );
    expect(details[1].querySelector("summary")?.textContent).toContain(
      "0 endereços",
    );
    expect(container.textContent).toContain("Nenhum administrador cadastrado");
    expect(container.textContent).toContain("Nenhum domínio registrado");
  });

  it("keeps each core edit and lifecycle action connected to its existing flow", async () => {
    await render();
    await click("Editar cadastro");
    await click("Editar datas");
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
    expect(container.querySelector("summary")?.textContent).toContain(
      "1 administrador cadastrado",
    );
    expect(container.textContent).toContain("ana@example.test");
    expect(container.textContent).toContain("Principal");
    await click("Gerar link de ativação");
    expect(props.onAdminAction).toHaveBeenCalledWith("issue-access", admin);
    await click("Revogar link");
    expect(props.onAdminAction).toHaveBeenCalledWith("revoke-access", admin);
    await click("Desativar acesso");
    expect(props.onAdminAction).toHaveBeenCalledWith("disable-access", admin);
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
    await click("Adicionar administrador");
    expect(props.onAddAdmin).not.toHaveBeenCalled();
  });
});
