/**
 * Pagar.me sandbox probe for the go-live checklist. Runs only with
 * PAGARME_MODE=test and an `sk_test_` key, and never prints keys, tokens,
 * card data or personal data. It drives the real clients and payload
 * builders of the app, so what it observes is what production will send.
 *
 *   tsx scripts/pagarmeSandboxProbe.ts <command> [flags]
 *
 * - recipient [--repeat-idempotency]: creates an individual test recipient
 *   (automatic anticipation on, transfers off) and reads it back.
 * - order [--recipient rp_...] [--method card|pix] [--installments 1-6]
 *   [--gift-cents n] [--no-split] [--repeat-idempotency]: creates a gift
 *   order with the D2 split (default R$ 100,00 in 6x on card
 *   4000000000000010), prints order, charge, last transaction and the split
 *   sent vs. echoed, then one line per payable of each recipient. When the
 *   create outcome is unknown (e.g. a 500 on /orders), the charge is looked
 *   up with GET /charges?code=<checkoutId>. `--no-split` is Pix only: the
 *   simulator refuses Pix with split.
 * - all: recipient (unless --recipient is given), then order.
 * - balance --recipient rp_...: available, waiting and transferred amounts.
 * - transfer --recipient rp_... --amount <cents>: POST /transfers with the
 *   app's `withdrawal:<id>` Idempotency-Key, then one read back.
 * - transfers --recipient rp_...: first page of GET /transfers, its
 *   created_at order and whether a paging field or `x-cursor-nextpage`
 *   header came back.
 *
 * `--repeat-idempotency` re-POSTs the same body with the same
 * Idempotency-Key and prints SAME, DIFFERENT or ERROR. Any Pagar.me error
 * prints its status, provider code, redacted message and field paths, and
 * exits 1.
 *
 * The card token comes from PAGARME_TEST_CARD_TOKEN or, when absent, is created
 * with PAGARME_PUBLIC_KEY (`pk_test_`) exactly as the browser will do.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { GIFT_PLATFORM_TARIFFS, quoteGiftV2 } from "@entrelacos/contracts";
import {
  createPagarmeHttpClient,
  PAGARME_API_BASE_URL,
  type PagarmeHttpClient,
  PagarmeRejectedError,
  PagarmeUnknownOutcomeError,
} from "../src/pagarmeHttpClient";
import { isPagarmeRecipientId } from "../src/pagarmeIds";
import {
  createPagarmeOrderClient,
  type PagarmeChargeObservation,
  type PagarmeSplitObservation,
  readPagarmeCharge,
} from "../src/pagarmeOrderClient";
import {
  buildPagarmeOrderRequest,
  type PagarmeOrderRequest,
} from "../src/pagarmeOrderPayload";
import {
  createPagarmeRecipientClient,
  type PagarmePayable,
  type PagarmeRecipientInput,
} from "../src/pagarmeRecipientClient";

/** Approved test card of the Pagar.me v5 simulator. */
export const PAGARME_SANDBOX_APPROVED_CARD = "4000000000000010";

/**
 * Fixed cardholder address: card tokens do not carry one and the gateway
 * refuses a tokenized order without `card.billing_address`.
 */
export const PAGARME_SANDBOX_BILLING_ADDRESS = {
  zipCode: "01310100",
  street: "Avenida Paulista",
  streetNumber: "1000",
  neighborhood: "Bela Vista",
  city: "Sao Paulo",
  state: "SP",
} as const;

export interface ProbeDependencies {
  fetch?: typeof globalThis.fetch;
  log(line: string): void;
  now?: () => Date;
}

function fail(message: string): never {
  throw new Error(message);
}

export function readProbeEnvironment(env: Record<string, string | undefined>) {
  if (env.PAGARME_MODE !== "test")
    fail("The sandbox probe runs only with PAGARME_MODE=test");
  const secretKey = env.PAGARME_SECRET_KEY ?? "";
  if (!/^sk_test_[A-Za-z0-9_-]+$/.test(secretKey))
    fail("PAGARME_SECRET_KEY must be an sk_test_ key");
  const platformRecipientId = env.PAGARME_PLATFORM_RECIPIENT_ID ?? "";
  if (!isPagarmeRecipientId(platformRecipientId))
    fail(
      "PAGARME_PLATFORM_RECIPIENT_ID must be a recipient id (rp_, re_ or pp_)",
    );
  const publicKey = env.PAGARME_PUBLIC_KEY;
  if (publicKey !== undefined && !/^pk_test_[A-Za-z0-9_-]+$/.test(publicKey))
    fail("PAGARME_PUBLIC_KEY must be a pk_test_ key");
  const cardToken = env.PAGARME_TEST_CARD_TOKEN;
  if (cardToken !== undefined && !/^token_[A-Za-z0-9]+$/.test(cardToken))
    fail("PAGARME_TEST_CARD_TOKEN must be a token_ id");
  return { secretKey, platformRecipientId, publicKey, cardToken };
}

async function tokenizeTestCard(
  publicKey: string,
  fetch: typeof globalThis.fetch,
): Promise<string> {
  const response = await fetch(
    `${PAGARME_API_BASE_URL}/tokens?appId=${encodeURIComponent(publicKey)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        type: "card",
        card: {
          number: PAGARME_SANDBOX_APPROVED_CARD,
          holder_name: "ENTRELACOS SANDBOX",
          exp_month: 12,
          exp_year: 2030,
          cvv: "123",
        },
      }),
    },
  );
  const body = (await response.json().catch(() => null)) as {
    id?: unknown;
  } | null;
  if (!response.ok || typeof body?.id !== "string" || !/^token_/.test(body.id))
    fail(`Card tokenization failed (${response.status})`);
  return body.id;
}

export function summarizePayables(
  payables: readonly Pick<
    PagarmePayable,
    "amountCents" | "feeCents" | "anticipationFeeCents"
  >[],
): {
  installments: number;
  amountCents: number;
  feeCents: number;
  anticipationFeeCents: number;
} {
  return payables.reduce(
    (sum, payable) => ({
      installments: sum.installments + 1,
      amountCents: sum.amountCents + payable.amountCents,
      feeCents: sum.feeCents + payable.feeCents,
      anticipationFeeCents:
        sum.anticipationFeeCents + payable.anticipationFeeCents,
    }),
    { installments: 0, amountCents: 0, feeCents: 0, anticipationFeeCents: 0 },
  );
}

export const PROBE_USAGE = [
  "Usage: pagarmeSandboxProbe.ts <command> [flags]",
  "  recipient [--repeat-idempotency]",
  "  order [--recipient rp_...] [--method card|pix] [--installments 1-6] [--gift-cents n] [--no-split] [--repeat-idempotency]",
  "  all [--recipient rp_...] [order flags]",
  "  balance --recipient rp_...",
  "  transfer --recipient rp_... --amount <cents>",
  "  transfers --recipient rp_...",
].join("\n");

const probeCommands = [
  "recipient",
  "order",
  "all",
  "balance",
  "transfer",
  "transfers",
] as const;

export type ProbeCommand = (typeof probeCommands)[number];

export interface ProbeArguments {
  readonly command: ProbeCommand;
  readonly recipientId: string | undefined;
  readonly method: "card" | "pix";
  readonly installments: number;
  readonly giftCents: number;
  readonly split: boolean;
  readonly repeatIdempotency: boolean;
  readonly amountCents: number | undefined;
}

const valueFlags = [
  "--recipient",
  "--method",
  "--installments",
  "--gift-cents",
  "--amount",
] as const;
const booleanFlags = ["--no-split", "--repeat-idempotency"] as const;

function positiveInteger(value: string | undefined, flag: string): number {
  const parsed = /^\d{1,12}$/.test(value ?? "") ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    fail(`${flag} must be a positive integer`);
  return parsed;
}

export function parseProbeArguments(argv: readonly string[]): ProbeArguments {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if ((booleanFlags as readonly string[]).includes(arg)) {
      switches.add(arg);
      continue;
    }
    if (!(valueFlags as readonly string[]).includes(arg))
      fail(`Unknown flag ${arg.slice(0, 40)}\n${PROBE_USAGE}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      fail(`${arg} needs a value`);
    values.set(arg, value);
    index += 1;
  }
  const command = positional[0] ?? "all";
  if (
    positional.length > 1 ||
    !(probeCommands as readonly string[]).includes(command)
  )
    fail(PROBE_USAGE);
  const recipientId = values.get("--recipient");
  if (recipientId !== undefined && !isPagarmeRecipientId(recipientId))
    fail("--recipient must be a recipient id (rp_, re_ or pp_)");
  const method = values.get("--method") ?? "card";
  if (method !== "card" && method !== "pix")
    fail("--method must be card or pix");
  const rawInstallments = values.get("--installments");
  const installments =
    rawInstallments === undefined
      ? method === "pix"
        ? 1
        : 6
      : positiveInteger(rawInstallments, "--installments");
  if (installments > GIFT_PLATFORM_TARIFFS.maxInstallments)
    fail(
      `--installments must be between 1 and ${GIFT_PLATFORM_TARIFFS.maxInstallments}`,
    );
  if (method === "pix" && installments !== 1)
    fail("Pix is paid in a single installment (--installments 1)");
  const giftCents =
    values.get("--gift-cents") === undefined
      ? 10_000
      : positiveInteger(values.get("--gift-cents"), "--gift-cents");
  const split = !switches.has("--no-split");
  if (!split && method !== "pix")
    fail(
      "--no-split is allowed only with --method pix (the simulator refuses Pix with split)",
    );
  const amount = values.get("--amount");
  const amountCents =
    amount === undefined ? undefined : positiveInteger(amount, "--amount");
  if (
    (command === "balance" ||
      command === "transfer" ||
      command === "transfers") &&
    recipientId === undefined
  )
    fail(`${command} needs --recipient rp_...`);
  if (command === "transfer" && amountCents === undefined)
    fail("transfer needs --amount <cents>");
  return {
    command: command as ProbeCommand,
    recipientId,
    method,
    installments,
    giftCents,
    split,
    repeatIdempotency: switches.has("--repeat-idempotency"),
    amountCents,
  };
}

/**
 * One line for a probe failure. Pagar.me errors carry only the status, the
 * provider code, the message the http client already redacted and the field
 * paths; field messages and request data are never printed.
 */
export function describeProbeError(error: unknown): string {
  if (error instanceof PagarmeRejectedError) {
    const fields = error.providerFields.map((field) => field.field).join(",");
    return [
      `rejected status=${error.status}`,
      `code=${error.providerCode ?? "none"}`,
      `message=${error.providerMessage === null ? "none" : JSON.stringify(error.providerMessage)}`,
      `fields=${fields || "none"}`,
    ].join(" ");
  }
  if (error instanceof PagarmeUnknownOutcomeError)
    return `unknown_outcome reason=${error.reason} status=${error.status ?? "none"}`;
  return error instanceof Error ? error.message : "Probe failed";
}

/** Reads an untyped provider answer without trusting its shape. */
function rawRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("Unexpected Pagar.me response shape");
  return value as Record<string, unknown>;
}

function rawInteger(value: unknown): string {
  return Number.isSafeInteger(value) ? String(value) : "none";
}

function rawInstant(value: unknown): string {
  if (typeof value !== "string") return "none";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "invalid";
}

function rawStatus(value: unknown): string {
  return typeof value === "string" && /^[a-z_]{1,64}$/.test(value)
    ? value
    : "unknown";
}

/** Only the id prefix (`rp_`, `re_`, `pp_`...), never the id itself. */
function idPrefix(value: unknown): string {
  if (value === undefined || value === null) return "absent";
  if (typeof value !== "string") return "non-string";
  return `${/^[a-z]{1,8}_/.exec(value)?.[0] ?? "?"}...`;
}

function centsOrZero(value: unknown): number {
  return Number.isSafeInteger(value) ? (value as number) : 0;
}

/** Ascending/descending order of the created_at of a list page. */
function creationOrder(items: readonly unknown[]): string {
  const times = items.map((item) => {
    const raw =
      item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const created = raw.created_at ?? raw.date_created;
    return typeof created === "string" ? Date.parse(created) : Number.NaN;
  });
  if (times.some((time) => !Number.isFinite(time))) return "unknown";
  if (times.length < 2) return "n/a";
  const pairs = times.slice(1).map((time, index) => time - (times[index] ?? 0));
  if (pairs.every((delta) => delta >= 0)) return "ascending";
  if (pairs.every((delta) => delta <= 0)) return "descending";
  return "mixed";
}

/** The simulator refuses Pix with split, so `--no-split` drops it. */
function withoutSplit(request: PagarmeOrderRequest): PagarmeOrderRequest {
  return {
    ...request,
    body: {
      ...request.body,
      payments: request.body.payments.map(
        ({ split: _split, ...payment }) => payment,
      ),
    },
    // The payload type requires `split`; this body is probe-only.
  } as unknown as PagarmeOrderRequest;
}

const sandboxRecipientInput = (code: string): PagarmeRecipientInput => ({
  name: "Recebedor Sandbox Entrelacos",
  email: `${code}@example.com`,
  cpf: "12345678909",
  mobilePhone: "11987654321",
  birthDate: "1990-05-20",
  monthlyIncomeCents: 500_000,
  professionalOccupation: "Analista",
  // No complement on purpose: the client must send its fallback (422 otherwise).
  address: {
    street: "Avenida Paulista",
    streetNumber: "1000",
    neighborhood: "Bela Vista",
    city: "Sao Paulo",
    state: "SP",
    zipCode: "01310100",
    referencePoint: "Sandbox",
  },
  bankAccount: {
    bank: "341",
    branchNumber: "1234",
    accountNumber: "12345",
    accountCheckDigit: "6",
    holderName: "RECEBEDOR SANDBOX ENTRELACOS",
    type: "checking",
  },
});

export async function runPagarmeSandboxProbe(
  env: Record<string, string | undefined>,
  argv: readonly string[],
  dependencies: ProbeDependencies,
): Promise<void> {
  const settings = readProbeEnvironment(env);
  const args = parseProbeArguments(argv);
  const baseFetch = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? (() => new Date());
  const log = dependencies.log;
  // PagarmeHttpClient hides response headers; the probe observes them on
  // its own fetch so the client stays unchanged.
  let lastHeaders: Headers | null = null;
  const fetch = (async (input, init) => {
    const response = await baseFetch(input, init);
    lastHeaders = response.headers;
    return response;
  }) as typeof globalThis.fetch;
  const http: PagarmeHttpClient = createPagarmeHttpClient({
    secretKey: settings.secretKey,
    fetch,
  });
  const recipients = createPagarmeRecipientClient({ http });
  const orders = createPagarmeOrderClient({
    secretKey: settings.secretKey,
    http,
  });
  const { command } = args;
  let coupleRecipientId = args.recipientId;
  const sameOrDifferent = (first: string, second: string) =>
    first === second ? "SAME" : "DIFFERENT";

  if (command === "recipient" || (command === "all" && !coupleRecipientId)) {
    const code = `probe-${randomUUID()}`;
    const input = sandboxRecipientInput(code);
    const created = await recipients.createRecipient(code, input);
    const read = await recipients.getRecipient(created.id);
    coupleRecipientId = created.id;
    // A pass-through account has no Pagar.me identity check to open; the
    // status and kyc_details still tell whether the recipient is active.
    log(
      `recipient ${created.id} status=${read.status} kyc=${read.kyc.status ?? "none"}`,
    );
    if (args.repeatIdempotency) {
      try {
        const again = await recipients.createRecipient(code, input);
        log(
          `idempotency recipient ${sameOrDifferent(created.id, again.id)} first=${created.id} second=${again.id}`,
        );
      } catch (error) {
        log(`idempotency recipient ERROR ${describeProbeError(error)}`);
      }
    }
  }

  const label = (recipientId: string) =>
    recipientId === settings.platformRecipientId ? "platform" : "couple";
  const formatSplit = (split: readonly PagarmeSplitObservation[] | null) =>
    split === null
      ? "none"
      : split.length === 0
        ? "empty"
        : split
            .map((rule) => `${label(rule.recipientId)}:${rule.amountCents}`)
            .join(",");
  const logCharge = (
    charge: PagarmeChargeObservation,
    sent: readonly PagarmeSplitObservation[] | null,
  ) => {
    log(
      `charge ${charge.id} status=${charge.status} transaction=${charge.transactionStatus ?? "none"} method=${charge.paymentMethod} installments=${charge.installments ?? "none"} amount=${charge.amountCents}`,
    );
    log(`split sent ${formatSplit(sent)} echoed ${formatSplit(charge.split)}`);
  };

  async function logChargesByCode(
    code: string,
    sent: readonly PagarmeSplitObservation[] | null,
  ) {
    try {
      const raw = rawRecord(
        await http.request("GET", `/charges?${new URLSearchParams({ code })}`),
      );
      if (!Array.isArray(raw.data)) fail("Unexpected Pagar.me response shape");
      const charges = raw.data
        .map(readPagarmeCharge)
        .filter((charge) => charge.code === code);
      log(`charges by code: ${charges.length}`);
      for (const charge of charges) logCharge(charge, sent);
    } catch (error) {
      log(`charges by code: ${describeProbeError(error)}`);
    }
  }

  async function logPayables(
    who: string,
    recipientId: string,
    chargeId: string,
  ) {
    let items: unknown[];
    try {
      const raw = rawRecord(
        await http.request(
          "GET",
          `/payables?${new URLSearchParams({ recipient_id: recipientId, charge_id: chargeId })}`,
        ),
      );
      if (!Array.isArray(raw.data)) fail("Unexpected Pagar.me response shape");
      items = raw.data;
    } catch (error) {
      log(`payables ${who} ${recipientId}: ${describeProbeError(error)}`);
      return;
    }
    const amounts = items.map((item) => {
      const payable =
        item && typeof item === "object"
          ? (item as Record<string, unknown>)
          : {};
      const original =
        payable.original_payment_date == null
          ? ""
          : ` original_payment_date=${rawInstant(payable.original_payment_date)}`;
      log(
        `payable ${who} installment=${rawInteger(payable.installment)} status=${rawStatus(payable.status)} amount=${rawInteger(payable.amount)} fee=${rawInteger(payable.fee)} anticipation_fee=${rawInteger(payable.anticipation_fee)} fraud_coverage_fee=${rawInteger(payable.fraud_coverage_fee)} payment_date=${rawInstant(payable.payment_date)}${original}`,
      );
      return {
        amountCents: centsOrZero(payable.amount),
        feeCents: centsOrZero(payable.fee),
        anticipationFeeCents: centsOrZero(payable.anticipation_fee),
      };
    });
    const summary = summarizePayables(amounts);
    log(
      `payables ${who} ${recipientId}: installments=${summary.installments} amount=${summary.amountCents} fee=${summary.feeCents} anticipation_fee=${summary.anticipationFeeCents}`,
    );
  }

  if (command === "order" || command === "all") {
    if (!coupleRecipientId)
      fail("order needs --recipient rp_... or a new recipient");
    const method = args.method === "pix" ? "PIX" : "CREDIT_CARD";
    const cardToken =
      method === "PIX"
        ? undefined
        : (settings.cardToken ??
          (settings.publicKey
            ? await tokenizeTestCard(settings.publicKey, fetch)
            : fail("Set PAGARME_TEST_CARD_TOKEN or PAGARME_PUBLIC_KEY")));
    const quote = quoteGiftV2(args.giftCents, method, args.installments);
    const checkoutId = `probe-${randomUUID()}`;
    const built = buildPagarmeOrderRequest({
      checkoutId,
      giftId: "probe-gift",
      giftTitle: "Presente de teste (sandbox)",
      method,
      installments: args.installments,
      totalCents: quote.totalCents,
      coupleSplitCents: quote.coupleSplitCents,
      ...(method === "PIX"
        ? {}
        : { cardToken, billingAddress: PAGARME_SANDBOX_BILLING_ADDRESS }),
      quoteExpiresAt: new Date(now().getTime() + 300_000),
      now: now(),
      buyer: {
        name: "Convidado Sandbox",
        email: "convidado.sandbox@example.com",
        cpf: "12345678909",
        phone: "11987654321",
      },
      platformRecipientId: settings.platformRecipientId,
      coupleRecipientId,
      splitMode: GIFT_PLATFORM_TARIFFS.couplesSplitMode,
    });
    const request = args.split ? built : withoutSplit(built);
    if (!args.split) log("split removed from the order body (--no-split)");
    const sent: PagarmeSplitObservation[] | null = args.split
      ? (built.body.payments[0]?.split ?? []).map((rule) => ({
          recipientId: rule.recipient_id,
          amountCents: rule.amount,
        }))
      : null;
    log(
      `order request method=${args.method} installments=${args.installments} gift=${args.giftCents} G=${quote.totalCents} C=${quote.coupleSplitCents} mode=${GIFT_PLATFORM_TARIFFS.couplesSplitMode}`,
    );
    let order: Awaited<ReturnType<typeof orders.createOrder>>;
    try {
      order = await orders.createOrder(request);
    } catch (error) {
      if (!(error instanceof PagarmeUnknownOutcomeError)) throw error;
      log(
        `order create: ${describeProbeError(error)}; looking the charge up by code`,
      );
      await logChargesByCode(checkoutId, sent);
      throw error;
    }
    log(
      `order ${order.id} status=${order.status} charges=${order.charges.length}`,
    );
    for (const charge of order.charges) logCharge(charge, sent);
    if (args.repeatIdempotency) {
      try {
        const again = await orders.createOrder(request);
        log(
          `idempotency order ${sameOrDifferent(order.id, again.id)} first=${order.id} second=${again.id}`,
        );
      } catch (error) {
        log(`idempotency order ERROR ${describeProbeError(error)}`);
      }
    }
    const charge = order.charges[0];
    if (!charge) fail("The order has no charge");
    for (const [who, recipientId] of [
      ["platform", settings.platformRecipientId],
      ["couple", coupleRecipientId],
    ] as const)
      await logPayables(who, recipientId, charge.id);
    log(
      "If the couple total equals C, charge_total is right; if each installment equals C, switch to per_installment.",
    );
  }

  if (command === "balance" && args.recipientId) {
    const balance = await recipients.getBalance(args.recipientId);
    const raw = rawRecord(
      await http.request("GET", `/recipients/${args.recipientId}/balance`),
    );
    log(
      `balance available=${balance.availableCents} waiting_funds=${balance.waitingFundsCents} transferred=${rawInteger(raw.transferred_amount)}`,
    );
  }

  if (command === "transfer" && args.recipientId && args.amountCents) {
    // Same client method and key shape as the app's withdrawals.
    const created = await recipients.createWithdrawal(
      args.recipientId,
      args.amountCents,
      `withdrawal:${randomUUID()}`,
    );
    log(
      `transfer created ${created.id} status=${created.status} amount=${created.amountCents}`,
    );
    const raw = rawRecord(
      await http.request("GET", `/transfers/${encodeURIComponent(created.id)}`),
    );
    log(
      `transfer ${created.id} read_back_id_matches=${String(raw.id) === created.id} status=${rawStatus(raw.status)} amount=${rawInteger(raw.amount)} fee=${rawInteger(raw.fee)} source_id=${idPrefix(raw.source_id)} recipient_id=${idPrefix(raw.recipient_id)}`,
    );
  }

  if (command === "transfers" && args.recipientId) {
    lastHeaders = null;
    const raw = await http.request<unknown>(
      "GET",
      `/transfers?${new URLSearchParams({ recipient_id: args.recipientId, count: "1000" })}`,
    );
    const headers = lastHeaders as Headers | null;
    const list = Array.isArray(raw) ? raw : rawRecord(raw).data;
    if (!Array.isArray(list)) fail("Unexpected Pagar.me response shape");
    const paging = Array.isArray(raw)
      ? "absent(bare array)"
      : rawRecord(raw).paging === undefined
        ? "absent"
        : `present(${Object.keys(rawRecord(rawRecord(raw).paging)).join(",") || "empty"})`;
    log(
      `transfers count=${list.length} order=${creationOrder(list)} paging=${paging} x-cursor-nextpage=${headers === null ? "unobserved" : headers.has("x-cursor-nextpage") ? "present" : "absent"}`,
    );
  }
}

/** Runs the probe and prints any failure; resolves to the exit code. */
export async function runPagarmeSandboxProbeCli(
  env: Record<string, string | undefined>,
  argv: readonly string[],
  dependencies: ProbeDependencies,
): Promise<number> {
  try {
    await runPagarmeSandboxProbe(env, argv, dependencies);
    return 0;
  } catch (error) {
    dependencies.log(`probe failed: ${describeProbeError(error)}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPagarmeSandboxProbeCli(process.env, process.argv.slice(2), {
    log: (line) => console.log(line),
  }).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
