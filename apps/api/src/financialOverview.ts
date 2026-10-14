import {
  type FinancialOverview,
  financialOverviewSchema,
  giftCentsSchema,
  giftQuoteSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import type { AsaasBalanceObservation } from "./asaasHttpClient";
import { compareDatabaseTimestamps } from "./databaseTimestamp";

export interface FinancialAccountBinding {
  provider: "ASAAS";
  siteId: string;
  accountBindingId: string;
  accountReference: string;
  environment: "sandbox" | "live";
}

export type StoredFinancialTotals = Pick<
  FinancialOverview,
  | "nominalReceivedCents"
  | "netReceivedCents"
  | "processingCents"
  | "commissionCents"
  | "awaitingReleaseCents"
  | "pendingCommitmentsCents"
  | "withdrawnCents"
  | "refundedCents"
>;

// The repository must compute complete actual totals in an authoritative stored
// snapshot. This service does not define refund/history aggregation semantics.
export interface StoredFinancialTotalsSnapshot {
  binding: FinancialAccountBinding;
  currency: "BRL";
  totals: StoredFinancialTotals;
  observedAt: Date;
  lastBalanceObservation: AsaasBalanceObservation | null;
  // Correlated unresolved provider observations or reversals block availability.
  // The durable repository must count them explicitly; absence never means zero.
  unresolvedFinancialEventCount: number;
}

export interface FinancialOverviewRepository {
  loadStoredTotals(
    binding: FinancialAccountBinding,
  ): Promise<StoredFinancialTotalsSnapshot | null>;
  // A new scoped stored snapshot after the provider GET, never the earlier
  // totals transaction. Count actual debits/completions inclusively since the
  // conservative observation bound, plus all current unresolved financial facts.
  checkBalanceConsistency?(
    binding: FinancialAccountBinding,
    balanceObservedAt: Date,
  ): Promise<FinancialBalanceConsistencySnapshot | null>;
}

export interface FinancialBalanceConsistencySnapshot {
  binding: FinancialAccountBinding;
  balanceObservedAt: Date;
  checkedAt: Date;
  unresolvedFinancialEventCount: number;
  balanceEffectsAfterObservationCount: number;
}

// Only a server-selected authenticated provider reader may implement this port.
// The browser must never supply the binding, evidence, credential or reader.
export interface FinancialOverviewBalancePort {
  getBalance(
    binding: FinancialAccountBinding,
  ): Promise<AsaasBalanceObservation | null>;
}

export interface FinancialOverviewInput {
  mode: FinancialOverview["mode"];
  binding: FinancialAccountBinding;
  repository: FinancialOverviewRepository;
  providerBalance?: FinancialOverviewBalancePort;
  now: () => Date;
  freshnessMs: number;
}

export class FinancialOverviewServiceError extends Error {
  readonly status = 503;
  readonly code = "FINANCIAL_OVERVIEW_UNAVAILABLE";
  readonly title = "Financial overview is unavailable";

  constructor() {
    super("Financial overview is unavailable");
    this.name = "FinancialOverviewServiceError";
  }
}

function unavailable(): never {
  throw new FinancialOverviewServiceError();
}

const bindingKeys = [
  "provider",
  "siteId",
  "accountBindingId",
  "accountReference",
  "environment",
];
const totalsKeys = [
  "nominalReceivedCents",
  "netReceivedCents",
  "processingCents",
  "commissionCents",
  "awaitingReleaseCents",
  "pendingCommitmentsCents",
  "withdrawnCents",
  "refundedCents",
] as const;

function exactRecord(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return unavailable();
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return unavailable();
  return value as Record<string, unknown>;
}

function readBinding(value: unknown): FinancialAccountBinding {
  const raw = exactRecord(value, bindingKeys);
  const site = siteIdSchema.safeParse(raw.siteId);
  const account = giftQuoteSchema.shape.siteId.safeParse(raw.accountBindingId);
  if (
    !site.success ||
    !account.success ||
    raw.provider !== "ASAAS" ||
    (raw.environment !== "sandbox" && raw.environment !== "live") ||
    typeof raw.accountReference !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(raw.accountReference)
  )
    return unavailable();
  return {
    provider: "ASAAS",
    siteId: site.data,
    accountBindingId: account.data,
    accountReference: raw.accountReference,
    environment: raw.environment,
  };
}

function sameBinding(
  left: FinancialAccountBinding,
  right: FinancialAccountBinding,
): boolean {
  return (
    left.provider === right.provider &&
    left.siteId === right.siteId &&
    left.accountBindingId === right.accountBindingId &&
    left.accountReference === right.accountReference &&
    left.environment === right.environment
  );
}

function dateTime(value: unknown): number {
  if (
    !(value instanceof Date) ||
    !Number.isSafeInteger(value.getTime()) ||
    !financialOverviewSchema.shape.synchronizedAt.safeParse(value.toISOString())
      .success
  )
    return unavailable();
  return value.getTime();
}

function readTotals(value: unknown): StoredFinancialTotals {
  const raw = exactRecord(value, totalsKeys);
  const entries = totalsKeys.map((key) => {
    const parsed = giftCentsSchema.safeParse(raw[key]);
    if (!parsed.success) return unavailable();
    return [key, parsed.data] as const;
  });
  return Object.fromEntries(entries) as StoredFinancialTotals;
}

interface ValidBalance {
  balanceCents: number;
  observedAt: number;
}

function readBalance(
  value: unknown,
  binding: FinancialAccountBinding,
  now: number,
): ValidBalance | null {
  try {
    const raw = exactRecord(value, [
      "source",
      ...bindingKeys,
      "currency",
      "observedAt",
      "balanceCents",
    ]);
    const observationBinding = readBinding(
      Object.fromEntries(bindingKeys.map((key) => [key, raw[key]])),
    );
    const amount = giftCentsSchema.safeParse(raw.balanceCents);
    const observedAt = dateTime(raw.observedAt);
    if (
      raw.source !== "provider" ||
      raw.currency !== "BRL" ||
      !sameBinding(observationBinding, binding) ||
      !amount.success ||
      observedAt > now
    )
      return null;
    return { balanceCents: amount.data, observedAt };
  } catch {
    return null;
  }
}

function consistentBalance(
  value: unknown,
  binding: FinancialAccountBinding,
  balance: ValidBalance,
  fetchedAt: number,
  now: number,
): boolean {
  try {
    const raw = exactRecord(value, [
      "binding",
      "balanceObservedAt",
      "checkedAt",
      "unresolvedFinancialEventCount",
      "balanceEffectsAfterObservationCount",
    ]);
    dateTime(raw.balanceObservedAt);
    dateTime(raw.checkedAt);
    return (
      sameBinding(readBinding(raw.binding), binding) &&
      compareDatabaseTimestamps(
        raw.balanceObservedAt as Date,
        new Date(balance.observedAt),
      ) === 0 &&
      compareDatabaseTimestamps(
        raw.checkedAt as Date,
        raw.balanceObservedAt as Date,
      ) >= 0 &&
      compareDatabaseTimestamps(raw.checkedAt as Date, new Date(fetchedAt)) >=
        0 &&
      compareDatabaseTimestamps(raw.checkedAt as Date, new Date(now)) <= 0 &&
      [
        raw.unresolvedFinancialEventCount,
        raw.balanceEffectsAfterObservationCount,
      ].every(
        (count) =>
          typeof count === "number" &&
          Number.isSafeInteger(count) &&
          count === 0,
      )
    );
  } catch {
    return false;
  }
}

export async function loadFinancialOverview(
  input: FinancialOverviewInput,
): Promise<FinancialOverview> {
  try {
    const binding = Object.freeze(readBinding(input.binding));
    const mode = input.mode;
    const freshnessMs = input.freshnessMs;
    const clock = input.now;
    const loadStoredTotals = input.repository.loadStoredTotals.bind(
      input.repository,
    );
    const getBalance =
      mode === "disabled"
        ? undefined
        : input.providerBalance?.getBalance.bind(input.providerBalance);
    const checkBalanceConsistency =
      mode === "disabled"
        ? undefined
        : input.repository.checkBalanceConsistency?.bind(input.repository);
    if (
      (mode !== "disabled" && mode !== binding.environment) ||
      !Number.isSafeInteger(freshnessMs) ||
      freshnessMs < 1 ||
      freshnessMs > 300_000 ||
      typeof clock !== "function"
    )
      return unavailable();
    let lastClock = dateTime(clock());
    const currentTime = () => {
      const current = dateTime(clock());
      if (current < lastClock) return unavailable();
      lastClock = current;
      return current;
    };
    const raw = exactRecord(await loadStoredTotals(binding), [
      "binding",
      "currency",
      "totals",
      "observedAt",
      "lastBalanceObservation",
      "unresolvedFinancialEventCount",
    ]);
    const storedAt = currentTime();
    const unresolved = raw.unresolvedFinancialEventCount;
    if (
      raw.currency !== "BRL" ||
      raw.lastBalanceObservation === undefined ||
      typeof unresolved !== "number" ||
      !Number.isSafeInteger(unresolved) ||
      unresolved < 0 ||
      !sameBinding(readBinding(raw.binding), binding) ||
      dateTime(raw.observedAt) > storedAt
    )
      return unavailable();
    const totals = readTotals(raw.totals);
    const retained = readBalance(raw.lastBalanceObservation, binding, storedAt);
    let fetched: ValidBalance | null = null;
    let observedNow = storedAt;
    if (mode !== "disabled" && getBalance) {
      let observation: unknown;
      try {
        observation = await getBalance(binding);
      } catch {
        observation = null;
      }
      observedNow = currentTime();
      fetched = readBalance(observation, binding, observedNow);
    }
    const latest =
      fetched && (!retained || fetched.observedAt >= retained.observedAt)
        ? fetched
        : retained;
    let consistencyUnknown = false;
    let postFetchSafe = false;
    if (
      mode !== "disabled" &&
      unresolved === 0 &&
      fetched !== null &&
      latest === fetched &&
      BigInt(observedNow) - BigInt(fetched.observedAt) <= BigInt(freshnessMs)
    ) {
      const fetchedAt = observedNow;
      let proof: unknown = null;
      try {
        proof = await checkBalanceConsistency?.(
          binding,
          new Date(fetched.observedAt),
        );
      } catch {
        proof = null;
      }
      observedNow = currentTime();
      postFetchSafe = consistentBalance(
        proof,
        binding,
        fetched,
        fetchedAt,
        observedNow,
      );
      consistencyUnknown = !postFetchSafe;
    }
    const currentBalance =
      mode !== "disabled" &&
      unresolved === 0 &&
      postFetchSafe &&
      fetched !== null &&
      latest === fetched &&
      BigInt(observedNow) - BigInt(fetched.observedAt) <= BigInt(freshnessMs)
        ? fetched
        : null;
    // Overview balances are informational. Withdrawal must fetch its own balance
    // and atomically account for holds; this DTO never authorizes money movement.
    return financialOverviewSchema.parse({
      ...totals,
      siteId: binding.siteId,
      currency: "BRL",
      mode,
      availableCents: currentBalance?.balanceCents ?? null,
      synchronizedAt:
        latest === null ? null : new Date(latest.observedAt).toISOString(),
      availability: currentBalance
        ? "CURRENT"
        : !consistencyUnknown &&
            unresolved === 0 &&
            mode !== "disabled" &&
            latest
          ? "STALE"
          : "UNKNOWN",
    });
  } catch {
    return unavailable();
  }
}
