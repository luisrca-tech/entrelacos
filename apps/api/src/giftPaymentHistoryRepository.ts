import { createHash, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  type GiftPurchaseHistoryPayment,
  type GiftPurchaseHistoryReceipt,
  giftCentsSchema,
  giftPurchaseHistoryDetailResponseSchema,
  giftPurchaseHistoryLimits,
  giftPurchaseHistoryPageResponseSchema,
  giftPurchaseHistoryPaymentSchema,
  giftPurchaseHistoryPurchaseSchema,
  giftPurchaseHistoryReceiptSchema,
} from "@entrelacos/contracts";
import {
  financialEventInbox,
  financialLedgerEntry,
  financialOperation,
  giftCheckoutAttempt,
  giftOrder,
  giftPaymentRecord,
  giftQuoteRecord,
  receivingAccount,
  receivingDestination,
  session,
  user,
} from "@entrelacos/database/schema";
import { type SQL, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { hashAsaasEventIdentity } from "./asaasWebhook";
import type { AuthDatabase } from "./auth";
import { ADMIN_ABSOLUTE_TIMEOUT_MS, ADMIN_IDLE_TIMEOUT_MS } from "./authHttp";
import {
  databaseTimestampEpochMicroseconds,
  readDatabaseTimestamp,
} from "./databaseTimestamp";
import { assertFinancialReadAccess } from "./financialAuthorization";
import { readGiftQuoteSnapshot } from "./giftCheckouts";
import {
  type GiftPaymentHistoryReadScope,
  type GiftPaymentHistoryRepository,
  historyUnavailable,
  readGiftPaymentHistoryScope,
} from "./giftPaymentHistory";
import { giftReceivedEffectKey } from "./giftPaymentReconciliation";
import type { GiftQuoteSnapshot } from "./giftQuotes";
import { readReceivingProvisioningRecord } from "./receivingNomination";
import { resolveSiteAccess } from "./siteAccess";

export interface GiftPaymentHistoryRepositoryOptions {
  mode: "sandbox" | "live";
  applicationEnvironment: "test" | "development" | "production";
  policy: "SITE_HISTORY";
  now(): Date;
}
type Transaction = Parameters<Parameters<AuthDatabase["transaction"]>[0]>[0];
type Row = Record<string, unknown>;
const scanLimit = 512;
function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return historyUnavailable();
  return value as Row;
}
function id(value: unknown): string {
  return giftPurchaseHistoryPurchaseSchema.shape.orderId.parse(value);
}
function ref(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    return historyUnavailable();
  return value;
}
function time(value: unknown): bigint {
  const result = databaseTimestampEpochMicroseconds(
    readDatabaseTimestamp(value),
  );
  if (result < 0n || result > 253402300799999999n) return historyUnavailable();
  return result;
}
function within(value: unknown, minimum: bigint, maximum: bigint): bigint {
  const result = time(value);
  if (result < minimum || result > maximum) return historyUnavailable();
  return result;
}
function scoped(
  row: Row,
  scope: GiftPaymentHistoryReadScope,
  account?: string,
) {
  if (
    row.site_id !== scope.siteId ||
    row.environment !== scope.mode ||
    (account !== undefined && row.account_id !== account)
  )
    return historyUnavailable();
}
function unique(rows: Row[]) {
  const result = new Map<string, Row>();
  for (const row of rows) {
    const key = id(row.id);
    if (result.has(key)) return historyUnavailable();
    result.set(key, row);
  }
  return result;
}
function values(column: SQL, input: string[]): SQL {
  return input.length
    ? sql`${column} IN (${sql.join(
        input.map((value) => sql`${value}`),
        sql`,`,
      )})`
    : sql`false`;
}
async function rows(
  tx: Transaction,
  table: PgTable,
  where: SQL,
  columns: SQL = sql`to_jsonb(t)`,
): Promise<Row[]> {
  const result = await tx.execute(
    sql`SELECT ${columns} AS record FROM ${table} t WHERE ${where} LIMIT ${scanLimit + 1}`,
  );
  if (result.rows.length > scanLimit) return historyUnavailable();
  const loaded = result.rows.map((row) => structuredClone(object(row.record)));
  unique(loaded);
  return loaded;
}
const operationProjection = sql`jsonb_build_object(
'id',t.id,'site_id',t.site_id,'account_id',t.account_id,'environment',t.environment,
'kind',t.kind,'state',t.state,'request_id',t.request_id,'request_hash',t.request_hash,
'request_snapshot',CASE WHEN t.kind='CHECKOUT_CREATE' THEN t.request_snapshot ELSE NULL END,
'provisioning_version',t.request_snapshot->>'version','nomination',t.request_snapshot->'nomination','provision',t.request_snapshot->'provision',
'sealed_present',COALESCE(t.request_snapshot->'sealedResult'<>'null'::jsonb,false),
'attempts',t.attempts,'lease_owner',t.lease_owner,'lease_token',t.lease_token,'lease_expires_at',t.lease_expires_at,
'provider_operation_reference',t.provider_operation_reference,'order_id',t.order_id,'payment_id',t.payment_id,
'withdrawal_intent_id',t.withdrawal_intent_id,'next_attempt_at',t.next_attempt_at,'last_error_code',t.last_error_code,
'created_at',t.created_at,'updated_at',t.updated_at)`;
interface Context {
  quotes: Map<string, Row>;
  accounts: Map<string, Row>;
  destinations: Row[];
  operations: Row[];
  isDemo: boolean;
  at: bigint;
}
async function context(
  tx: Transaction,
  scope: GiftPaymentHistoryReadScope,
  orders: Row[],
): Promise<Context> {
  const clock = await tx.execute(sql`SELECT clock_timestamp()::text AS clock`);
  if (clock.rows.length !== 1) return historyUnavailable();
  const at = time(clock.rows[0].clock);
  const siteResult = await tx.execute(
    sql`SELECT s.id,s.is_demo FROM "site" s WHERE s.id=${scope.siteId}`,
  );
  if (
    siteResult.rows.length !== 1 ||
    siteResult.rows[0].id !== scope.siteId ||
    typeof siteResult.rows[0].is_demo !== "boolean"
  )
    return historyUnavailable();
  for (const order of orders) {
    scoped(order, scope);
    id(order.account_id);
    id(order.quote_id);
    within(order.created_at, 0n, at);
  }
  const accountIds = [...new Set(orders.map((order) => id(order.account_id)))];
  const quoteIds = [...new Set(orders.map((order) => id(order.quote_id)))];
  const orderIds = orders.map((order) => id(order.id));
  const quotes = await rows(tx, giftQuoteRecord, values(sql`t.id`, quoteIds));
  const accounts = await rows(
    tx,
    receivingAccount,
    values(sql`t.id`, accountIds),
    sql`jsonb_build_object('id',t.id,'site_id',t.site_id,'environment',t.environment,'provider',t.provider,
      'operator_user_id',t.operator_user_id,'operator_reference',t.operator_reference,'account_reference',t.account_reference,
      'recipient_reference',t.recipient_reference,'created_at',t.created_at)`,
  );
  const destinations = await rows(
    tx,
    receivingDestination,
    values(sql`t.account_id`, accountIds),
    sql`jsonb_build_object('id',t.id,'site_id',t.site_id,'account_id',t.account_id,'environment',t.environment,
      'version',t.version,'bank_reference',t.bank_reference,'created_at',t.created_at)`,
  );
  const operations = await rows(
    tx,
    financialOperation,
    sql`(t.kind='ACCOUNT_CREATE' AND ${values(sql`t.account_id`, accountIds)}) OR ${values(sql`t.order_id`, orderIds)}`,
    operationProjection,
  );
  for (const row of [...quotes, ...accounts, ...destinations, ...operations])
    scoped(row, scope);
  return {
    quotes: unique(quotes),
    accounts: unique(accounts),
    destinations,
    operations,
    isDemo: siteResult.rows[0].is_demo,
    at,
  };
}
function original(
  order: Row,
  data: Context,
  scope: GiftPaymentHistoryReadScope,
  environment: string,
) {
  scoped(order, scope);
  const accountId = id(order.account_id),
    quote = data.quotes.get(id(order.quote_id)),
    account = data.accounts.get(accountId);
  if (!quote || !account) return historyUnavailable();
  scoped(quote, scope, accountId);
  if (account.id !== accountId || account.provider !== "ASAAS")
    return historyUnavailable();
  const snapshot = readGiftQuoteSnapshot(
    object(quote.snapshot) as unknown as GiftQuoteSnapshot,
  );
  if (!isDeepStrictEqual(snapshot, quote.snapshot)) return historyUnavailable();
  if (
    snapshot.pricing.provenance === "local-test" &&
    (scope.mode !== "sandbox" || environment === "production" || !data.isDemo)
  )
    return historyUnavailable();
  const q = snapshot.quote,
    binding = snapshot.receiving;
  if (
    q.id !== quote.id ||
    q.siteId !== scope.siteId ||
    q.mode !== scope.mode ||
    q.giftId !== quote.gift_id ||
    binding.provider !== "ASAAS" ||
    binding.siteId !== scope.siteId ||
    binding.environment !== scope.mode ||
    binding.accountReference !== account.account_reference ||
    binding.recipientReference !== account.recipient_reference ||
    binding.operatorReference !== account.operator_reference ||
    binding.destinationVersion !== quote.destination_version ||
    time(snapshot.createdAt) !== time(quote.created_at) ||
    time(snapshot.expiresAt) !== time(quote.expires_at) ||
    [
      "method",
      "currency",
      "nominalCents",
      "commissionBasisPoints",
      "commissionCents",
      "processingCents",
      "totalCents",
      "policyVersion",
    ].some(
      (key) =>
        q[key as keyof typeof q] !==
        quote[
          key.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`)
        ],
    )
  )
    return historyUnavailable();
  const purchased = within(order.created_at, time(quote.created_at), data.at);
  const destination = data.destinations.filter(
    (row) =>
      row.account_id === accountId &&
      row.version === binding.destinationVersion,
  );
  if (
    destination.length !== 1 ||
    destination[0].bank_reference !== binding.bankReference
  )
    return historyUnavailable();
  within(
    destination[0].created_at,
    time(account.created_at),
    time(quote.created_at),
  );
  const producers = data.operations.filter(
    (row) => row.kind === "ACCOUNT_CREATE" && row.account_id === accountId,
  );
  let bound = false;
  if (producers.length > 1) return historyUnavailable();
  if (
    producers.length === 1 &&
    producers[0].provisioning_version === "receiving.account-provisioning.v1"
  ) {
    const operation = producers[0];
    const record = readReceivingProvisioningRecord({
      version: operation.provisioning_version,
      nomination: operation.nomination,
      provision: operation.provision,
      sealedResult: null,
    });
    const nomination = record.nomination,
      dispatch = record.provision.dispatch;
    if (
      nomination.siteId !== scope.siteId ||
      nomination.environment !== scope.mode ||
      nomination.accountId !== accountId ||
      nomination.operatorUserId !== account.operator_user_id ||
      nomination.operationId !== operation.id ||
      nomination.requestId !== operation.request_id ||
      nomination.requestHash !== operation.request_hash ||
      operation.order_id !== null ||
      operation.payment_id !== null ||
      operation.withdrawal_intent_id !== null ||
      operation.last_error_code !== null ||
      operation.sealed_present !== false ||
      time(operation.created_at) !== time(nomination.createdAt) ||
      time(account.created_at) !== time(nomination.createdAt) ||
      time(operation.next_attempt_at) !== time(nomination.createdAt) ||
      operation.lease_owner !== dispatch.leaseOwner ||
      operation.lease_token !== dispatch.leaseToken ||
      time(operation.lease_expires_at) !==
        BigInt(dispatch.leaseExpiresAtMicroseconds)
    )
      return historyUnavailable();
    bound =
      operation.state === "SUCCEEDED" &&
      operation.attempts === 1 &&
      dispatch.possibleDispatch &&
      operation.provider_operation_reference === account.account_reference;
  }
  const purchase = giftPurchaseHistoryPurchaseSchema.parse({
    siteId: scope.siteId,
    mode: scope.mode,
    orderId: id(order.id),
    quoteId: id(quote.id),
    giftId: q.giftId,
    titleSnapshot: q.title,
    method: q.method,
    currency: "BRL",
    purchasedAtMicros: purchased.toString(),
    destinationVersion: binding.destinationVersion,
    policyVersion: q.policyVersion,
    binding: bound ? "AVAILABLE" : "UNBOUND",
    quoted: {
      nominalCents: q.nominalCents,
      commissionCents: q.commissionCents,
      processingCents: q.processingCents,
      totalCents: q.totalCents,
      ...(q.feeAllocation ? { feeAllocation: q.feeAllocation } : {}),
    },
  });
  return { purchase, snapshot, account, order, bound };
}
type Plan = ReturnType<typeof original>;
function operationFor(
  plan: Plan,
  attempt: Row,
  data: Context,
  scope: GiftPaymentHistoryReadScope,
) {
  scoped(attempt, scope, id(plan.account.id));
  if (
    attempt.order_id !== plan.order.id ||
    attempt.operation_kind !== "CHECKOUT_CREATE" ||
    attempt.operation_id !== attempt.id ||
    attempt.attempt_number !== 1
  )
    return historyUnavailable();
  const matches = data.operations.filter(
    (row) => row.id === attempt.operation_id,
  );
  if (matches.length !== 1) return historyUnavailable();
  const operation = matches[0];
  if (
    operation.kind !== "CHECKOUT_CREATE" ||
    operation.order_id !== plan.order.id ||
    operation.account_id !== plan.account.id ||
    operation.request_id !== plan.order.request_id ||
    operation.request_hash !== plan.order.request_hash ||
    ![
      "REQUESTED",
      "CLAIMED",
      "PROCESSING",
      "SUCCEEDED",
      "UNKNOWN",
      "RETRY",
      "FAILED",
      "CANCELLED",
    ].includes(String(operation.state))
  )
    return historyUnavailable();
  const expectedHash = createHash("sha256")
    .update(
      JSON.stringify([
        "gift-checkout-create-v1",
        scope.siteId,
        plan.order.request_id,
        plan.order.quote_id,
        plan.order.recovery_token_hash,
      ]),
    )
    .digest("hex");
  if (expectedHash !== plan.order.request_hash) return historyUnavailable();
  const snapshot = object(operation.request_snapshot);
  const expected = {
    version: 1,
    siteId: scope.siteId,
    accountId: plan.account.id,
    environment: scope.mode,
    quoteId: plan.order.quote_id,
    orderId: plan.order.id,
    attemptId: attempt.id,
    requestId: plan.order.request_id,
  };
  const { preDispatchRejection: _rejection, ...identity } = snapshot;
  if (!isDeepStrictEqual(identity, expected)) return historyUnavailable();
  if (
    Object.hasOwn(snapshot, "preDispatchRejection") &&
    (!["CANCELLED", "FAILED"].includes(String(operation.state)) ||
      operation.attempts !== 0 ||
      operation.provider_operation_reference !== null ||
      attempt.provider_reference !== null)
  )
    return historyUnavailable();
  within(attempt.created_at, time(plan.order.created_at), data.at);
  within(operation.created_at, time(plan.order.created_at), data.at);
  within(operation.updated_at, time(operation.created_at), data.at);
  if (operation.state === "SUCCEEDED") {
    if (operation.attempts !== 1 || operation.lease_token !== attempt.id)
      return historyUnavailable();
    id(operation.lease_owner);
    // Retained dispatch proof must cover success; its present expiry is irrelevant.
    const lease = time(operation.lease_expires_at);
    if (
      lease <= time(operation.created_at) ||
      lease < time(operation.updated_at)
    )
      return historyUnavailable();
  }
  return operation;
}
function eventPayload(
  row: Row,
  plan: Plan,
  data: Context,
  scope: GiftPaymentHistoryReadScope,
) {
  scoped(row, scope, id(plan.account.id));
  id(row.id);
  if (
    typeof row.event_type !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,127}$/.test(row.event_type) ||
    typeof row.provider_event_reference !== "string" ||
    row.provider_event_reference.length < 1 ||
    row.provider_event_reference.length > 256 ||
    Array.from(row.provider_event_reference).some(
      (c) => c.charCodeAt(0) < 33 || c.charCodeAt(0) > 126,
    ) ||
    !["RECEIVED", "CLAIMED", "PROCESSED", "RETRY", "DEAD_LETTER"].includes(
      String(row.state),
    )
  )
    return historyUnavailable();
  const payload = object(row.payload);
  const checkoutEvent = [
    "CHECKOUT_CREATED",
    "CHECKOUT_PAID",
    "CHECKOUT_CANCELED",
    "CHECKOUT_EXPIRED",
  ].includes(row.event_type);
  if (
    !Object.hasOwn(payload, checkoutEvent ? "checkoutId" : "paymentId") ||
    Object.keys(payload).some(
      (key) => !["paymentId", "checkoutId", "externalReference"].includes(key),
    )
  )
    return historyUnavailable();
  if (Object.hasOwn(payload, "paymentId")) ref(payload.paymentId);
  if (Object.hasOwn(payload, "checkoutId")) ref(payload.checkoutId);
  if (Object.hasOwn(payload, "externalReference"))
    id(payload.externalReference);
  if (
    row.payload_hash !==
    hashAsaasEventIdentity(
      row.provider_event_reference,
      row.event_type,
      ref(plan.account.account_reference),
      payload as Record<string, string>,
    )
  )
    return historyUnavailable();
  const authenticated = within(
    row.authenticated_at,
    time(plan.account.created_at),
    data.at,
  );
  within(row.received_at, time(plan.account.created_at), authenticated);
  if (row.processed_at !== null)
    within(row.processed_at, authenticated, data.at);
  if (row.state === "PROCESSED" && row.processed_at === null)
    return historyUnavailable();
  return payload;
}
function recordedState(row: Row): GiftPurchaseHistoryPayment["recordedState"] {
  if (row.verification_status !== "VERIFIED") return "UNKNOWN";
  if (
    /^(REFUND|CHARGEBACK)|^(CANCELED|CANCELLED|DISPUTED|DELETED)$/.test(
      String(row.provider_status),
    )
  )
    return "RESTRICTED";
  if (
    ["RECEIVED", "PENDING", "CONFIRMED"].includes(String(row.provider_status))
  )
    return row.provider_status as GiftPurchaseHistoryPayment["recordedState"];
  return "UNKNOWN";
}
function bindingHash(
  scope: GiftPaymentHistoryReadScope,
  detail: boolean,
  orderId: string | null,
) {
  // This binds navigation to a native scope, never financial authority or chronology.
  return createHash("sha256")
    .update(
      JSON.stringify(["gift-history.navigation.v1", scope, detail, orderId]),
    )
    .digest();
}
interface Position {
  kind: number;
  at: bigint;
  id: string;
}
function encode(
  scope: GiftPaymentHistoryReadScope,
  detail: boolean,
  orderId: string | null,
  position: Position,
) {
  const bytes = Buffer.alloc(42 + Buffer.byteLength(position.id));
  bytes[0] = 1;
  bytes[1] = position.kind;
  bytes.writeBigUInt64BE(position.at, 2);
  bindingHash(scope, detail, orderId).copy(bytes, 10);
  bytes.write(position.id, 42, "ascii");
  return `gh1.${bytes.toString("base64url")}`;
}
function decode(
  scope: GiftPaymentHistoryReadScope,
  detail: boolean,
  orderId: string | null,
  cursor: string | null,
): Position | null {
  if (cursor === null) return null;
  if (!/^gh1\.[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 256)
    return historyUnavailable();
  const bytes = Buffer.from(cursor.slice(4), "base64url");
  if (
    bytes.length < 43 ||
    bytes.length > 170 ||
    bytes.toString("base64url") !== cursor.slice(4) ||
    bytes[0] !== 1 ||
    (!detail && bytes[1] !== 0) ||
    (detail && bytes[1] > 1) ||
    !timingSafeEqual(
      bytes.subarray(10, 42),
      bindingHash(scope, detail, orderId),
    )
  )
    return historyUnavailable();
  const position = {
    kind: bytes[1],
    at: bytes.readBigUInt64BE(2),
    id: id(bytes.subarray(42).toString("ascii")),
  };
  if (
    position.at > 253402300799999999n ||
    Buffer.from(position.id, "ascii").compare(bytes.subarray(42)) !== 0
  )
    return historyUnavailable();
  return position;
}
function publicEnvelope(scope: GiftPaymentHistoryReadScope, at: bigint) {
  return {
    scope: { siteId: scope.siteId, mode: scope.mode, policy: scope.policy },
    consistency: "PER_READ",
    readObservedAtMicros: at.toString(),
    currentKnowledge: "UNKNOWN",
    sourceOrdering: "UNAVAILABLE",
    nextCursor: null as string | null,
  };
}
export function createGiftPaymentHistoryRepository(
  database: AuthDatabase,
  options?: GiftPaymentHistoryRepositoryOptions,
): GiftPaymentHistoryRepository {
  if (
    !options ||
    !["sandbox", "live"].includes(options.mode) ||
    !["test", "development", "production"].includes(
      options.applicationEnvironment,
    ) ||
    options.policy !== "SITE_HISTORY" ||
    typeof options.now !== "function"
  )
    return historyUnavailable();
  const mode = options.mode,
    environment = options.applicationEnvironment,
    now = options.now.bind(options);
  let closing = false,
    closed: Promise<void> | undefined;
  const pending = new Set<Promise<void>>();
  async function authority(scope: GiftPaymentHistoryReadScope) {
    const sample = now();
    if (!(sample instanceof Date) || time(sample) < 0n)
      return historyUnavailable();
    const native =
      await database.execute(sql`SELECT se.id AS "sessionId",se.user_id AS "userId",se.expires_at::text AS "expiresAt",
      se.created_at::text AS "createdAt",se.last_active_at::text AS "lastActiveAt",u.role,u.state,clock_timestamp()::text AS "checkedAt"
      FROM ${session} se INNER JOIN ${user} u ON u.id=se.user_id WHERE se.id=${scope.sessionId} AND se.user_id=${scope.userId}`);
    const row = native.rows[0] as Row | undefined;
    if (
      native.rows.length !== 1 ||
      !row ||
      row.userId !== scope.userId ||
      row.sessionId !== scope.sessionId ||
      (row.role !== "SITE_ADMIN" && row.role !== "OWNER") ||
      row.state !== "ACTIVE"
    )
      return historyUnavailable();
    const checked = time(row.checkedAt),
      expires = time(row.expiresAt),
      created = time(row.createdAt),
      active = time(row.lastActiveAt);
    if (
      expires <= checked ||
      created > active ||
      active > checked ||
      checked - created >= BigInt(ADMIN_ABSOLUTE_TIMEOUT_MS) * 1000n ||
      checked - active >= BigInt(ADMIN_IDLE_TIMEOUT_MS) * 1000n
    )
      return historyUnavailable();
    const access = await resolveSiteAccess(database, {
      userId: scope.userId,
      platformRole: row.role,
      siteId: scope.siteId,
    });
    assertFinancialReadAccess(access, scope.siteId);
    if (
      !access ||
      access.userId !== scope.userId ||
      access.membershipRole !== row.role ||
      access.membershipId !== scope.membershipId
    )
      return historyUnavailable();
    return {
      checked,
      frame: {
        sessionId: scope.sessionId,
        userId: scope.userId,
        expires: expires.toString(),
        created: created.toString(),
        active: active.toString(),
        access: structuredClone(access),
      },
    };
  }
  function owned<T>(
    input: GiftPaymentHistoryReadScope,
    reader: (
      scope: GiftPaymentHistoryReadScope,
      originalClock: bigint,
      tx: Transaction,
    ) => Promise<T>,
  ): Promise<T> {
    if (closing)
      return Promise.reject(new Error("Purchase history unavailable"));
    let finish!: () => void;
    const completion = new Promise<void>((yes) => {
      finish = yes;
    });
    pending.add(completion);
    const result = (async () => {
      try {
        const scope = readGiftPaymentHistoryScope(input);
        if (scope.mode !== mode) return historyUnavailable();
        const original = await authority(scope);
        if (closing) return historyUnavailable();
        const result = await database.transaction(
          (tx) => reader(scope, original.checked, tx),
          { isolationLevel: "repeatable read", accessMode: "read only" },
        );
        const current = await authority(scope);
        if (
          closing ||
          current.checked < original.checked ||
          !isDeepStrictEqual(current.frame, original.frame)
        )
          return historyUnavailable();
        return result;
      } catch {
        return historyUnavailable();
      } finally {
        pending.delete(completion);
        finish();
      }
    })();
    void result.catch(() => {});
    return result;
  }
  return Object.freeze({
    database,
    mode,
    applicationEnvironment: environment,
    policy: "SITE_HISTORY" as const,
    readPurchasePage(
      input: GiftPaymentHistoryReadScope,
      cursor: string | null,
    ) {
      return owned(input, async (scope, originalClock, tx) => {
        const position = decode(scope, false, null, cursor);
        let anchor: Row | undefined;
        if (position) {
          const found =
            await tx.execute(sql`SELECT to_jsonb(o) AS record FROM ${giftOrder} o WHERE o.id=${position.id}
            AND o.site_id=${scope.siteId} AND o.environment=${mode} LIMIT 2`);
          if (found.rows.length !== 1) return historyUnavailable();
          anchor = object(found.rows[0].record);
          if (time(anchor.created_at) !== position.at)
            return historyUnavailable();
        }
        const filter = position
          ? sql`AND ((EXTRACT(EPOCH FROM o.created_at)*1000000)<${position.at.toString()}::numeric
          OR ((EXTRACT(EPOCH FROM o.created_at)*1000000)=${position.at.toString()}::numeric AND o.id COLLATE "C"<${position.id}))`
          : sql``;
        const result =
          await tx.execute(sql`SELECT to_jsonb(o) AS record FROM ${giftOrder} o WHERE o.site_id=${scope.siteId}
          AND o.environment=${mode} ${filter} ORDER BY o.created_at DESC,o.id COLLATE "C" DESC LIMIT ${giftPurchaseHistoryLimits.indexRows + 1}`);
        if (result.rows.length > giftPurchaseHistoryLimits.indexRows + 1)
          return historyUnavailable();
        const orders = result.rows.map((row) => object(row.record));
        unique(orders);
        const data = await context(
          tx,
          scope,
          anchor ? [...orders, anchor] : orders,
        );
        if (data.at < originalClock) return historyUnavailable();
        if (anchor) original(anchor, data, scope, environment);
        const purchases = orders.map(
          (row) => original(row, data, scope, environment).purchase,
        );
        const items = purchases.slice(0, giftPurchaseHistoryLimits.indexRows);
        const envelope = publicEnvelope(scope, data.at);
        if (purchases.length > items.length) {
          const last = items[items.length - 1];
          envelope.nextCursor = encode(scope, false, null, {
            kind: 0,
            at: BigInt(last.purchasedAtMicros),
            id: last.orderId,
          });
        }
        return giftPurchaseHistoryPageResponseSchema.parse({
          history: { ...envelope, items },
        });
      });
    },
    readPurchaseDetailPage(
      input: GiftPaymentHistoryReadScope,
      requestedOrder: string,
      cursor: string | null,
    ) {
      return owned(input, async (scope, originalClock, tx) => {
        const orderId = id(requestedOrder),
          position = decode(scope, true, orderId, cursor);
        const result =
          await tx.execute(sql`SELECT to_jsonb(o) AS record FROM ${giftOrder} o WHERE o.id=${orderId}
          AND o.site_id=${scope.siteId} AND o.environment=${mode} LIMIT 2`);
        if (result.rows.length !== 1) return historyUnavailable();
        const order = object(result.rows[0].record),
          data = await context(tx, scope, [order]);
        if (data.at < originalClock) return historyUnavailable();
        const plan = original(order, data, scope, environment),
          envelope = publicEnvelope(scope, data.at);
        const coverage = {
          payments: "AVAILABLE",
          receipts: "AVAILABLE",
          reversals: "UNAVAILABLE",
          bankSettlement: "UNAVAILABLE",
        };
        if (!plan.bound) {
          if (position) return historyUnavailable();
          return giftPurchaseHistoryDetailResponseSchema.parse({
            history: {
              ...envelope,
              currentKnowledge: "UNAVAILABLE",
              originalPurchase: plan.purchase,
              coverage: {
                ...coverage,
                payments: "UNAVAILABLE",
                receipts: "UNAVAILABLE",
              },
              retainedPayments: [],
              validatedHistoricalReceipts: [],
            },
          });
        }
        const attempts = await rows(
          tx,
          giftCheckoutAttempt,
          sql`t.order_id=${orderId}`,
        );
        const payments = await rows(
          tx,
          giftPaymentRecord,
          sql`t.order_id=${orderId} OR ${values(
            sql`t.attempt_id`,
            attempts.map((row) => id(row.id)),
          )}`,
        );
        const attemptMap = unique(attempts),
          paymentMap = unique(payments);
        for (const attempt of attempts)
          operationFor(plan, attempt, data, scope);
        const paymentIds = payments.map((row) => id(row.id));
        const ledgers = await rows(
          tx,
          financialLedgerEntry,
          sql`${values(sql`t.payment_id`, paymentIds)} OR
          t.compensates_entry_id IN (SELECT l.id FROM ${financialLedgerEntry} l WHERE ${values(sql`l.payment_id`, paymentIds)})`,
        );
        const events = await rows(
          tx,
          financialEventInbox,
          sql`${values(
            sql`t.id`,
            ledgers
              .filter((row) => row.event_id !== null)
              .map((row) => id(row.event_id)),
          )} OR
          ${values(sql`t.payment_id`, paymentIds)} OR ${values(
            sql`t.payload->>'externalReference'`,
            attempts.map((row) => id(row.id)),
          )} OR
          ${values(
            sql`t.payload->>'checkoutId'`,
            attempts
              .filter((row) => row.provider_reference !== null)
              .map((row) => ref(row.provider_reference)),
          )} OR
          ${values(
            sql`t.payload->>'paymentId'`,
            payments.map((row) => ref(row.provider_payment_reference)),
          )}`,
        );
        const eventMap = unique(events),
          ledgerMap = unique(ledgers);
        let unavailable = false,
          receiptUnavailable = false;
        for (const event of events) {
          eventPayload(event, plan, data, scope);
          if (
            /^(REFUND|TRANSFER)_|^PAYMENT_(REFUND|CHARGEBACK)|CANCEL|DISPUT/.test(
              String(event.event_type),
            )
          )
            unavailable = true;
        }
        const projectedPayments = new Map<string, GiftPurchaseHistoryPayment>();
        const nativeRefs = new Set<string>();
        for (const payment of payments) {
          scoped(payment, scope, id(plan.account.id));
          if (
            payment.order_id !== orderId ||
            !["UNVERIFIED", "VERIFIED"].includes(
              String(payment.verification_status),
            )
          )
            return historyUnavailable();
          const reference = ref(payment.provider_payment_reference);
          if (nativeRefs.has(reference)) return historyUnavailable();
          nativeRefs.add(reference);
          const attempt = attemptMap.get(id(payment.attempt_id));
          if (!attempt) return historyUnavailable();
          const operation = operationFor(plan, attempt, data, scope);
          if (
            operation.state !== "SUCCEEDED" ||
            ref(attempt.provider_reference) !==
              operation.provider_operation_reference
          )
            return historyUnavailable();
          if (
            payment.verification_status === "VERIFIED" &&
            (payment.observed_at === null ||
              payment.provider_status === null ||
              payment.gross_cents === null)
          )
            return historyUnavailable();
          const projected = giftPurchaseHistoryPaymentSchema.parse({
            paymentId: id(payment.id),
            attemptId: id(payment.attempt_id),
            orderId,
            currency: payment.currency,
            recordedState: recordedState(payment),
            createdAtMicros: within(
              payment.created_at,
              time(order.created_at),
              data.at,
            ).toString(),
            observedAtMicros:
              payment.observed_at === null
                ? null
                : within(
                    payment.observed_at,
                    time(order.created_at),
                    data.at,
                  ).toString(),
            grossCents: payment.gross_cents,
            processingCents: payment.processing_cents,
            commissionCents: payment.commission_cents,
            recipientNetCents: payment.recipient_net_cents,
          });
          projectedPayments.set(projected.paymentId, projected);
          if (projected.recordedState === "RESTRICTED") unavailable = true;
        }
        const projectedReceipts = new Map<string, GiftPurchaseHistoryReceipt>(),
          creditedPayments = new Set<string>();
        for (const ledger of ledgers) {
          scoped(ledger, scope, id(plan.account.id));
          id(ledger.id);
          const posted = within(
            ledger.created_at,
            time(order.created_at),
            data.at,
          );
          const amount = giftCentsSchema.parse(ledger.amount_cents);
          if (
            amount <= 0 ||
            ledger.currency !== "BRL" ||
            !["CREDIT", "DEBIT"].includes(String(ledger.direction))
          )
            return historyUnavailable();
          if (
            ledger.compensates_entry_id !== null &&
            !ledgerMap.has(id(ledger.compensates_entry_id))
          )
            return historyUnavailable();
          if (
            ledger.kind !== "GIFT_RECEIVED" ||
            ledger.direction !== "CREDIT" ||
            ledger.compensates_entry_id !== null
          ) {
            unavailable = true;
            continue;
          }
          const payment = paymentMap.get(id(ledger.payment_id));
          if (!payment || creditedPayments.has(id(payment.id)))
            return historyUnavailable();
          creditedPayments.add(id(payment.id));
          const attempt = attemptMap.get(id(payment.attempt_id));
          if (!attempt) return historyUnavailable();
          const operation = operationFor(plan, attempt, data, scope),
            q = plan.snapshot.quote;
          const actualProcessing = giftCentsSchema.parse(
            payment.processing_cents,
          );
          const recipientNet = giftCentsSchema.parse(
            payment.recipient_net_cents,
          );
          if (
            ledger.effect_key !==
              giftReceivedEffectKey(ref(payment.provider_payment_reference)) ||
            recipientNet <= 0 ||
            amount !== recipientNet ||
            operation.state !== "SUCCEEDED" ||
            payment.provider_status !== "RECEIVED" ||
            payment.verification_status !== "VERIFIED" ||
            payment.observed_at === null ||
            payment.gross_cents !== q.totalCents ||
            BigInt(q.totalCents) !==
              BigInt(actualProcessing) +
                BigInt(q.commissionCents) +
                BigInt(recipientNet) ||
            payment.commission_cents !== q.commissionCents ||
            payment.split_fixed_cents !== q.commissionCents ||
            (q.commissionCents > 0 && !ref(payment.split_provider_reference))
          )
            return historyUnavailable();
          const observed = within(
            payment.observed_at,
            time(order.created_at),
            posted,
          );
          if (ledger.event_id === null || ledger.operation_id === null) {
            receiptUnavailable = true;
            continue;
          }
          if (ledger.operation_id !== operation.id) return historyUnavailable();
          const event = eventMap.get(id(ledger.event_id));
          if (!event) {
            receiptUnavailable = true;
            continue;
          }
          const payload = eventPayload(event, plan, data, scope);
          if (
            event.event_type !== "PAYMENT_RECEIVED" ||
            event.state !== "PROCESSED" ||
            event.payment_id !== payment.id ||
            payload.paymentId !== payment.provider_payment_reference ||
            (payload.checkoutId !== undefined &&
              payload.checkoutId !== attempt.provider_reference) ||
            (payload.externalReference !== undefined &&
              payload.externalReference !== attempt.id) ||
            time(event.authenticated_at) > posted ||
            time(event.processed_at) < posted
          )
            return historyUnavailable();
          const receipt = giftPurchaseHistoryReceiptSchema.parse({
            effectId: id(ledger.id),
            paymentId: id(payment.id),
            orderId,
            currency: "BRL",
            recipientCreditCents: amount,
            postedAtMicros: posted.toString(),
            sourceObservedAtMicros: observed.toString(),
            source: "CORRELATED_STORED_POSTING",
          });
          projectedReceipts.set(receipt.effectId, receipt);
        }
        if (receiptUnavailable) {
          projectedReceipts.clear();
          coverage.receipts = "UNAVAILABLE";
          unavailable = true;
        }
        const facts = [
          ...[...projectedPayments.values()].map((value) => ({
            kind: 0,
            at: BigInt(value.createdAtMicros),
            id: value.paymentId,
            value,
          })),
          ...[...projectedReceipts.values()].map((value) => ({
            kind: 1,
            at: BigInt(value.postedAtMicros),
            id: value.effectId,
            value,
          })),
        ].sort((a, b) =>
          a.at === b.at
            ? a.kind - b.kind || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
            : a.at < b.at
              ? -1
              : 1,
        );
        let offset = 0;
        if (position) {
          const index = facts.findIndex(
            (item) =>
              item.kind === position.kind &&
              item.id === position.id &&
              item.at === position.at,
          );
          if (index < 0) return historyUnavailable();
          offset = index + 1;
        }
        const page = facts.slice(
          offset,
          offset + giftPurchaseHistoryLimits.detailFacts,
        );
        if (offset + page.length < facts.length)
          envelope.nextCursor = encode(
            scope,
            true,
            orderId,
            page[page.length - 1],
          );
        return giftPurchaseHistoryDetailResponseSchema.parse({
          history: {
            ...envelope,
            currentKnowledge: unavailable ? "UNAVAILABLE" : "UNKNOWN",
            originalPurchase: plan.purchase,
            coverage,
            retainedPayments: page
              .filter((item) => item.kind === 0)
              .map((item) => item.value),
            validatedHistoricalReceipts: page
              .filter((item) => item.kind === 1)
              .map((item) => item.value),
          },
        });
      });
    },
    close() {
      if (closed) return closed;
      closing = true;
      closed = Promise.all([...pending]).then(() => {});
      return closed;
    },
  });
}
