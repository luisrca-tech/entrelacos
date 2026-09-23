import { describe, expect, it } from "vitest";
import { DEMO_RESET_DATASET_IDS } from "./demoReset";

describe("invitation demo dataset", () => {
  it("contains canonical invitations and guests without group identifiers", () => {
    expect(DEMO_RESET_DATASET_IDS.invitationIds).toHaveLength(5);
    expect(DEMO_RESET_DATASET_IDS.guestIds).toHaveLength(10);
    expect(DEMO_RESET_DATASET_IDS).not.toHaveProperty("groupIds");
    expect(DEMO_RESET_DATASET_IDS).not.toHaveProperty("memberIds");
  });
});
