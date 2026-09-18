import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sectionSource = readFileSync(
  resolve(import.meta.dirname, "GuestGroupsSection.tsx"),
  "utf8",
);
const shellSource = readFileSync(
  resolve(import.meta.dirname, "AdminShell.tsx"),
  "utf8",
);

describe("guest groups PIN copy", () => {
  it("copies the PIN and toasts success instead of revealing a card", () => {
    expect(sectionSource).toContain('action === "copy-pin"');
    expect(sectionSource).toContain("toast.success");
    expect(sectionSource).toContain("copyGuestAccessPin");
    expect(sectionSource).not.toContain("reveal-pin");
    expect(sectionSource).not.toContain("Exibir PIN");
    expect(sectionSource).not.toContain("Ocultar PIN");
    expect(sectionSource).not.toContain("PIN de acesso ·");
    expect(sectionSource).not.toContain("setAccessPin");
  });

  it("toasts PIN rotation instead of an inline status", () => {
    expect(sectionSource).toContain(
      "toast.success(guestAccessPinRotatedMessage)",
    );
    expect(sectionSource).not.toMatch(
      /setNotice\(\s*"Novo PIN gerado\. O PIN anterior e os acessos ativos foram revogados\."/,
    );
  });

  it("keeps the demo grant card and does not reuse it for PINs", () => {
    expect(sectionSource).toContain("demoGrant");
    expect(sectionSource).toContain("bg-admin-beige");
    expect(sectionSource).not.toMatch(
      /accessPin && \([\s\S]*className="demo-guest-grant"/,
    );
  });
});

describe("admin toaster", () => {
  it("mounts the shared toaster in the hydrated shell so PIN actions can notify at the top center", () => {
    expect(shellSource).toContain("<Toaster />");
  });
});
