/**
 * Slice 0 probe: platform (main) account split behaviour in the Asaas Sandbox.
 *
 * Sandbox only. Refuses any key that is not a `$aact_hmlg_` key and never
 * prints the key. Creates test customers and card charges in the Sandbox
 * platform account, splits a fixed value to a couple sub-account wallet and
 * records what Asaas reports about fees, per-installment split updates,
 * automatic anticipation and split settlement.
 *
 * Usage (from apps/api):
 *   tsx --env-file-if-exists=.env scripts/probePlatformSplit.ts [discover|run|observe <file>]
 * Env:
 *   ASAAS_API_KEY                 Sandbox key of the platform account
 *   PROBE_RECIPIENT_WALLET_ID     optional couple wallet; defaults to first sub-account
 *   PROBE_OUTPUT_DIR              where JSON evidence is written (default ./probe-output)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SANDBOX_BASE_URL = "https://api-sandbox.asaas.com/v3";

type Json = Record<string, unknown>;
type Call = { method: string; path: string; status: number; body: unknown };

export function assertSandboxKey(key: string | undefined): string {
  if (!key?.startsWith("$aact_hmlg_"))
    throw new Error("Probe requires a Sandbox platform key ($aact_hmlg_)");
  return key;
}

function createClient(key: string, log: Call[]) {
  return async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Json }> {
    const response = await fetch(`${SANDBOX_BASE_URL}${path}`, {
      method,
      headers: {
        access_token: key,
        "Content-Type": "application/json",
        "User-Agent": "EntreLacos-API",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: Json = {};
    try {
      parsed = text ? (JSON.parse(text) as Json) : {};
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }
    log.push({ method, path, status: response.status, body: redact(parsed) });
    return { status: response.status, body: parsed };
  };
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Json = {};
    for (const [k, v] of Object.entries(value as Json)) {
      if (/apiKey|accessToken|creditCardToken|authToken/i.test(k))
        out[k] = "<redacted>";
      else out[k] = redact(v);
    }
    return out;
  }
  return value;
}

function today(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

const holder = {
  name: "Probe Convidado",
  email: "probe.convidado@example.com",
  cpfCnpj: "24971563792",
  postalCode: "89223005",
  addressNumber: "277",
  phone: "4738010919",
};
const card = {
  holderName: "PROBE CONVIDADO",
  number: "5162306219378829",
  expiryMonth: "12",
  expiryYear: String(new Date().getFullYear() + 2),
  ccv: "318",
};

function cents(v: unknown): number {
  return Math.round(Number(v) * 100);
}

async function main(mode: string, arg?: string) {
  const key = assertSandboxKey(process.env.ASAAS_API_KEY);
  const outDir = process.env.PROBE_OUTPUT_DIR ?? "probe-output";
  mkdirSync(outDir, { recursive: true });
  const log: Call[] = [];
  const call = createClient(key, log);
  const save = (name: string, data: unknown) =>
    writeFileSync(join(outDir, name), JSON.stringify(data, null, 2));

  if (mode === "discover") {
    await call("GET", "/myAccount");
    await call("GET", "/myAccount/fees/");
    await call("GET", "/anticipations/configurations");
    await call("GET", "/anticipations/limits");
    await call("GET", "/accounts?limit=10");
    save(`discover-${Date.now()}.json`, log);
    for (const c of log) console.log(c.method, c.path, c.status);
    return;
  }

  if (mode === "enable-automatic-anticipation") {
    // Mirrors the production account setup the spec assumes ([LUIS]).
    await call("POST", "/anticipations/configurations", {
      creditCardAutomaticEnabled: true,
    });
    await call("PUT", "/anticipations/configurations", {
      creditCardAutomaticEnabled: true,
    });
    await call("GET", "/anticipations/configurations");
    save(`anticipation-config-${Date.now()}.json`, log);
    for (const c of log)
      console.log(c.method, c.path, c.status, JSON.stringify(c.body));
    return;
  }

  if (mode === "observe") {
    if (!arg) throw new Error("observe needs the run file");
    const run = JSON.parse(readFileSync(arg, "utf8")) as {
      paymentIds: string[];
    };
    const summary = [];
    for (const id of run.paymentIds) {
      const p = (await call("GET", `/payments/${id}`)).body;
      const a = (await call("GET", `/anticipations?payment=${id}`)).body;
      summary.push({
        id,
        installmentNumber: p.installmentNumber,
        status: p.status,
        value: p.value,
        netValue: p.netValue,
        anticipated: p.anticipated,
        anticipable: p.anticipable,
        creditDate: p.creditDate,
        estimatedCreditDate: p.estimatedCreditDate,
        confirmedDate: p.confirmedDate,
        split: p.split,
        anticipations: a.data,
      });
    }
    save(`observe-${Date.now()}.json`, { summary, log });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (mode !== "run") throw new Error(`Unknown mode ${mode}`);

  let wallet = process.env.PROBE_RECIPIENT_WALLET_ID;
  if (!wallet) {
    const accounts = (await call("GET", "/accounts?limit=10")).body
      .data as Json[];
    wallet = accounts?.find((a) => typeof a.walletId === "string")?.walletId as
      | string
      | undefined;
  }
  if (!wallet) throw new Error("No sub-account wallet available");

  const customer = (
    await call("POST", "/customers", {
      name: holder.name,
      cpfCnpj: holder.cpfCnpj,
      email: holder.email,
      notificationDisabled: true,
    })
  ).body;
  const customerId = customer.id as string;
  const result: Json = { wallet: `${wallet.slice(0, 8)}…`, customerId };
  const paymentIds: string[] = [];

  const count = Number(process.env.PROBE_INSTALLMENTS ?? 12);
  const nominal = Number(process.env.PROBE_NOMINAL_CENTS ?? 10000);
  const total = Number(process.env.PROBE_TOTAL_CENTS ?? 11909);
  const skipOneShot = process.env.PROBE_SKIP_ONESHOT === "1";

  // A) 1x R$106,88 paid immediately with card, fixed split R$100 to the couple.
  const oneShot = skipOneShot
    ? { status: 0, body: {} as Json }
    : await call("POST", "/payments", {
        customer: customerId,
        billingType: "CREDIT_CARD",
        value: 106.88,
        dueDate: today(1),
        description: "probe 1x",
        externalReference: "probe-1x",
        creditCard: card,
        creditCardHolderInfo: holder,
        remoteIp: "127.0.0.1",
        split: [{ walletId: wallet, fixedValue: 100 }],
      });
  result.oneShot = {
    status: oneShot.status,
    id: oneShot.body.id,
    paymentStatus: oneShot.body.status,
    value: oneShot.body.value,
    netValue: oneShot.body.netValue,
    split: oneShot.body.split,
  };
  if (typeof oneShot.body.id === "string") paymentIds.push(oneShot.body.id);

  // B) 12x R$119,09 invoice (PENDING) with totalFixedValue R$100, then PUT a
  //    decreasing split per child, re-read, then pay with card.
  const inst = await call("POST", "/payments", {
    customer: customerId,
    billingType: "CREDIT_CARD",
    installmentCount: count,
    totalValue: total / 100,
    dueDate: today(1),
    description: `probe ${count}x`,
    externalReference: `probe-${count}x`,
    split: [{ walletId: wallet, totalFixedValue: nominal / 100 }],
  });
  const installmentId = inst.body.installment as string | undefined;
  result.installmentCreate = {
    status: inst.status,
    id: inst.body.id,
    installment: installmentId,
    value: inst.body.value,
    netValue: inst.body.netValue,
    split: inst.body.split,
    errors: inst.body.errors,
  };
  if (installmentId) {
    const children = (
      (await call("GET", `/installments/${installmentId}/payments?limit=100`))
        .body.data as Json[]
    ).sort((a, b) => Number(a.installmentNumber) - Number(b.installmentNumber));
    result.childrenBefore = children.map((c) => ({
      id: c.id,
      n: c.installmentNumber,
      status: c.status,
      value: c.value,
      netValue: c.netValue,
      split: c.split,
      externalReference: c.externalReference,
      dueDate: c.dueDate,
    }));
    // Decreasing split summing to the nominal (spec example 12x R$100 starts 878, ends 753).
    const weights = children.map((_, i) => 1 - i * 0.013);
    const sumW = weights.reduce((a, b) => a + b, 0);
    const split = weights.map((w) => Math.floor((nominal * w) / sumW));
    split[0] = (split[0] ?? 0) + nominal - split.reduce((a, b) => a + b, 0);
    result.plannedSplitCents = split;
    const puts = [];
    for (const [i, child] of children.entries()) {
      const put = await call("PUT", `/payments/${child.id}`, {
        billingType: "CREDIT_CARD",
        value: child.value,
        dueDate: child.dueDate,
        split: [{ walletId: wallet, fixedValue: (split[i] ?? 0) / 100 }],
      });
      puts.push({
        n: child.installmentNumber,
        status: put.status,
        value: put.body.value,
        split: put.body.split,
        errors: put.body.errors,
      });
    }
    result.puts = puts;
    const after = (
      (await call("GET", `/installments/${installmentId}/payments?limit=100`))
        .body.data as Json[]
    ).sort((a, b) => Number(a.installmentNumber) - Number(b.installmentNumber));
    result.childrenAfterPut = after.map((c) => ({
      n: c.installmentNumber,
      value: c.value,
      splitFixed: (c.split as Json[] | undefined)?.map((s) => s.fixedValue),
      matches:
        cents((c.split as Json[] | undefined)?.[0]?.fixedValue) ===
        split[Number(c.installmentNumber) - 1],
    }));
    const first = after[0];
    if (first) {
      const pay = await call(
        "POST",
        `/payments/${first.id}/payWithCreditCard`,
        {
          creditCard: card,
          creditCardHolderInfo: holder,
        },
      );
      result.pay = {
        status: pay.status,
        paymentStatus: pay.body.status,
        errors: pay.body.errors,
      };
    }
    const paid = (
      (await call("GET", `/installments/${installmentId}/payments?limit=100`))
        .body.data as Json[]
    ).sort((a, b) => Number(a.installmentNumber) - Number(b.installmentNumber));
    result.childrenAfterPay = paid.map((c) => ({
      id: c.id,
      n: c.installmentNumber,
      status: c.status,
      value: c.value,
      netValue: c.netValue,
      feeCents: cents(c.value) - cents(c.netValue),
      anticipated: c.anticipated,
      estimatedCreditDate: c.estimatedCreditDate,
      creditDate: c.creditDate,
      split: c.split,
    }));
    for (const c of paid) paymentIds.push(c.id as string);
    result.installmentObject = (
      await call("GET", `/installments/${installmentId}`)
    ).body;
  }
  result.paymentIds = paymentIds;
  const file = join(outDir, `run-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify({ result, log }, null, 2));
  writeFileSync(
    join(outDir, "last-run.json"),
    JSON.stringify({ paymentIds }, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
  console.log(`evidence: ${file}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2] ?? "discover", process.argv[3]).catch((error) => {
    console.error(error instanceof Error ? error.message : "probe failed");
    process.exitCode = 1;
  });
}
