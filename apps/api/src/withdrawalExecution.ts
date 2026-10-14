import { isDeepStrictEqual, types } from "node:util";
import {
  databaseTimestampEpochMicroseconds,
  readDatabaseTimestamp,
} from "./databaseTimestamp";
import type {
  FinancialActor,
  RecentFinancialAuthenticationEvidence,
} from "./financialAuthorization";
import {
  readWithdrawalConsentRecord,
  readWithdrawalReservationSnapshot,
  sameWithdrawalConsentTerms,
  type WithdrawalConsentRecord,
  type WithdrawalProtectedRequestAttempt,
  type WithdrawalReservationContext,
  type WithdrawalReservationSnapshot,
  type WithdrawalVerifiedPresentation,
} from "./withdrawalReservations";

export interface WithdrawalCorrelation {
  siteId: string;
  requestId: string;
  requestHash: string;
  withdrawalId: string;
  operationId: string;
  accountId: string;
  accountReference: string;
  recipientReference: string;
  bankReference: string;
  operatorUserId: string;
  environment: "sandbox" | "live";
  destinationVersion: number;
  amountCents: number;
  feeCents: number;
  netCents: number;
  currency: "BRL";
  policyVersion: string;
}
export interface OriginalHolderConsentBinding {
  correlation: WithdrawalCorrelation;
  consentHash: string;
  bindingReference: string;
  holderUserId: string;
  holderConsentReference: string;
  actingUserId: string;
  holderRole: "BRIDE_HOLDER";
  provenance: "durable";
  verification: "verified";
}
export interface OriginalWithdrawal {
  snapshot: WithdrawalReservationSnapshot;
  consent: WithdrawalConsentRecord;
  associationId: string;
  correlation: WithdrawalCorrelation;
  holderBinding: OriginalHolderConsentBinding;
}
export interface DispatchFence {
  operationId: string;
  attempts: 1;
  leaseOwner: string;
  leaseToken: string;
  leaseExpiresAt: string;
}
export interface StoredWithdrawalExecution {
  original: OriginalWithdrawal;
  state:
    | "REQUESTED"
    | "AWAITING_AUTHORIZATION"
    | "PROCESSING"
    | "UNKNOWN"
    | "COMPLETED";
  operationState: "REQUESTED" | "PROCESSING" | "UNKNOWN" | "SUCCEEDED";
  reservationState: "HELD" | "CONSUMED";
  reservedCents: number;
  fence: DispatchFence | null;
  providerReference: string | null;
  receiptReference: string | null;
  resolutionObservedAt: string | null;
}
interface ObservationIdentity {
  correlation: WithdrawalCorrelation;
  holderBinding: OriginalHolderConsentBinding;
  fence: DispatchFence;
}
export type WithdrawalDispatchObservation = ObservationIdentity &
  (
    | {
        outcome: "ACCEPTED";
        providerReference: string;
        observedAt: string;
        proofReference: string | null;
      }
    | { outcome: "REJECTED"; reason: string }
    | { outcome: "UNRESOLVED" }
  );
export type WithdrawalLookupObservation =
  | { outcome: "FOUND"; observation: WithdrawalDispatchObservation }
  | { outcome: "UNRESOLVED" | "NOT_FOUND" };
export interface WithdrawalCompletionProof extends ObservationIdentity {
  outcome: "COMPLETED";
  proofReference: string;
  receiptReference: string;
  providerReference: string;
  totalDebitCents: number;
  feeCents: number;
  netCents: number;
  currency: "BRL";
  bankCompleted: true;
  custody: "immutable-durable";
  verification: "verified";
  provenance: "provider" | "simulation";
  observedAt: string;
  recordedAt: string;
}
export interface WithdrawalDispatchAuthority {
  actor: FinancialActor;
  access: unknown;
  recentAuth: RecentFinancialAuthenticationEvidence;
  context: WithdrawalReservationContext;
  presentation: WithdrawalVerifiedPresentation;
  holderBinding: OriginalHolderConsentBinding;
}
export type WithdrawalArmResult =
  | {
      outcome: "ARMED";
      original: OriginalWithdrawal;
      fence: DispatchFence;
      dispatchValidUntil: string;
    }
  | { outcome: "EXISTING"; stored: StoredWithdrawalExecution }
  | { outcome: "DENIED" | "UNRESOLVED" };
export type WithdrawalPostingResult =
  | { outcome: "COMPLETED" | "DUPLICATE"; stored: StoredWithdrawalExecution }
  | { outcome: "DENIED" | "UNRESOLVED" };
export interface WithdrawalPostingRepository {
  readExisting(identity: {
    siteId: string;
    requestId: string;
  }): Promise<StoredWithdrawalExecution | null>;
  armExisting(
    attempt: WithdrawalProtectedRequestAttempt,
  ): Promise<WithdrawalArmResult>;
  recordObservation(
    original: OriginalWithdrawal,
    fence: DispatchFence,
    observation: WithdrawalDispatchObservation,
  ): Promise<StoredWithdrawalExecution>;
  postCompleted(
    original: OriginalWithdrawal,
    fence: DispatchFence,
    proofReference: string,
  ): Promise<WithdrawalPostingResult>;
}
export interface WithdrawalDispatchPort {
  dispatch(
    original: OriginalWithdrawal,
    fence: DispatchFence,
  ): Promise<WithdrawalDispatchObservation>;
}
export interface WithdrawalLookupPort {
  lookup(
    original: OriginalWithdrawal,
    fence: DispatchFence,
    providerReference: string | null,
  ): Promise<WithdrawalLookupObservation>;
}
export type WithdrawalExecutionResult =
  | { outcome: "DENIED" | "UNRESOLVED" }
  | {
      outcome: "EXISTING" | "PROCESSING" | "COMPLETED" | "DUPLICATE";
      stored: StoredWithdrawalExecution;
    };
export type WithdrawalExecutionOptions =
  | { mode: "disabled" }
  | {
      mode: "sandbox" | "live";
      applicationEnvironment: "development" | "test" | "production";
      maxAuthAgeMs: number;
      now(): Date;
      repository?: WithdrawalPostingRepository;
      dispatch?: WithdrawalDispatchPort;
      lookup?: WithdrawalLookupPort;
    };
export function withdrawalReference(value: unknown, max = 256): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    !/^[\x21-\x7e]+$/.test(value)
  )
    throw new TypeError("Invalid withdrawal reference");
  return value;
}
export function withdrawalObject(
  value: unknown,
  keys?: string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== "string" ||
        !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"),
    )
  )
    throw new TypeError("Invalid withdrawal object");
  const object = value as Record<string, unknown>;
  if (
    keys &&
    (Object.keys(object).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(object, key)))
  )
    throw new TypeError("Invalid withdrawal fields");
  return object;
}
// Copy data before any asynchronous or reentrant port call. Dates retain SQL precision.
export function captureWithdrawalValue<T>(value: T): T {
  const seen = new Set<object>();
  function copy(input: unknown): unknown {
    if (
      input === null ||
      ["string", "boolean", "number", "undefined"].includes(typeof input)
    )
      return input;
    if (input instanceof Date)
      return Object.freeze(readDatabaseTimestamp(input));
    if (typeof input !== "object" || !input || seen.has(input))
      throw new TypeError("Invalid withdrawal data");
    seen.add(input);
    let output: unknown;
    if (Array.isArray(input)) {
      if (
        Object.getPrototypeOf(input) !== Array.prototype ||
        Reflect.ownKeys(input).length !== input.length + 1
      )
        throw new TypeError("Invalid withdrawal array");
      const values: unknown[] = [];
      for (let index = 0; index < input.length; index++) {
        const item = Object.getOwnPropertyDescriptor(input, String(index));
        if (!item || !item.enumerable || !Object.hasOwn(item, "value"))
          throw new TypeError("Invalid withdrawal array item");
        values.push(copy(item.value));
      }
      output = Object.freeze(values);
    } else
      output = Object.freeze(
        Object.fromEntries(
          Object.entries(withdrawalObject(input)).map(([key, item]) => [
            key,
            copy(item),
          ]),
        ),
      );
    seen.delete(input);
    return output;
  }
  return copy(value) as T;
}
export function withdrawalInstant(value: unknown): string {
  const at = readDatabaseTimestamp(value);
  const micros = databaseTimestampEpochMicroseconds(at);
  if (micros < 0n) throw new TypeError("Invalid withdrawal time");
  return micros % 1000n === 0n
    ? at.toISOString()
    : at
        .toISOString()
        .replace(
          /\.\d{3}Z$/,
          `.${String(micros % 1000000n).padStart(6, "0")}Z`,
        );
}
export function withdrawalCorrelation(
  snapshot: WithdrawalReservationSnapshot,
): WithdrawalCorrelation {
  return Object.freeze({
    siteId: snapshot.intent.siteId,
    requestId: snapshot.requestId,
    requestHash: snapshot.requestHash,
    withdrawalId: snapshot.intent.id,
    operationId: snapshot.operationId,
    accountId: snapshot.accountId,
    accountReference: snapshot.accountReference,
    recipientReference: snapshot.recipientReference,
    bankReference: snapshot.bankReference,
    operatorUserId: snapshot.operatorUserId,
    environment: snapshot.environment,
    destinationVersion: snapshot.intent.destinationVersion,
    amountCents: snapshot.intent.amountCents,
    feeCents: snapshot.intent.feeCents,
    netCents: snapshot.intent.netCents,
    currency: "BRL",
    policyVersion: snapshot.feeQuote.policyVersion,
  });
}
export function captureOriginalHolderBinding(
  value: unknown,
  correlation: WithdrawalCorrelation,
  consentHash: string,
): OriginalHolderConsentBinding {
  const raw = withdrawalObject(captureWithdrawalValue(value), [
    "correlation",
    "consentHash",
    "bindingReference",
    "holderUserId",
    "holderConsentReference",
    "actingUserId",
    "holderRole",
    "provenance",
    "verification",
  ]);
  if (
    !isDeepStrictEqual(raw.correlation, correlation) ||
    raw.consentHash !== consentHash ||
    raw.actingUserId !== correlation.operatorUserId ||
    raw.holderRole !== "BRIDE_HOLDER" ||
    raw.provenance !== "durable" ||
    raw.verification !== "verified"
  )
    throw new TypeError("Original holder custody unavailable");
  for (const key of [
    "bindingReference",
    "holderUserId",
    "holderConsentReference",
    "actingUserId",
  ])
    withdrawalReference(raw[key], 128);
  return raw as unknown as OriginalHolderConsentBinding;
}
export function captureOriginalWithdrawal(value: unknown): OriginalWithdrawal {
  const raw = withdrawalObject(captureWithdrawalValue(value), [
    "snapshot",
    "consent",
    "associationId",
    "correlation",
    "holderBinding",
  ]);
  const snapshot = readWithdrawalReservationSnapshot(raw.snapshot);
  const consent = readWithdrawalConsentRecord(raw.consent);
  const correlation = withdrawalCorrelation(snapshot);
  if (
    consent.state !== "COMMITTED" ||
    !sameWithdrawalConsentTerms(
      consent.snapshot,
      snapshot,
      consent.snapshot.presentation,
    ) ||
    !isDeepStrictEqual(consent.snapshot.feeQuote, snapshot.feeQuote) ||
    !isDeepStrictEqual(raw.correlation, correlation)
  )
    throw new TypeError("Invalid original withdrawal consent");
  return Object.freeze({
    snapshot,
    consent,
    associationId: withdrawalReference(raw.associationId, 128),
    correlation,
    holderBinding: captureOriginalHolderBinding(
      raw.holderBinding,
      correlation,
      consent.previewHash,
    ),
  });
}
export function captureDispatchFence(
  value: unknown,
  original: OriginalWithdrawal,
): DispatchFence {
  const raw = withdrawalObject(captureWithdrawalValue(value), [
    "operationId",
    "attempts",
    "leaseOwner",
    "leaseToken",
    "leaseExpiresAt",
  ]);
  if (
    raw.operationId !== original.correlation.operationId ||
    raw.attempts !== 1
  )
    throw new TypeError("Invalid original dispatch fence");
  return Object.freeze({
    operationId: original.correlation.operationId,
    attempts: 1,
    leaseOwner: withdrawalReference(raw.leaseOwner, 128),
    leaseToken: withdrawalReference(raw.leaseToken, 128),
    leaseExpiresAt: withdrawalInstant(raw.leaseExpiresAt),
  });
}
export function captureWithdrawalObservation(
  value: unknown,
  original: OriginalWithdrawal,
  fence: DispatchFence,
  now: unknown,
): WithdrawalDispatchObservation {
  const raw = withdrawalObject(captureWithdrawalValue(value));
  const keys = ["outcome", "correlation", "holderBinding", "fence"];
  if (raw.outcome === "ACCEPTED")
    keys.push("providerReference", "observedAt", "proofReference");
  else if (raw.outcome === "REJECTED") keys.push("reason");
  else if (raw.outcome !== "UNRESOLVED")
    throw new TypeError("Unsupported withdrawal observation");
  withdrawalObject(raw, keys);
  if (
    !isDeepStrictEqual(raw.correlation, original.correlation) ||
    !isDeepStrictEqual(
      captureOriginalHolderBinding(
        raw.holderBinding,
        original.correlation,
        original.consent.previewHash,
      ),
      original.holderBinding,
    ) ||
    !isDeepStrictEqual(captureDispatchFence(raw.fence, original), fence)
  )
    throw new TypeError("Foreign withdrawal observation");
  if (raw.outcome === "ACCEPTED") {
    const observedAt = withdrawalInstant(raw.observedAt);
    const observed = databaseTimestampEpochMicroseconds(observedAt);
    if (
      observed <
        databaseTimestampEpochMicroseconds(
          original.snapshot.intent.createdAt,
        ) ||
      observed > databaseTimestampEpochMicroseconds(now)
    )
      throw new TypeError("Invalid withdrawal observation time");
    return Object.freeze({
      outcome: "ACCEPTED",
      correlation: original.correlation,
      holderBinding: original.holderBinding,
      fence,
      providerReference: withdrawalReference(raw.providerReference),
      observedAt,
      proofReference:
        raw.proofReference === null
          ? null
          : withdrawalReference(raw.proofReference),
    });
  }
  if (raw.outcome === "REJECTED") {
    if (typeof raw.reason !== "string" || !/^[A-Z0-9_]{1,64}$/.test(raw.reason))
      throw new TypeError("Invalid withdrawal rejection reason");
    return Object.freeze({
      outcome: "REJECTED",
      correlation: original.correlation,
      holderBinding: original.holderBinding,
      fence,
      reason: raw.reason,
    });
  }
  return Object.freeze({
    outcome: "UNRESOLVED",
    correlation: original.correlation,
    holderBinding: original.holderBinding,
    fence,
  });
}
const NativeWithdrawalPromise = Promise;
const nativeWithdrawalThen = Promise.prototype.then;
const nativeWithdrawalSpeciesGetter = Object.getOwnPropertyDescriptor(
  Promise,
  Symbol.species,
)?.get;
const isNativeWithdrawalPromise = types.isPromise;

export function genuineWithdrawalPromise<T>(value: Promise<T>): Promise<T> {
  if (!isNativeWithdrawalPromise(value))
    throw new TypeError("Native withdrawal promise required");
  return new NativeWithdrawalPromise<T>((resolve, reject) => {
    try {
      if (Object.getPrototypeOf(value) !== NativeWithdrawalPromise.prototype)
        return;
      const constructorDescriptor =
        Object.getOwnPropertyDescriptor(value, "constructor") ??
        Object.getOwnPropertyDescriptor(
          NativeWithdrawalPromise.prototype,
          "constructor",
        );
      if (
        !constructorDescriptor ||
        !Object.hasOwn(constructorDescriptor, "value")
      )
        return;
      if (constructorDescriptor.value !== undefined) {
        const target = constructorDescriptor.value;
        if (
          (typeof target !== "object" && typeof target !== "function") ||
          target === null
        )
          return;
        const species = Object.getOwnPropertyDescriptor(target, Symbol.species);
        if (!species) return;
        if (Object.hasOwn(species, "value")) {
          if (
            species.value !== undefined &&
            species.value !== null &&
            species.value !== NativeWithdrawalPromise
          )
            return;
        } else if (
          target !== NativeWithdrawalPromise ||
          species.get !== nativeWithdrawalSpeciesGetter
        )
          return;
      }
      // Awaiting the original invokes its constructor getter. Observe settlement
      // through the captured intrinsic and expose only this undecorated promise.
      Reflect.apply(nativeWithdrawalThen, value, [resolve, reject]);
    } catch {
      // Unsafe metadata cannot certify settlement. Retain ownership indefinitely.
    }
  });
}
export function captureWithdrawalCallable<T extends (...args: any[]) => any>(
  target: unknown,
  key: string,
  receiverSnapshot: boolean,
): T {
  if (!target || typeof target !== "object")
    throw new TypeError("Withdrawal port unavailable");
  let owner: object | null = target;
  let descriptor: PropertyDescriptor | undefined;
  while (owner && !descriptor) {
    descriptor = Object.getOwnPropertyDescriptor(owner, key);
    owner = Object.getPrototypeOf(owner);
  }
  if (
    !descriptor ||
    !Object.hasOwn(descriptor, "value") ||
    typeof descriptor.value !== "function"
  )
    throw new TypeError("Withdrawal callable unavailable");
  let receiver = target;
  if (receiverSnapshot) {
    const fields = withdrawalObject(target);
    receiver = Object.freeze(
      Object.fromEntries(
        Object.entries(fields).map(([name, value]) => [
          name,
          typeof value === "function" ? value : captureWithdrawalValue(value),
        ]),
      ),
    );
  }
  return descriptor.value.bind(receiver) as T;
}
function captureAttempt(
  value: WithdrawalProtectedRequestAttempt,
): WithdrawalProtectedRequestAttempt {
  const attempt = captureWithdrawalValue(value);
  const actor = withdrawalObject(attempt.actor, [
    "siteId",
    "userId",
    "sessionId",
  ]);
  for (const key of ["siteId", "userId", "sessionId"])
    withdrawalReference(actor[key], 128);
  withdrawalReference(attempt.requestId, 128);
  return attempt;
}
function proofFresh(
  attempt: WithdrawalProtectedRequestAttempt,
  now: Date,
  maxAge: number,
) {
  const proof = attempt.recentAuth;
  const actor = attempt.actor;
  if (
    !actor ||
    !proof ||
    proof.userId !== actor.userId ||
    proof.siteId !== actor.siteId ||
    proof.sessionId !== actor.sessionId ||
    proof.provenance !== "backend" ||
    proof.verification !== "verified" ||
    !["PASSWORD_REAUTHENTICATION", "MFA_REAUTHENTICATION"].includes(
      proof.proofKind,
    )
  )
    throw new TypeError("Withdrawal authentication unavailable");
  const at = databaseTimestampEpochMicroseconds(now);
  const start = databaseTimestampEpochMicroseconds(proof.authenticatedAt);
  const end = databaseTimestampEpochMicroseconds(proof.expiresAt);
  if (
    start > at ||
    end <= at ||
    at - start > BigInt(maxAge) * 1000n ||
    end - start > BigInt(maxAge) * 1000n
  )
    throw new TypeError("Withdrawal authentication expired");
}
export function createWithdrawalExecutionService(
  options: WithdrawalExecutionOptions,
) {
  let configured: {
    mode: "sandbox" | "live";
    maxAge: number;
    now: () => Date;
    arm: WithdrawalPostingRepository["armExisting"];
    read: WithdrawalPostingRepository["readExisting"];
    record: WithdrawalPostingRepository["recordObservation"];
    post: WithdrawalPostingRepository["postCompleted"];
    dispatch: WithdrawalDispatchPort["dispatch"];
    lookup: WithdrawalLookupPort["lookup"];
  } | null = null;
  try {
    const fields = Object.getOwnPropertyDescriptors(options);
    if (Object.values(fields).some((field) => !Object.hasOwn(field, "value")))
      throw new TypeError("Accessor withdrawal configuration denied");
    const mode: unknown = fields.mode?.value;
    const applicationEnvironment: unknown =
      fields.applicationEnvironment?.value;
    const maxAuthAgeMs: unknown = fields.maxAuthAgeMs?.value;
    if (
      ((mode === "live" && applicationEnvironment === "production") ||
        (mode === "sandbox" &&
          (applicationEnvironment === "development" ||
            applicationEnvironment === "test"))) &&
      typeof maxAuthAgeMs === "number" &&
      Number.isSafeInteger(maxAuthAgeMs) &&
      maxAuthAgeMs > 0
    ) {
      const repository = fields.repository?.value;
      configured = {
        mode,
        maxAge: maxAuthAgeMs,
        now: captureWithdrawalCallable(options, "now", false),
        arm: captureWithdrawalCallable(repository, "armExisting", false),
        read: captureWithdrawalCallable(repository, "readExisting", false),
        record: captureWithdrawalCallable(
          repository,
          "recordObservation",
          false,
        ),
        post: captureWithdrawalCallable(repository, "postCompleted", false),
        dispatch: captureWithdrawalCallable(
          fields.dispatch?.value,
          "dispatch",
          true,
        ),
        lookup: captureWithdrawalCallable(fields.lookup?.value, "lookup", true),
      };
    }
  } catch {
    configured = null;
  }
  const c = configured;
  function clock(): Date {
    const at = c!.now();
    if (!(at instanceof Date) || databaseTimestampEpochMicroseconds(at) < 0n)
      throw new TypeError("Withdrawal clock unavailable");
    return readDatabaseTimestamp(at);
  }
  async function uncertain(
    original: OriginalWithdrawal,
    fence: DispatchFence,
  ): Promise<WithdrawalExecutionResult> {
    try {
      await genuineWithdrawalPromise(
        c!.record(original, fence, {
          outcome: "UNRESOLVED",
          correlation: original.correlation,
          holderBinding: original.holderBinding,
          fence,
        }),
      );
    } catch {
      /* An unacknowledged observation never permits another dispatch. */
    }
    return { outcome: "UNRESOLVED" };
  }
  async function observe(
    original: OriginalWithdrawal,
    fence: DispatchFence,
    raw: unknown,
  ): Promise<WithdrawalExecutionResult> {
    let observation: WithdrawalDispatchObservation;
    try {
      observation = captureWithdrawalObservation(raw, original, fence, clock());
    } catch {
      return uncertain(original, fence);
    }
    try {
      const stored = await genuineWithdrawalPromise(
        c!.record(original, fence, observation),
      );
      if (stored.state === "COMPLETED") return { outcome: "COMPLETED", stored };
      if (observation.outcome !== "ACCEPTED") return { outcome: "UNRESOLVED" };
      if (observation.proofReference !== null)
        return await genuineWithdrawalPromise(
          c!.post(original, fence, observation.proofReference),
        );
      return { outcome: "PROCESSING", stored };
    } catch {
      return { outcome: "UNRESOLVED" };
    }
  }
  return {
    async executeExisting(
      input: WithdrawalProtectedRequestAttempt,
    ): Promise<WithdrawalExecutionResult> {
      if (!c) return { outcome: "DENIED" };
      let attempt: WithdrawalProtectedRequestAttempt;
      let armed: WithdrawalArmResult;
      try {
        attempt = captureAttempt(input);
        proofFresh(attempt, clock(), c.maxAge);
        armed = await genuineWithdrawalPromise(
          c.arm(captureWithdrawalValue(attempt)),
        );
      } catch {
        return { outcome: "DENIED" };
      }
      if (armed.outcome !== "ARMED")
        return armed.outcome === "EXISTING"
          ? { outcome: "EXISTING", stored: armed.stored }
          : { outcome: armed.outcome };
      let original: OriginalWithdrawal;
      let fence: DispatchFence;
      try {
        original = captureOriginalWithdrawal(armed.original);
        fence = captureDispatchFence(armed.fence, original);
      } catch {
        return { outcome: "UNRESOLVED" };
      }
      try {
        const at = clock();
        proofFresh(attempt, at, c.maxAge);
        if (
          original.correlation.environment !== c.mode ||
          original.correlation.siteId !== attempt.actor!.siteId ||
          original.correlation.requestId !== attempt.requestId ||
          original.correlation.operatorUserId !== attempt.actor!.userId ||
          databaseTimestampEpochMicroseconds(at) >=
            databaseTimestampEpochMicroseconds(armed.dispatchValidUntil) ||
          databaseTimestampEpochMicroseconds(at) >=
            databaseTimestampEpochMicroseconds(fence.leaseExpiresAt) ||
          databaseTimestampEpochMicroseconds(at) >=
            databaseTimestampEpochMicroseconds(
              original.consent.snapshot.preview.expiresAt,
            )
        )
          throw new TypeError("Dispatch authority expired or foreign");
        return await observe(
          original,
          fence,
          await genuineWithdrawalPromise(c.dispatch(original, fence)),
        );
      } catch {
        return uncertain(original, fence);
      }
    },
    async reconcileExisting(input: {
      siteId: string;
      requestId: string;
    }): Promise<WithdrawalExecutionResult> {
      if (!c) return { outcome: "DENIED" };
      let stored: StoredWithdrawalExecution | null;
      let original: OriginalWithdrawal;
      let fence: DispatchFence;
      try {
        const identity = withdrawalObject(captureWithdrawalValue(input), [
          "siteId",
          "requestId",
        ]);
        withdrawalReference(identity.siteId, 128);
        withdrawalReference(identity.requestId, 128);
        stored = await genuineWithdrawalPromise(
          c.read(identity as unknown as { siteId: string; requestId: string }),
        );
        if (!stored) return { outcome: "DENIED" };
        original = captureOriginalWithdrawal(stored.original);
        if (
          original.correlation.siteId !== identity.siteId ||
          original.correlation.requestId !== identity.requestId ||
          original.correlation.environment !== c.mode
        )
          return { outcome: "DENIED" };
        if (
          stored.state === "COMPLETED" &&
          stored.fence &&
          stored.receiptReference
        )
          return await genuineWithdrawalPromise(
            c.post(
              original,
              captureDispatchFence(stored.fence, original),
              withdrawalReference(stored.receiptReference),
            ),
          );
        if (!stored.fence) return { outcome: "EXISTING", stored };
        fence = captureDispatchFence(stored.fence, original);
      } catch {
        return { outcome: "UNRESOLVED" };
      }
      try {
        const found = withdrawalObject(
          captureWithdrawalValue(
            await genuineWithdrawalPromise(
              c.lookup(original, fence, stored.providerReference),
            ),
          ),
        );
        if (found.outcome === "FOUND") {
          withdrawalObject(found, ["outcome", "observation"]);
          return await observe(original, fence, found.observation);
        }
        withdrawalObject(found, ["outcome"]);
        return uncertain(original, fence);
      } catch {
        return uncertain(original, fence);
      }
    },
  };
}
