import { describe, expect, it, vi } from "vitest";
import {
  emitInvitationsChanged,
  listenForInvitationsChanged,
} from "./invitationsRefresh";

describe("invitation refresh event", () => {
  it("notifies only listeners for the matching wedding", () => {
    const target = new EventTarget();
    const matching = vi.fn();
    const foreign = vi.fn();
    const stop = listenForInvitationsChanged(target, "site-one", matching);
    listenForInvitationsChanged(target, "site-two", foreign);
    emitInvitationsChanged(target, "site-one");
    expect(matching).toHaveBeenCalledOnce();
    expect(foreign).not.toHaveBeenCalled();
    stop();
    emitInvitationsChanged(target, "site-one");
    expect(matching).toHaveBeenCalledOnce();
  });
});
