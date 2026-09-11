import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import type { AuthHttpOptions } from "./authHttp";

describe("API composition", () => {
  it("mounts protected authentication routes without requiring a session for liveness", async () => {
    const getSession = vi.fn().mockResolvedValue(null);
    const options = {
      auth: { api: { getSession } },
      db: {},
      adminOrigin: "https://panel.example.test",
    } as unknown as AuthHttpOptions;
    const api = createApp(options);
    expect((await api.request("/v1/health")).status).toBe(200);
    expect(getSession).not.toHaveBeenCalled();
    const me = await api.request("/v1/me", {
      headers: { Origin: options.adminOrigin },
    });
    expect(me.status).toBe(401);
    expect(await me.json()).toMatchObject({ code: "UNAUTHORIZED" });
    expect(getSession).toHaveBeenCalledOnce();
    for (const path of [
      "/v1/owner/sites",
      "/v1/owner/sites/one/admins",
      "/v1/sites/one",
    ]) {
      const response = await api.request(path, {
        headers: { Origin: options.adminOrigin },
      });
      expect(response.status).toBe(401);
    }
    const handoff = await api.request("/v1/handoff", {
      method: "POST",
      headers: { Origin: options.adminOrigin },
    });
    expect(handoff.status).toBe(401);
  });
});
