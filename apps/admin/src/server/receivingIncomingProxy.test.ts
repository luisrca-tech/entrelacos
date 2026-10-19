import { afterEach, expect, it, vi } from "vitest";
import { proxyApiRequest } from "./apiProxy";

afterEach(() => vi.unstubAllGlobals());

it("forwards explicit incoming account confirmation with the signed session", async () => {
  const response = {
    readiness: {
      siteId: "site-one",
      state: "READY",
      reason: null,
      observedAt: "2026-10-16T12:00:00.000Z",
      destinationVersion: 1,
      catalogEligible: true,
      mode: "sandbox",
    },
  };
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(response));
  vi.stubGlobal("fetch", fetcher);
  const result = await proxyApiRequest(
    new Request(
      "https://panel.example.test/api/v1/sites/site-one/receiving/incoming-verification",
      {
        method: "POST",
        headers: {
          Origin: "https://panel.example.test",
          "Content-Type": "application/json",
          Cookie: "session=signed-session",
        },
        body: JSON.stringify({ confirmIncomingAccount: true }),
      },
    ),
    {
      apiBaseUrl: "https://api.example.test",
      adminOrigin: "https://panel.example.test",
    },
  );
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual(response);
  expect(fetcher).toHaveBeenCalledWith(
    "https://api.example.test/v1/sites/site-one/receiving/incoming-verification",
    expect.objectContaining({ method: "POST", redirect: "manual" }),
  );
  const options = fetcher.mock.calls[0]?.[1] as RequestInit | undefined;
  expect(new Headers(options?.headers).get("Cookie")).toBe(
    "session=signed-session",
  );
  expect(
    JSON.parse(new TextDecoder().decode(options?.body as ArrayBuffer)),
  ).toEqual({
    confirmIncomingAccount: true,
  });
});
