import type { MeResponse } from "@entrelacos/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../lib/apiClient";
import {
  getCachedPanelActor,
  loadPanelActor,
  resetPanelActorCache,
} from "./panelActor";

vi.mock("../lib/apiClient", () => ({
  apiRequest: vi.fn(),
}));

const apiRequestMock = vi.mocked(apiRequest);

const actor = {
  user: {
    id: "user-1",
    name: "Test User",
    email: "user@example.test",
    role: "OWNER",
  },
  siteId: null,
} as MeResponse;

describe("panel actor loading", () => {
  afterEach(() => {
    resetPanelActorCache();
    vi.resetAllMocks();
  });

  it("shares the bootstrap request and reuses the actor on sibling mounts", async () => {
    let resolveRequest!: (value: MeResponse) => void;
    apiRequestMock.mockReturnValueOnce(
      new Promise<MeResponse>((resolve) => {
        resolveRequest = resolve;
      }),
    );

    const first = loadPanelActor();
    const second = loadPanelActor();

    expect(first).toBe(second);
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
    expect(getCachedPanelActor()).toBeNull();

    resolveRequest(actor);
    await expect(first).resolves.toBe(actor);
    expect(getCachedPanelActor()).toBe(actor);

    await expect(loadPanelActor()).resolves.toBe(actor);
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
  });
});
