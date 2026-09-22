import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { rsvpFilterLabel, rsvpGroupLabel } from "./RsvpSection";

const rsvpSource = readFileSync(
  resolve(import.meta.dirname, "RsvpSection.tsx"),
  "utf8",
);
const guestSource = readFileSync(
  resolve(import.meta.dirname, "GuestGroupsSection.tsx"),
  "utf8",
);

describe("RSVP cards follow guest group card chrome", () => {
  it("renders each RSVP group as a Card with the guest-group header pattern", () => {
    expect(guestSource).toContain("rounded-[10px]");
    expect(rsvpSource).toContain("rounded-[10px]");
    expect(rsvpSource).toContain(
      'className="flex w-full flex-row items-start justify-between"',
    );
    expect(rsvpSource).toContain('<Badge variant="outline">');
    expect(rsvpSource).not.toContain('className="rsvp-group"');
    expect(rsvpSource).not.toContain("<Table");
  });

  it("keeps the export card on the same surface as guest group cards", () => {
    expect(rsvpSource).toContain("border-admin-line");
    expect(rsvpSource).toContain("bg-admin-surface");
  });

  it("places compact export actions in the card header", () => {
    expect(rsvpSource).toContain("CardAction");
    expect(rsvpSource).toMatch(/CardAction[\s\S]*Baixar CSV/);
    expect(rsvpSource).toMatch(/CardAction[\s\S]*Baixar PDF/);
    expect(rsvpSource).toContain('size="sm"');
  });

  it("opens RSVP filters only from the select trigger", () => {
    expect(rsvpSource).not.toContain('htmlFor="rsvp-group-filter"');
    expect(rsvpSource).not.toContain('htmlFor="rsvp-state-filter"');
    expect(rsvpSource).not.toContain('htmlFor="rsvp-history-group"');
    expect(rsvpSource).not.toContain('htmlFor="rsvp-history-member"');
    expect(rsvpSource).not.toContain('htmlFor="rsvp-history-actor"');
    expect(rsvpSource).toContain('aria-labelledby="rsvp-group-filter-label"');
  });

  it("formats RSVP filter values with their human labels", () => {
    expect(
      rsvpFilterLabel(
        "CONFIRMED",
        {
          all: "Todos",
          CONFIRMED: "Confirmado",
        },
        "Todos",
      ),
    ).toBe("Confirmado");
    expect(
      rsvpFilterLabel(
        "b7-group-declined",
        {
          all: "Todos",
          "b7-group-declined": "Família Ausente",
        },
        "Todos",
      ),
    ).toBe("Família Ausente");
    expect(rsvpFilterLabel("all", { all: "Todas" }, "Todas")).toBe("Todas");
    expect(rsvpFilterLabel("FAMILY", { FAMILY: "Família" }, "Todas")).toBe(
      "Família",
    );
  });

  it("localizes legacy demo group names without changing custom names", () => {
    expect(rsvpGroupLabel("b7-group-confirmed", "Confirmed Family")).toBe(
      "Família Confirmada",
    );
    expect(rsvpGroupLabel("b7-group-declined", "Declined Family")).toBe(
      "Família Ausente",
    );
    expect(rsvpGroupLabel("custom-group", "Família Silva")).toBe(
      "Família Silva",
    );
  });

  it("removes the member filter from RSVP history", () => {
    expect(rsvpSource).not.toContain("historyMemberId");
    expect(rsvpSource).not.toContain('id="rsvp-history-member"');
    expect(rsvpSource).toContain("historyActor");
  });

  it("pins the save action as a centered fixed footer", () => {
    expect(rsvpSource).toContain("fixed");
    expect(rsvpSource).toContain("w-[70%]");
  });
});
