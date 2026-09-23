import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "VenueSection.astro"),
  "utf8",
);

describe("VenueSection map and address fallback", () => {
  it("keeps the address selectable and renders host-owned map/actions", () => {
    expect(source).toContain("content.address");
    expect(source).toContain("content.fallback.href");
    expect(source).toContain("content.directions.href");
    expect(source).toContain("src={content.mapEmbedUrl}");
    expect(source).toContain("content.labels.mapTitle");
    expect(source).toContain("data-copy-address");
    expect(source).not.toContain("data-copy-status");
  });

  it("uses the shared copy helper and host-owned immediate feedback", () => {
    expect(source).toContain('import { copyAddress } from "../venue"');
    expect(source).toContain('import { publishToast } from "@entrelacos/ui/toast"');
    expect(source).toContain("button.dataset.copySuccess");
    expect(source).toContain("button.dataset.copyError");
    expect(source).toContain("publishToast(");
    expect(source).not.toContain("site-specific venue content");
  });
});
