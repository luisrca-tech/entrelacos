/**
 * Pagar.me sandbox probe (spec §7, steps 1–3). Runs only with PAGARME_MODE=test
 * and an `sk_test_` key, and never prints keys, tokens or card data.
 *
 *   tsx scripts/pagarmeSandboxProbe.ts [recipient|order|all] [--recipient rp_...]
 *
 * - recipient: creates an individual test recipient (automatic anticipation on,
 *   transfers off), reads it back and checks the KYC link expiry.
 * - order: R$ 100,00 gift in 6x on card 4000000000000010 with the D2 split,
 *   then prints the payables of each recipient for that charge, so the
 *   operator can tell whether the couple flat amount applies to the charge
 *   total (`charge_total`) or to each installment (`per_installment`).
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
} from "../src/pagarmeHttpClient";
import { createPagarmeOrderClient } from "../src/pagarmeOrderClient";
import { buildPagarmeOrderRequest } from "../src/pagarmeOrderPayload";
import {
  createPagarmeRecipientClient,
  type PagarmePayable,
} from "../src/pagarmeRecipientClient";

/** Approved test card of the Pagar.me v5 simulator. */
export const PAGARME_SANDBOX_APPROVED_CARD = "4000000000000010";

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
  if (!/^rp_[A-Za-z0-9]+$/.test(platformRecipientId))
    fail("PAGARME_PLATFORM_RECIPIENT_ID must be an rp_ id");
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

export function summarizePayables(payables: readonly PagarmePayable[]): {
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

export async function runPagarmeSandboxProbe(
  env: Record<string, string | undefined>,
  argv: readonly string[],
  dependencies: ProbeDependencies,
): Promise<void> {
  const settings = readProbeEnvironment(env);
  const fetch = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? (() => new Date());
  const log = dependencies.log;
  const command = argv.find((arg) => !arg.startsWith("--")) ?? "all";
  if (!["recipient", "order", "all"].includes(command))
    fail(
      "Usage: pagarmeSandboxProbe.ts [recipient|order|all] [--recipient rp_...]",
    );
  const flag = argv.indexOf("--recipient");
  let coupleRecipientId = flag >= 0 ? argv[flag + 1] : undefined;
  if (
    coupleRecipientId !== undefined &&
    !/^rp_[A-Za-z0-9]+$/.test(coupleRecipientId)
  )
    fail("--recipient must be an rp_ id");
  const http: PagarmeHttpClient = createPagarmeHttpClient({
    secretKey: settings.secretKey,
    fetch,
  });
  const recipients = createPagarmeRecipientClient({ http });
  const orders = createPagarmeOrderClient({
    secretKey: settings.secretKey,
    http,
  });

  if (command === "recipient" || (command === "all" && !coupleRecipientId)) {
    const code = `probe-${randomUUID()}`;
    const created = await recipients.createRecipient(code, {
      name: "Recebedor Sandbox Entrelacos",
      email: `${code}@example.com`,
      cpf: "12345678909",
      mobilePhone: "11987654321",
      birthDate: "1990-05-20",
      monthlyIncomeCents: 500_000,
      professionalOccupation: "Analista",
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
        type: "checking",
      },
    });
    const read = await recipients.getRecipient(created.id);
    const kyc = await recipients.createKycLink(created.id);
    const minutes = Math.round(
      (Date.parse(kyc.expiresAt) - now().getTime()) / 60_000,
    );
    coupleRecipientId = created.id;
    log(`recipient ${created.id} status=${read.status}`);
    log(`kyc_link expires in about ${minutes} min (url and QR not printed)`);
  }

  if (command === "order" || command === "all") {
    if (!coupleRecipientId)
      fail("order needs --recipient rp_... or a new recipient");
    const cardToken =
      settings.cardToken ??
      (settings.publicKey
        ? await tokenizeTestCard(settings.publicKey, fetch)
        : fail("Set PAGARME_TEST_CARD_TOKEN or PAGARME_PUBLIC_KEY"));
    const quote = quoteGiftV2(10_000, "CREDIT_CARD", 6);
    const checkoutId = `probe-${randomUUID()}`;
    const order = await orders.createOrder(
      buildPagarmeOrderRequest({
        checkoutId,
        giftId: "probe-gift",
        giftTitle: "Presente de teste (sandbox)",
        method: "CREDIT_CARD",
        installments: 6,
        totalCents: quote.totalCents,
        coupleSplitCents: quote.coupleSplitCents,
        cardToken,
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
      }),
    );
    const charge = order.charges[0];
    log(
      `order ${order.id} status=${order.status} G=${quote.totalCents} C=${quote.coupleSplitCents} mode=${GIFT_PLATFORM_TARIFFS.couplesSplitMode}`,
    );
    if (!charge) fail("The order has no charge");
    for (const [label, recipientId] of [
      ["platform", settings.platformRecipientId],
      ["couple", coupleRecipientId],
    ] as const) {
      const summary = summarizePayables(
        await recipients.listPayables(recipientId, { chargeId: charge.id }),
      );
      log(
        `payables ${label} ${recipientId}: installments=${summary.installments} amount=${summary.amountCents} fee=${summary.feeCents} anticipation_fee=${summary.anticipationFeeCents}`,
      );
    }
    log(
      "If the couple total equals C, charge_total is right; if each installment equals C, switch to per_installment.",
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPagarmeSandboxProbe(process.env, process.argv.slice(2), {
    log: (line) => console.log(line),
  }).catch((error: unknown) => {
    // Error messages from the clients never contain the secret key.
    console.error(error instanceof Error ? error.message : "Probe failed");
    process.exitCode = 1;
  });
}
