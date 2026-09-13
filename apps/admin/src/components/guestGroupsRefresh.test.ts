import { describe, expect, it, vi } from "vitest";
import {
  emitGuestGroupsChanged,
  listenForGuestGroupsChanged,
} from "./guestGroupsRefresh";

describe("guest group refresh events", () => {
  it("refreshes only consumers for the changed site and removes listeners", () => {
    const target = new EventTarget();
    const matching = vi.fn();
    const foreign = vi.fn();
    const stopMatching = listenForGuestGroupsChanged(
      target,
      "site-one",
      matching,
    );
    listenForGuestGroupsChanged(target, "site-two", foreign);

    emitGuestGroupsChanged(target, "site-one");
    expect(matching).toHaveBeenCalledOnce();
    expect(foreign).not.toHaveBeenCalled();

    stopMatching();
    emitGuestGroupsChanged(target, "site-one");
    expect(matching).toHaveBeenCalledOnce();
  });
});
