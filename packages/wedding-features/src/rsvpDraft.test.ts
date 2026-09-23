import { describe, expect, it } from "vitest";
import {
  confirmAllDraft,
  createRsvpDraft,
  pendingRsvpUpdates,
  reconcileRsvpDraft,
  setDraftStatus,
} from "./rsvpDraft";

const guests = [
  { guestId: "guest-a", state: "PENDING" as const, revision: 0 },
  { guestId: "guest-b", state: "DECLINED" as const, revision: 2 },
];

describe("RSVP draft", () => {
  it("keeps confirm-all local until an explicit save reads pending updates", () => {
    const initial = createRsvpDraft(guests);
    const confirmed = confirmAllDraft(initial);

    expect(initial["guest-a"]?.state).toBe("PENDING");
    expect(confirmed["guest-a"]?.state).toBe("CONFIRMED");
    expect(pendingRsvpUpdates(confirmed)).toEqual([
      { guestId: "guest-a", state: "CONFIRMED", expectedRevision: 0 },
      { guestId: "guest-b", state: "CONFIRMED", expectedRevision: 2 },
    ]);
  });

  it("submits only changed guests and supports a partial response", () => {
    const draft = setDraftStatus(
      createRsvpDraft(guests),
      "guest-a",
      "CONFIRMED",
    );

    expect(pendingRsvpUpdates(draft)).toEqual([
      { guestId: "guest-a", state: "CONFIRMED", expectedRevision: 0 },
    ]);
  });

  it("preserves local selections while refreshing revisions after conflict", () => {
    const draft = setDraftStatus(
      createRsvpDraft(guests),
      "guest-a",
      "CONFIRMED",
    );
    const reconciled = reconcileRsvpDraft(draft, [
      { guestId: "guest-a", state: "DECLINED", revision: 1 },
      { guestId: "guest-b", state: "DECLINED", revision: 2 },
    ]);

    expect(reconciled["guest-a"]).toEqual({
      state: "CONFIRMED",
      persistedState: "DECLINED",
      revision: 1,
    });
    expect(pendingRsvpUpdates(reconciled)).toEqual([
      { guestId: "guest-a", state: "CONFIRMED", expectedRevision: 1 },
    ]);
  });
});
