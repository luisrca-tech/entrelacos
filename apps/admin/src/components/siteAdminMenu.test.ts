import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { adminAccessLink, copyAdminAccessLink } from "./siteAdminMenu";

it("puts generated activation and recovery tokens in the URL fragment", () => {
  expect(
    adminAccessLink("https://panel.example.test", "sample", "ACTIVATION"),
  ).toBe("https://panel.example.test/activate#token=sample");
  expect(
    adminAccessLink("https://panel.example.test", "sample", "RECOVERY"),
  ).toBe("https://panel.example.test/recover#token=sample");
});

it("returns the clipboard outcome without modifying the link", async () => {
  const writeText = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("denied"));
  await expect(
    copyAdminAccessLink("https://panel.example.test/activate#token=sample", {
      writeText,
    }),
  ).resolves.toBe(true);
  await expect(
    copyAdminAccessLink("https://panel.example.test/activate#token=sample", {
      writeText,
    }),
  ).resolves.toBe(false);
  expect(writeText).toHaveBeenCalledWith(
    "https://panel.example.test/activate#token=sample",
  );
});

it("revokes the stored pending purpose without issuing a replacement", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "SiteWorkspace.tsx"),
    "utf8",
  );
  const revoke = source.slice(
    source.indexOf("async function revokeAccess"),
    source.indexOf("function handleAdminMenuAction"),
  );
  expect(revoke).toContain("admin.pendingAccess?.purpose");
  expect(revoke).toContain("/access/revoke");
  expect(revoke).not.toContain("issueWorkspaceAccess");
});
