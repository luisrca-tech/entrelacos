import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  parseProbeArguments,
  readProbeEnvironment,
  runPagarmeSandboxProbe,
  runPagarmeSandboxProbeCli,
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

type Override = (
  url: URL,
  method: string,
  init?: RequestInit,
) => Response | undefined;

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function fakePagarme(override?: Override) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const overridden = override?.(url, method, init);
    if (overridden) return overridden;
    if (url.pathname.endsWith("/tokens")) return json({ id: "token_probe123" });
    if (method === "POST" && url.pathname.endsWith("/recipients"))
      return json({
        ...(fixture("recipient-created") as object),
        code: JSON.parse(String(init?.body)).code,
      });
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
    if (method === "POST" && url.pathname.endsWith("/transfers"))
      return json(fixture("transfer-pending"));
    if (url.pathname.includes("/transfers/"))
      return json(fixture("transfer-pending"));
    if (url.pathname.endsWith("/transfers"))
      return json(
        [
          {
            ...(fixture("transfer-pending") as object),
            id: 2,
            created_at: "2026-11-21T10:00:00Z",
          },
          {
            ...(fixture("transfer-pending") as object),
            id: 1,
            created_at: "2026-11-20T10:00:00Z",
          },
        ],
        200,
        { "x-cursor-nextpage": "cursor-abc" },
      );
    if (url.pathname.endsWith("/balance"))
      return json(fixture("recipient-balance"));
    if (url.pathname.includes("/recipients/"))
      return json(fixture("recipient-active"));
    return new Response("{}", { status: 404 });
  });
}

function postsTo(fetch: ReturnType<typeof fakePagarme>, path: string) {
  return fetch.mock.calls.filter(
    ([url, init]) =>
      new URL(String(url)).pathname.endsWith(path) && init?.method === "POST",
  );
}

async function runCli(argv: string[], fetch: ReturnType<typeof fakePagarme>) {
  const lines: string[] = [];
  const exitCode = await runPagarmeSandboxProbeCli(env, argv, {
    fetch: fetch as typeof globalThis.fetch,
    log: (line) => lines.push(line),
  });
  return { exitCode, output: lines.join("\n") };
}

function idempotencyKeyOf(init: RequestInit | undefined) {
  return (init?.headers as Record<string, string> | undefined)?.[
    "idempotency-key"
  ];
}

const couple = ["--recipient", "rp_fixtureRecipient01"];

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
    expect(output).toMatch(/recipient rp_\S+ status=\S+ kyc=\S+/);
    expect(output).not.toMatch(/kyc_link/);
    expect(
      fetch.mock.calls.some(([url]) => String(url).endsWith("/kyc_link")),
    ).toBe(false);
    for (const secret of [
      env.PAGARME_SECRET_KEY,
      env.PAGARME_PUBLIC_KEY,
      "token_probe123",
      "4000000000000010",
    ])
      expect(output).not.toContain(secret);
  });

  it.each([
    [["order", "--installments", "7"], "--installments"],
    [["order", "--installments", "0"], "--installments"],
    [["order", "--installments", "2x"], "--installments"],
    [["order", "--method", "boleto"], "--method"],
    [["order", "--no-split"], "--no-split"],
    [["order", "--method", "card", "--no-split"], "--no-split"],
    [["order", "--method", "pix", "--installments", "3"], "Pix"],
    [["order", "--gift-cents", "-5"], "--gift-cents"],
    [["transfer", "--recipient", "rp_fixtureRecipient01"], "--amount"],
    [["balance"], "--recipient"],
    [["transfer", ...couple, "--amount", "1.5"], "--amount"],
    [["bogus"], "Usage"],
    [["recipient", "--frobnicate"], "Unknown flag"],
  ])("refuses bad arguments %j", (argv, message) => {
    expect(() => parseProbeArguments(argv)).toThrow(message);
  });

  it("parses order defaults: 6x card with split on R$ 100,00", () => {
    expect(parseProbeArguments(["order"])).toMatchObject({
      command: "order",
      installments: 6,
      method: "card",
      giftCents: 10_000,
      split: true,
      repeatIdempotency: false,
    });
    expect(
      parseProbeArguments(["order", "--method", "pix", "--no-split"]),
    ).toMatchObject({ method: "pix", installments: 1, split: false });
  });

  it("prints the provider reason of a rejection without the secret and exits 1", async () => {
    const fetch = fakePagarme((url, method) =>
      method === "POST" && url.pathname.endsWith("/recipients")
        ? json(
            {
              message: `action_forbidden ${env.PAGARME_SECRET_KEY} this company doesn't have permission to change the anticipation parameters from default values`,
              errors: {
                "automatic_anticipation_settings.type": ["not allowed"],
              },
            },
            412,
          )
        : undefined,
    );
    const { exitCode, output } = await runCli(["recipient"], fetch);
    expect(exitCode).toBe(1);
    expect(output).toMatch(/status=412/);
    expect(output).toMatch(/permission to change the anticipation parameters/);
    expect(output).toMatch(/fields=automatic_anticipation_settings\.type/);
    expect(output).not.toContain(env.PAGARME_SECRET_KEY);
  });

  it("sends a Pix order without split when --no-split is given", async () => {
    const fetch = fakePagarme((url, method) =>
      method === "POST" && url.pathname.endsWith("/orders")
        ? json(fixture("order-pix-pending"))
        : undefined,
    );
    const { exitCode, output } = await runCli(
      ["order", ...couple, "--method", "pix", "--no-split"],
      fetch,
    );
    expect(exitCode).toBe(0);
    const [order] = postsTo(fetch, "/orders");
    const body = JSON.parse(String(order?.[1]?.body));
    expect(body.payments[0].payment_method).toBe("pix");
    expect(body.payments[0]).not.toHaveProperty("split");
    expect(
      fetch.mock.calls.some(([url]) => String(url).endsWith("/tokens")),
    ).toBe(false);
    expect(output).toMatch(/split removed/);
    expect(output).toMatch(
      /charge ch_\S+ status=pending transaction=waiting_payment/,
    );
    expect(output).not.toContain("00020101021226820014br.gov.bcb.pix");
  });

  it("prints one line per payable with its payment date and fees", async () => {
    const fetch = fakePagarme();
    const { exitCode, output } = await runCli(
      ["order", ...couple, "--installments", "2"],
      fetch,
    );
    expect(exitCode).toBe(0);
    const [order] = postsTo(fetch, "/orders");
    expect(
      JSON.parse(String(order?.[1]?.body)).payments[0].credit_card.installments,
    ).toBe(2);
    expect(output).toMatch(
      /payable couple installment=1 status=waiting_funds amount=1747 fee=0 anticipation_fee=0 fraud_coverage_fee=0 payment_date=2026-12-20T03:00:00\.000Z/,
    );
    expect(output).toMatch(
      /payable platform installment=2 .*payment_date=2027-01-20/,
    );
    expect(output).toMatch(/split sent .*echoed /);
  });

  it("keeps going when /payables fails", async () => {
    const fetch = fakePagarme((url) =>
      url.pathname.endsWith("/payables")
        ? json({ message: "Internal Server Error" }, 500)
        : undefined,
    );
    const { exitCode, output } = await runCli(["order", ...couple], fetch);
    expect(exitCode).toBe(0);
    expect(output).toMatch(
      /payables platform .*unknown_outcome reason=server status=500/,
    );
    expect(output).toMatch(/payables couple .*unknown_outcome/);
  });

  it("looks the charge up by code when the order outcome is unknown", async () => {
    let code = "";
    const fetch = fakePagarme((url, method, init) => {
      if (method === "POST" && url.pathname.endsWith("/orders")) {
        code = JSON.parse(String(init?.body)).code;
        return json({ message: "Internal Server Error" }, 500);
      }
      if (url.pathname.endsWith("/charges")) {
        const order = fixture("order-card-paid") as { charges: object[] };
        return json({
          data: [{ ...order.charges[0], code: url.searchParams.get("code") }],
          paging: {},
        });
      }
      return undefined;
    });
    const { exitCode, output } = await runCli(["order", ...couple], fetch);
    expect(exitCode).toBe(1);
    const lookup = fetch.mock.calls.find(([url]) =>
      new URL(String(url)).pathname.endsWith("/charges"),
    );
    expect(new URL(String(lookup?.[0])).searchParams.get("code")).toBe(code);
    expect(output).toMatch(/unknown_outcome reason=server status=500/);
    expect(output).toMatch(/charges by code: 1/);
    expect(output).toMatch(/charge ch_\S+ status=paid/);
  });

  it("re-posts the same order with the same Idempotency-Key and reports SAME", async () => {
    const fetch = fakePagarme();
    const { exitCode, output } = await runCli(
      ["order", ...couple, "--repeat-idempotency"],
      fetch,
    );
    expect(exitCode).toBe(0);
    const posts = postsTo(fetch, "/orders");
    expect(posts).toHaveLength(2);
    const headers = posts.map(([, init]) => idempotencyKeyOf(init));
    expect(headers[0]).toMatch(/^probe-/);
    expect(headers[1]).toBe(headers[0]);
    expect(posts[1]?.[1]?.body).toBe(posts[0]?.[1]?.body);
    expect(output).toMatch(/idempotency order SAME/);
  });

  it("reports ERROR when the repeated recipient POST fails", async () => {
    let posts = 0;
    const fetch = fakePagarme((url, method) =>
      method === "POST" && url.pathname.endsWith("/recipients") && ++posts === 2
        ? json({ message: "conflict" }, 409)
        : undefined,
    );
    const { exitCode, output } = await runCli(
      ["recipient", "--repeat-idempotency"],
      fetch,
    );
    expect(exitCode).toBe(0);
    const keys = postsTo(fetch, "/recipients").map(([, init]) =>
      idempotencyKeyOf(init),
    );
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(output).toMatch(/idempotency recipient ERROR rejected status=409/);
  });

  it("creates a transfer through POST /transfers with a withdrawal: key and reads it back", async () => {
    const fetch = fakePagarme();
    const { exitCode, output } = await runCli(
      ["transfer", ...couple, "--amount", "9633"],
      fetch,
    );
    expect(exitCode).toBe(0);
    const [post] = postsTo(fetch, "/transfers");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      amount: 9633,
      recipient_id: "rp_fixtureRecipient01",
    });
    expect(idempotencyKeyOf(post?.[1])).toMatch(/^withdrawal:[0-9a-f-]{36}$/);
    expect(
      fetch.mock.calls.some(
        ([url, init]) =>
          new URL(String(url)).pathname.endsWith("/transfers/65485") &&
          (init?.method ?? "GET") === "GET",
      ),
    ).toBe(true);
    expect(output).toMatch(
      /transfer 65485 read_back_id_matches=true status=pending_transfer amount=9633 fee=367 source_id=rp_\.\.\./,
    );
    expect(output).not.toContain("rp_fixtureRecipient01 source");
    expect(output).not.toContain("12345678909");
  });

  it("prints the balance and the first page of transfers", async () => {
    const fetch = fakePagarme();
    const balance = await runCli(["balance", ...couple], fetch);
    expect(balance.output).toMatch(
      /balance available=25000 waiting_funds=12000 transferred=0/,
    );
    const list = await runCli(["transfers", ...couple], fetch);
    expect(list.exitCode).toBe(0);
    expect(list.output).toMatch(/transfers count=2 order=descending/);
    expect(list.output).toMatch(/x-cursor-nextpage=present/);
    expect(list.output).not.toContain("cursor-abc");
  });
});
