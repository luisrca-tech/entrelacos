import { describe, expect, it, vi } from "vitest";
import {
  createSite,
  defaultTermDates,
  type SiteDatabase,
  validateDateEditAgainstTerm,
} from "./sites";

describe("site lifecycle date rules", () => {
  it("clamps a leap-day approval term to February 28", () => {
    expect(defaultTermDates(new Date("2028-02-29T12:00:00.000Z"))).toEqual({
      startsOn: "2028-02-29",
      endsOn: "2029-02-28",
    });
  });

  it("requires persisted term dates and preserves the other side on partial edits", () => {
    expect(() =>
      validateDateEditAgainstTerm(undefined, {
        termStartsOn: null,
      }),
    ).toThrow();
    expect(
      validateDateEditAgainstTerm(
        { startsOn: "2026-01-01", endsOn: "2026-12-31" },
        { termStartsOn: "2026-02-01" },
      ),
    ).toEqual({ startsOn: "2026-02-01", endsOn: "2026-12-31" });
  });

  it("rejects reversed term edits", () => {
    expect(() =>
      validateDateEditAgainstTerm(
        { startsOn: "2026-01-01", endsOn: "2026-12-31" },
        { termEndsOn: "2025-12-31" },
      ),
    ).toThrow();
  });
});

describe("site creation race handling", () => {
  it("reuses a slug row when its provisioning key matches after the key lookup missed", async () => {
    const now = new Date("2028-02-29T12:00:00.000Z");
    const existing = {
      id: "existing-site",
      repositorySlug: "matching-slug",
      provisioningKey: "matching-key",
      displayName: "Existing Wedding",
      partnerOneName: "Ana",
      partnerTwoName: "João",
      eventDate: "2029-06-10",
      lifecycle: "DRAFT",
      previousLifecycle: null,
      publicationState: "UNPUBLISHED",
      publicUrl: null,
      reviewApprovedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const limits = [[], [{ id: existing.id }], [existing], []];
    let limitIndex = 0;
    const select = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => limits[limitIndex++]),
          orderBy: vi.fn(async () => [
            { origin: "https://matching.example.test" },
          ]),
        })),
      })),
    }));
    const transaction = vi.fn(async (callback: (tx: unknown) => unknown) =>
      callback({
        select,
        insert: vi.fn(),
      }),
    );
    const db = { transaction } as unknown as SiteDatabase;

    const result = await createSite(
      db,
      {
        repositorySlug: "matching-slug",
        provisioningKey: "matching-key",
        displayName: "Incoming Wedding",
        coupleNames: ["New", "Names"],
        eventDate: "2030-01-01",
      },
      now,
    );

    expect(result.id).toBe(existing.id);
    expect(result.displayName).toBe(existing.displayName);
    expect(transaction).toHaveBeenCalledOnce();
  });
});
