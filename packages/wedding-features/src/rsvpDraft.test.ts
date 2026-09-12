import { describe, expect, it } from "vitest";
import {
  confirmAllDraft,
  createRsvpDraft,
  pendingRsvpUpdates,
  reconcileRsvpDraft,
  setDraftStatus,
} from "./rsvpDraft";

const members = [
  { memberId: "member-a", status: "PENDING" as const, revision: 0 },
  { memberId: "member-b", status: "DECLINED" as const, revision: 2 },
];

describe("RSVP draft", () => {
  it("keeps confirm-all local until an explicit save reads pending updates", () => {
    const initial = createRsvpDraft(members);
    const confirmed = confirmAllDraft(initial);

    expect(initial["member-a"]?.status).toBe("PENDING");
    expect(confirmed["member-a"]?.status).toBe("CONFIRMED");
    expect(pendingRsvpUpdates(confirmed)).toEqual([
      { memberId: "member-a", status: "CONFIRMED", expectedRevision: 0 },
      { memberId: "member-b", status: "CONFIRMED", expectedRevision: 2 },
    ]);
  });

  it("submits only changed members and supports a partial response", () => {
    const draft = setDraftStatus(
      createRsvpDraft(members),
      "member-a",
      "CONFIRMED",
    );

    expect(pendingRsvpUpdates(draft)).toEqual([
      { memberId: "member-a", status: "CONFIRMED", expectedRevision: 0 },
    ]);
  });

  it("preserves local selections while refreshing revisions after conflict", () => {
    const draft = setDraftStatus(
      createRsvpDraft(members),
      "member-a",
      "CONFIRMED",
    );
    const reconciled = reconcileRsvpDraft(draft, [
      { memberId: "member-a", status: "DECLINED", revision: 1 },
      { memberId: "member-b", status: "DECLINED", revision: 2 },
    ]);

    expect(reconciled["member-a"]).toEqual({
      status: "CONFIRMED",
      persistedStatus: "DECLINED",
      revision: 1,
    });
    expect(pendingRsvpUpdates(reconciled)).toEqual([
      { memberId: "member-a", status: "CONFIRMED", expectedRevision: 1 },
    ]);
  });
});
