import { createHash } from "node:crypto";
import { giftCentsSchema, giftQuoteSchema } from "@entrelacos/contracts";
import type { DatabaseConnection } from "@entrelacos/database";
import {
  financialEventInbox,
  financialLedgerEntry,
  giftOrder,
  giftPaymentRecord,
  giftQuoteRecord,
  receivingAccount,
  site,
} from "@entrelacos/database/schema";
import { sql } from "drizzle-orm";
import {
  decodeAsaasTransfers,
  readAsaasTransferEffectiveDate,
} from "./asaasHttpClient";
import type { AsaasStoredAccountReader } from "./asaasStoredAccountReader";
import { parseBrlCents, serializeBrlCents } from "./giftMoney";
import {
  giftPaymentTerms,
  giftReceivedEffectKey,
} from "./giftPaymentReconciliation";
import type { GiftPaymentWorker } from "./giftPaymentWorker";
import type { LiveSitePolicy } from "./liveSitePolicy";

interface AsaasAdjustmentOptions {
  environment: "sandbox" | "live";
  platformApiKey: string;
  platformWalletId: string;
  fetch: typeof globalThis.fetch;
  now?: () => Date;
}

interface AdjustmentCommand {
  externalReference: string;
  walletId: string;
  amountCents: number;
}

function unavailable(): never {
  throw new Error("Gift fee adjustment unavailable");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return unavailable();
  return value as Record<string, unknown>;
}

function reference(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    return unavailable();
  return value;
}

function cents(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string")
    return unavailable();
  return parseBrlCents(String(value));
}

function transferProof(
  raw: Record<string, unknown>,
  command: AdjustmentCommand,
  now: Date,
  knownReference?: string,
) {
  const id = reference(raw.id);
  const effectiveDate = readAsaasTransferEffectiveDate(raw.effectiveDate);
  const currentLocalTime = now.toLocaleString("sv-SE", {
    timeZone: "America/Sao_Paulo",
  });
  if (
    raw.object !== "transfer" ||
    (raw.type !== "ASAAS_ACCOUNT" && raw.type !== "INTERNAL") ||
    (raw.operationType != null && raw.operationType !== "INTERNAL") ||
    raw.externalReference !== command.externalReference ||
    (knownReference !== undefined && knownReference !== id) ||
    (raw.walletId !== command.walletId &&
      (knownReference === undefined || raw.walletId != null)) ||
    cents(raw.value) !== command.amountCents ||
    !["PENDING", "BANK_PROCESSING", "DONE", "CANCELLED", "FAILED"].includes(
      String(raw.status),
    ) ||
    (raw.status === "DONE" &&
      (cents(raw.netValue) !== command.amountCents ||
        raw.authorized === false ||
        (raw.transferFee != null && cents(raw.transferFee) !== 0) ||
        effectiveDate === null ||
        effectiveDate > currentLocalTime))
  )
    return unavailable();
  return {
    reference: id,
    funded: raw.status === "DONE",
    ...(["FAILED", "CANCELLED"].includes(String(raw.status))
      ? { terminalFailure: true }
      : {}),
  };
}

export function createAsaasGiftAdjustmentPort(options: AsaasAdjustmentOptions) {
  const {
    environment,
    platformApiKey,
    platformWalletId,
    fetch,
    now = () => new Date(),
  } = options;
  const sandbox = environment === "sandbox";
  const base = sandbox
    ? "https://api-sandbox.asaas.com/v3"
    : "https://api.asaas.com/v3";
  async function request(
    path: string,
    body?: string,
    decode: (text: string) => unknown = JSON.parse,
  ) {
    if (!platformApiKey.startsWith(sandbox ? "$aact_hmlg_" : "$aact_prod_"))
      return unavailable();
    const signal = AbortSignal.timeout(15_000);
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Entrelacos/1.0",
        access_token: platformApiKey,
      },
      signal,
      body,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      return unavailable();
    }
    const reader = response.body.getReader();
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let size = 0;
      let payload = "";
      while (true) {
        const item = await reader.read();
        signal.throwIfAborted();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > 262_144) return unavailable();
        payload += decoder.decode(item.value, { stream: true });
      }
      return record(decode(payload + decoder.decode()));
    } finally {
      signal.removeEventListener("abort", cancel);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async function verifyPlatformWallet() {
    const wallets = await request("/wallets/");
    if (
      !Array.isArray(wallets.data) ||
      !wallets.data.some((wallet) => record(wallet).id === platformWalletId)
    )
      return unavailable();
  }

  return {
    async canFund(amountCents: number) {
      await verifyPlatformWallet();
      const balance = await request("/finance/balance");
      if (cents(balance.balance) < amountCents) return false;
      // Preserve recovery authority before committing the only dispatch attempt.
      const transfers = await request(
        "/transfers?type=ASAAS_ACCOUNT&limit=1&offset=0",
        undefined,
        decodeAsaasTransfers,
      );
      if (
        typeof transfers.hasMore !== "boolean" ||
        !Array.isArray(transfers.data) ||
        transfers.data.length > 1
      )
        return unavailable();
      return true;
    },
    async dispatch(command: AdjustmentCommand) {
      if (command.walletId === platformWalletId) return unavailable();
      const raw = await request(
        "/transfers/",
        JSON.stringify({
          walletId: command.walletId,
          externalReference: command.externalReference,
          value: Number(serializeBrlCents(command.amountCents)),
        }),
        decodeAsaasTransfers,
      );
      return transferProof(raw, command, now());
    },
    async observe(command: AdjustmentCommand, knownReference: string) {
      const raw = await request(
        `/transfers/${reference(knownReference)}`,
        undefined,
        decodeAsaasTransfers,
      );
      return transferProof(raw, command, now(), knownReference);
    },
    async recover(
      command: AdjustmentCommand,
      dispatchedAt: Date,
      confirmRecipientCredit?: (
        transferReference: string,
        effectiveDate: string,
      ) => Promise<boolean>,
    ) {
      const nextDate = new Date(dispatchedAt.getTime() + 86_400_000)
        .toISOString()
        .slice(0, 10);
      const previousDate = new Date(dispatchedAt.getTime() - 86_400_000)
        .toISOString()
        .slice(0, 10);
      let match: ReturnType<typeof transferProof> | null = null;
      for (let offset = 0; offset < 1000; offset += 100) {
        const raw = await request(
          `/transfers?type=ASAAS_ACCOUNT&dateCreated%5Bge%5D=${previousDate}&dateCreated%5Ble%5D=${nextDate}&limit=100&offset=${offset}`,
          undefined,
          decodeAsaasTransfers,
        );
        if (
          typeof raw.hasMore !== "boolean" ||
          !Array.isArray(raw.data) ||
          raw.data.length > 100
        )
          return unavailable();
        for (const item of raw.data) {
          const transfer = record(item);
          if (transfer.externalReference !== command.externalReference)
            continue;
          if (match) return unavailable();
          if (transfer.walletId == null) {
            const candidate = transferProof(
              transfer,
              command,
              now(),
              reference(transfer.id),
            );
            const effectiveDate = readAsaasTransferEffectiveDate(
              transfer.effectiveDate,
            );
            if (
              !candidate.funded ||
              effectiveDate === null ||
              !(await confirmRecipientCredit?.(
                candidate.reference,
                effectiveDate,
              ))
            )
              return unavailable();
            match = candidate;
          } else {
            match = transferProof(transfer, command, now());
          }
        }
        if (!raw.hasMore) return match;
      }
      return unavailable();
    },
  };
}

export function createGiftPaymentAdjustmentWorker(
  db: Pick<DatabaseConnection["db"], "execute">,
  options: AsaasAdjustmentOptions &
    LiveSitePolicy & {
      reader: Pick<
        AsaasStoredAccountReader,
        "hasInternalTransferCredit" | "hasUnrestrictedGiftPayment"
      >;
    },
): GiftPaymentWorker {
  const provider = createAsaasGiftAdjustmentPort(options);
  const { environment, liveDemoSiteId, platformWalletId, reader } = options;
  const restricted = sql`EXISTS (
    SELECT 1 FROM ${financialEventInbox} e
    WHERE e.site_id=p.site_id AND e.account_id=p.account_id AND e.environment=p.environment
      AND e.payload->>'paymentId'=p.provider_payment_reference
      AND (e.event_type LIKE 'PAYMENT_REFUND%' OR e.event_type LIKE 'PAYMENT_CHARGEBACK%'
        OR e.event_type IN ('PAYMENT_DELETED','PAYMENT_AWAITING_CHARGEBACK_REVERSAL','PAYMENT_SPLIT_CANCELLED'))
  )`;
  // The receipt transaction establishes the obligation. A claim defers other
  // workers and the separate dispatch fence is committed before the single POST.
  return {
    async processNextReceivedPayment() {
      const claimed = await db.execute(sql`WITH candidate AS (
        SELECT p.id, p.site_id, p.account_id, p.environment, a.recipient_reference AS wallet, a.account_reference AS account_reference,
          q.snapshot->'quote' AS quote, l.amount_cents AS credit_cents, l.effect_key
        FROM ${giftPaymentRecord} p
        JOIN ${receivingAccount} a ON a.id=p.account_id AND a.site_id=p.site_id AND a.environment=p.environment
        JOIN ${site} st ON st.id=p.site_id
        JOIN ${giftOrder} o ON o.id=p.order_id AND o.site_id=p.site_id AND o.account_id=p.account_id AND o.environment=p.environment
        JOIN ${giftQuoteRecord} q ON q.id=o.quote_id AND q.site_id=p.site_id AND q.account_id=p.account_id AND q.environment=p.environment
        JOIN ${financialLedgerEntry} l ON l.payment_id=p.id AND l.site_id=p.site_id AND l.account_id=p.account_id AND l.environment=p.environment
          AND l.kind='GIFT_RECEIVED' AND l.direction='CREDIT' AND l.currency='BRL' AND l.amount_cents=p.recipient_net_cents
        WHERE p.environment=${environment} AND (${environment} <> 'live' OR NOT st.is_demo OR st.id=${liveDemoSiteId ?? null})
          AND p.platform_adjustment_cents > 0 AND p.platform_adjustment_funded_at IS NULL
          AND (p.platform_adjustment_next_attempt_at IS NULL OR p.platform_adjustment_next_attempt_at <= clock_timestamp())
          AND p.verification_status='VERIFIED' AND p.provider_status='RECEIVED' AND p.currency='BRL'
          AND a.provider='ASAAS' AND a.recipient_reference=q.snapshot->'receiving'->>'recipientReference'
          AND a.account_reference=q.snapshot->'receiving'->>'accountReference'
          AND q.snapshot->'quote'->>'settlementVersion'='PLATFORM_FEE_GUARANTEE_V1'
          AND (p.platform_adjustment_dispatch_at IS NOT NULL OR NOT ${restricted})
        ORDER BY p.platform_adjustment_next_attempt_at NULLS FIRST, p.created_at, p.id
        LIMIT 1 FOR UPDATE OF p SKIP LOCKED
      )
      UPDATE ${giftPaymentRecord} p SET platform_adjustment_next_attempt_at=clock_timestamp() + interval '5 minutes'
      FROM candidate c WHERE p.id=c.id AND p.site_id=c.site_id AND p.account_id=c.account_id AND p.environment=c.environment
      RETURNING p.id, p.site_id AS "siteId", p.account_id AS "accountId", p.installment_number AS "installmentNumber",
        p.provider_payment_reference AS "paymentReference", p.platform_adjustment_cents AS "amountCents",
        p.platform_adjustment_dispatch_at AS "dispatchedAt", p.platform_adjustment_transfer_reference AS "transferReference",
        c.wallet, c.account_reference AS "accountReference", c.quote, c.credit_cents AS "creditCents", c.effect_key AS "effectKey"`);
      if (claimed.rows.length === 0) return { kind: "IDLE" };
      if (claimed.rows.length !== 1) return unavailable();
      const row = claimed.rows[0];
      const quote = giftQuoteSchema.parse(row.quote);
      const terms = giftPaymentTerms(quote, row.installmentNumber);
      const paymentId = giftQuoteSchema.shape.id.parse(row.id);
      const walletId = reference(row.wallet);
      const amountCents = giftCentsSchema.parse(row.amountCents);
      const creditCents = giftCentsSchema.parse(row.creditCents);
      if (
        !terms ||
        quote.siteId !== row.siteId ||
        quote.mode !== environment ||
        quote.settlementVersion !== "PLATFORM_FEE_GUARANTEE_V1" ||
        walletId === platformWalletId ||
        amountCents <= 0 ||
        amountCents !== terms.nominalCents - creditCents ||
        row.effectKey !== giftReceivedEffectKey(reference(row.paymentReference))
      )
        return unavailable();
      const binding = {
        provider: "ASAAS" as const,
        siteId: quote.siteId,
        accountBindingId: giftQuoteSchema.shape.id.parse(row.accountId),
        accountReference: reference(row.accountReference),
        environment,
      };
      const command = {
        externalReference: `gift_fee_${createHash("sha256")
          .update(
            JSON.stringify([
              environment,
              row.siteId,
              row.accountId,
              paymentId,
              walletId,
              amountCents,
            ]),
          )
          .digest("hex")}`,
        walletId,
        amountCents,
      };
      const scope = sql`p.id=${paymentId} AND p.site_id=${row.siteId} AND p.account_id=${row.accountId}
        AND p.environment=${environment} AND p.platform_adjustment_cents=${amountCents} AND p.platform_adjustment_funded_at IS NULL`;
      let result: Awaited<ReturnType<typeof provider.dispatch>> | null;
      if (row.transferReference != null) {
        result = await provider.observe(
          command,
          reference(row.transferReference),
        );
      } else if (row.dispatchedAt != null) {
        result = await provider.recover(
          command,
          new Date(String(row.dispatchedAt)),
          (transferReference, effectiveDate) =>
            reader.hasInternalTransferCredit(
              binding,
              transferReference,
              amountCents,
              effectiveDate,
            ),
        );
      } else {
        if (
          !(await provider.canFund(amountCents)) ||
          !(await reader.hasUnrestrictedGiftPayment(
            binding,
            reference(row.paymentReference),
          ))
        )
          return { kind: "RETRY" };
        const dispatch =
          await db.execute(sql`UPDATE ${giftPaymentRecord} p SET platform_adjustment_dispatch_at=clock_timestamp()
          WHERE ${scope} AND p.platform_adjustment_dispatch_at IS NULL AND p.provider_status='RECEIVED'
          AND NOT ${restricted}
          RETURNING p.id`);
        if (dispatch.rows.length !== 1 || dispatch.rows[0]?.id !== paymentId)
          return { kind: "RETRY" };
        result = await provider.dispatch(command);
      }
      if (!result) return { kind: "RETRY" };
      const persisted = await db.execute(sql`UPDATE ${giftPaymentRecord} p SET
        platform_adjustment_transfer_reference=${result.reference},
        platform_adjustment_funded_at=CASE WHEN ${result.funded} THEN clock_timestamp() ELSE NULL END,
        platform_adjustment_next_attempt_at=CASE WHEN ${result.terminalFailure === true} THEN 'infinity'::timestamptz ELSE p.platform_adjustment_next_attempt_at END
        WHERE ${scope} AND p.platform_adjustment_dispatch_at IS NOT NULL
          AND (p.platform_adjustment_transfer_reference IS NULL OR p.platform_adjustment_transfer_reference=${result.reference})
        RETURNING p.id`);
      if (persisted.rows.length !== 1 || persisted.rows[0]?.id !== paymentId)
        return { kind: "RETRY" };
      return {
        kind: result.funded
          ? "POSTED"
          : result.terminalFailure
            ? "DEAD_LETTER"
            : "OBSERVED",
      };
    },
  };
}
