import { describe, expect, it } from "vitest";
import {
  lifecycleConfirmation,
  siteLifecycleMenuActions,
} from "./siteLifecyclePresentation";

describe("site lifecycle presentation", () => {
  it("offers approval only when an active wedding has no existing term", () => {
    expect(
      siteLifecycleMenuActions("ACTIVE", false).map((action) => action.id),
    ).toEqual(["review/approve", "deactivate"]);
    expect(
      siteLifecycleMenuActions("ACTIVE", true).map((action) => action.id),
    ).toEqual(["deactivate"]);
  });

  it.each([
    ["DRAFT", ["review/start", "deactivate"]],
    ["IN_REVIEW", ["review/approve", "deactivate"]],
    ["ACTIVE", ["deactivate"]],
    ["INACTIVE", ["reactivate"]],
  ] as const)(
    "offers only applicable actions for %s",
    (lifecycle, expected) => {
      expect(
        siteLifecycleMenuActions(lifecycle).map((action) => action.id),
      ).toEqual(expected);
    },
  );

  it("marks deactivation as destructive and explains preserved data and publication", () => {
    expect(siteLifecycleMenuActions("ACTIVE")[0]).toMatchObject({
      id: "deactivate",
      variant: "destructive",
    });
    expect(lifecycleConfirmation.deactivate.description).toMatch(
      /dados.*preservados/i,
    );
    expect(lifecycleConfirmation.deactivate.description).toMatch(
      /publicação.*separadamente/i,
    );
  });

  it("explains approval and reactivation without promising automatic publishing", () => {
    expect(lifecycleConfirmation["review/approve"].description).toContain(
      "um ano",
    );
    expect(lifecycleConfirmation.reactivate.description).toContain(
      "publicação",
    );
    for (const confirmation of Object.values(lifecycleConfirmation)) {
      expect(confirmation.title).toBeTruthy();
      expect(confirmation.confirmLabel).toBeTruthy();
      expect(confirmation.description).not.toContain("servidor");
    }
  });
});
