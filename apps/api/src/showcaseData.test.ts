import { describe, expect, it } from "vitest";
import {
  assertShowcaseSource,
  showcaseConfiguration,
  showcaseFamilies,
  showcaseGifts,
  showcaseMessages,
} from "./showcaseData";

const source = {
  id: "demo-wedding",
  is_demo: true,
  repository_slug: "demo-wedding",
  partner_one_name: "Marina",
  partner_two_name: "Caio",
  event_date: "2027-09-18",
  lifecycle: "ACTIVE",
  publication_state: "PUBLISHED",
  public_url: "https://demo-dev.entrelacos.workers.dev/",
};
describe("controlled showcase population", () => {
  it("keeps environment URLs and identities distinct", () => {
    expect(
      showcaseConfiguration(
        "development",
        "POPULATE development EntreLacos showcases",
      ).lettersOrigin,
    ).toBe("https://demo-cartas-dev.entrelacos.workers.dev");
    expect(
      showcaseConfiguration(
        "production",
        "POPULATE production EntreLacos showcases",
        true,
      ).lettersOrigin,
    ).toBe("https://demo-cartas.entrelacos.workers.dev");
    expect(() =>
      showcaseConfiguration(
        "production",
        "POPULATE development EntreLacos showcases",
      ),
    ).toThrow();
    expect(() =>
      showcaseConfiguration("test", "POPULATE test EntreLacos showcases"),
    ).toThrow();
  });
  it("requires explicit production authorization", () => {
    expect(() =>
      showcaseConfiguration(
        "production",
        "POPULATE production EntreLacos showcases",
        false,
      ),
    ).toThrow();
    expect(
      showcaseConfiguration(
        "production",
        "POPULATE production EntreLacos showcases",
        true,
      ).target,
    ).toBe("production");
  });
  it("refuses genuine sites, wrong identities, unpublished sites and an environment mismatch", () => {
    const config = showcaseConfiguration(
      "development",
      "POPULATE development EntreLacos showcases",
    );
    expect(() => assertShowcaseSource(source, config)).not.toThrow();
    for (const patch of [
      { is_demo: false },
      { id: "customer-wedding" },
      { repository_slug: "customer" },
      { partner_one_name: "Another" },
      { event_date: "2028-01-01" },
      { lifecycle: "INACTIVE" },
      { publication_state: "UNPUBLISHED" },
      { public_url: "https://demo.entrelacos.workers.dev/" },
    ])
      expect(() =>
        assertShowcaseSource({ ...source, ...patch }, config),
      ).toThrow();
    expect(() => assertShowcaseSource(undefined, config)).toThrow();
  });
  it("uses fictional reserved phones and varied RSVP states without personal contact data", () => {
    expect(new Set(showcaseFamilies.map((family) => family.slug)).size).toBe(
      showcaseFamilies.length,
    );
    for (const family of showcaseFamilies)
      expect(family.phone).toMatch(/^\+120255501\d{2}$/);
    expect(
      new Set(
        showcaseFamilies.flatMap((family) =>
          family.guests.map((guest) => guest.state),
        ),
      ),
    ).toEqual(new Set(["CONFIRMED", "PENDING", "DECLINED"]));
  });
  it("provides coherent gift data and identifies illustrative guest messages", () => {
    expect(showcaseGifts.length).toBeGreaterThanOrEqual(4);
    for (const gift of showcaseGifts) {
      expect(gift.cents).toBeGreaterThan(0);
      expect(gift.cents).toBeLessThanOrEqual(300000);
      expect(gift.alt.length).toBeGreaterThan(10);
      expect(gift.sourcePage).toMatch(/^https:\/\/unsplash.com\/photos\//);
    }
    for (const message of showcaseMessages) {
      expect(message.author).toContain("exemplo");
      expect(message.text.length).toBeLessThanOrEqual(1000);
    }
  });
});
