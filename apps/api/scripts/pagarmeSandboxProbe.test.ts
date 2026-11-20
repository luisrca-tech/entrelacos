import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  readProbeEnvironment,
  runPagarmeSandboxProbe,
} from "./pagarmeSandboxProbe";

const env = {
  PAGARME_MODE: "test",
  PAGARME_SECRET_KEY: "sk_test_probeSecretKey123",
  PAGARME_PLATFORM_RECIPIENT_ID: "rp_platformFixture01",
  PAGARME_PUBLIC_KEY: "pk_test_probePublicKey123",
};

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../src/__fixtures__/pagarme/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
}

function fakePagarme() {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname.endsWith("/tokens")) return json({ id: "token_probe123" });
    if (method === "POST" && url.pathname.endsWith("/recipients"))
      return json({
        ...(fixture("recipient-created") as object),
        code: JSON.parse(String(init?.body)).code,
      });
    if (url.pathname.endsWith("/kyc_link"))
      return json({
        ...(fixture("recipient-kyc-link") as object),
        expires_at: new Date(Date.now() + 20 * 60_000).toISOString(),
      });
    if (url.pathname.includes("/recipients/"))
      return json(fixture("recipient-active"));
    if (method === "POST" && url.pathname.endsWith("/orders"))
      return json(fixture("order-card-paid"));
    if (url.pathname.endsWith("/payables")) {
      const list = fixture("payables-list") as { data: object[] };
      return json({
        ...list,
        data: list.data.map((payable) => ({
          ...payable,
          recipient_id: url.searchParams.get("recipient_id"),
        })),
      });
    }
    return new Response("{}", { status: 404 });
  });
}

describe("Pagar.me sandbox probe", () => {
  it.each([
    [{ ...env, PAGARME_MODE: "live" }, "PAGARME_MODE=test"],
    [{ ...env, PAGARME_SECRET_KEY: "sk_live123" }, "sk_test_"],
    [{ ...env, PAGARME_PLATFORM_RECIPIENT_ID: "acc_1" }, "rp_"],
    [{ ...env, PAGARME_PUBLIC_KEY: "pk_live1" }, "pk_test_"],
  ])("refuses anything but the sandbox (%#)", (input, message) => {
    expect(() => readProbeEnvironment(input)).toThrow(message);
  });

  it("creates a recipient and a 6x split order, printing payables but no secrets", async () => {
    const fetch = fakePagarme();
    const lines: string[] = [];
    await runPagarmeSandboxProbe(env, ["all"], {
      fetch: fetch as typeof globalThis.fetch,
      log: (line) => lines.push(line),
    });
    const order = fetch.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/orders") && init?.method === "POST",
    );
    const body = JSON.parse(String(order?.[1]?.body));
    expect(body.payments[0].credit_card).toMatchObject({
      card_token: "token_probe123",
      card: {
        billing_address: {
          line_1: "1000, Avenida Paulista, Bela Vista",
          zip_code: "01310100",
          city: "Sao Paulo",
          state: "SP",
          country: "BR",
        },
      },
      installments: 6,
    });
    const recipient = fetch.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/recipients") && init?.method === "POST",
    );
    expect(
      JSON.parse(String(recipient?.[1]?.body)).register_information.address
        .complementary,
    ).toBe("Sem complemento");
    expect(body.payments[0].split).toHaveLength(2);
    const output = lines.join("\n");
    expect(output).toMatch(/payables platform rp_platformFixture01/);
    expect(output).toMatch(/payables couple rp_/);
    expect(output).toMatch(/kyc_link expires in about 20 min/);
    for (const secret of [
      env.PAGARME_SECRET_KEY,
      env.PAGARME_PUBLIC_KEY,
      "token_probe123",
      "4000000000000010",
    ])
      expect(output).not.toContain(secret);
  });
});
