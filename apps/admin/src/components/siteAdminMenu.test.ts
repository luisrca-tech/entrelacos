import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  adminAccessLink,
  adminAccessLinkCopiedMessage,
  adminAccessLinkCopyFailedMessage,
  adminAccessLinkRevokedMessage,
  copyAdminAccessLink,
  siteAdminMenuActions,
} from "./siteAdminMenu";

const workspaceSource = readFileSync(
  resolve(import.meta.dirname, "SiteWorkspace.tsx"),
  "utf8",
);

describe("site admin overflow actions", () => {
  it("offers issue, revoke, and disable for a pending administrator", () => {
    expect(siteAdminMenuActions("PENDING")).toEqual([
      {
        id: "issue-access",
        label: "Gerar link de ativação",
      },
      { id: "revoke-access", label: "Revogar link" },
      {
        id: "disable-access",
        label: "Desativar acesso",
        variant: "destructive",
      },
    ]);
  });

  it("labels the issue action as recovery for an active administrator", () => {
    expect(siteAdminMenuActions("ACTIVE")[0]).toEqual({
      id: "issue-access",
      label: "Gerar link de recuperação",
    });
  });

  it("hides overflow actions for a disabled administrator", () => {
    expect(siteAdminMenuActions("DISABLED")).toEqual([]);
  });

  it("renders administrator actions through the overflow menu", () => {
    expect(workspaceSource).toContain("OverflowMenu");
    expect(workspaceSource).toContain("siteAdminMenuActions");
    expect(workspaceSource).not.toContain("Gerar link de ativação");
  });
});

describe("admin access link copy", () => {
  it("builds activate and recover URLs from the issued token", () => {
    expect(
      adminAccessLink("https://admin.example", "token-a", "ACTIVATION"),
    ).toBe("https://admin.example/activate#token=token-a");
    expect(
      adminAccessLink("https://admin.example", "token-b", "RECOVERY"),
    ).toBe("https://admin.example/recover#token=token-b");
  });

  it("writes the link to the clipboard", async () => {
    const writes: string[] = [];

    await expect(
      copyAdminAccessLink("https://admin.example/activate#token=abc", {
        writeText: async (text) => {
          writes.push(text);
        },
      }),
    ).resolves.toBe(true);
    expect(writes).toEqual(["https://admin.example/activate#token=abc"]);
    expect(adminAccessLinkCopiedMessage("ana@example.com", "ACTIVATION")).toBe(
      "Link de ativação de ana@example.com copiado.",
    );
    expect(adminAccessLinkCopiedMessage("ana@example.com", "RECOVERY")).toBe(
      "Link de recuperação de ana@example.com copiado.",
    );
  });

  it("reports clipboard failure without throwing", async () => {
    await expect(
      copyAdminAccessLink("https://admin.example/activate#token=abc", {
        writeText: async () => {
          throw new Error("denied");
        },
      }),
    ).resolves.toBe(false);
    expect(adminAccessLinkCopyFailedMessage).toContain(
      "Não foi possível copiar",
    );
  });

  it("describes revocation plus copy for the success toast", () => {
    expect(adminAccessLinkRevokedMessage("ana@example.com", "ACTIVATION")).toBe(
      "Link anterior revogado. Link de ativação de ana@example.com copiado.",
    );
    expect(adminAccessLinkRevokedMessage("ana@example.com", "RECOVERY")).toBe(
      "Link anterior revogado. Link de recuperação de ana@example.com copiado.",
    );
  });

  it("copies the issued link and toasts instead of revealing a card", () => {
    expect(workspaceSource).toContain("copyAdminAccessLink");
    expect(workspaceSource).toContain("toast.success");
    expect(workspaceSource).toContain("adminAccessLinkCopiedMessage");
    expect(workspaceSource).toContain("toast.success(copiedMessage)");
    expect(workspaceSource).toContain("void revokeAccess(admin)");
    expect(workspaceSource).toMatch(
      /async function revokeAccess[\s\S]*issueAndCopy[\s\S]*adminAccessLinkRevokedMessage/,
    );
    expect(workspaceSource).not.toContain("setAccessLink");
    expect(workspaceSource).not.toContain("Link de acesso");
    expect(workspaceSource).not.toContain("Ocultar link");
  });
});
