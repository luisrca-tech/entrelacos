import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { withdrawalPreviewSchema } from "@entrelacos/contracts";
import {
  databaseTimestampEpochMicroseconds,
  readDatabaseTimestamp,
} from "./databaseTimestamp";

export interface ReceivingVerificationScope {
  readonly provider: "ASAAS";
  readonly siteId: string;
  readonly accountId: string;
  readonly operatorUserId: string;
  readonly environment: "sandbox" | "live";
  readonly operatorReference: string | null;
  readonly accountReference: string;
  readonly recipientReference: string;
}
export interface ReceivingVerificationAccountObservation {
  readonly sourceId: string;
  readonly sourceOrder: string;
  readonly state:
    | "UNVERIFIED"
    | "ONBOARDING"
    | "UNDER_REVIEW"
    | "APPROVED"
    | "BLOCKED"
    | "SUSPENDED";
  readonly observedAt: string;
  readonly receiving: boolean;
  readonly withdrawal: boolean;
  readonly commercial: boolean;
}
export interface ReceivingVerificationBankObservation {
  readonly sourceId: string | null;
  readonly sourceOrder: string | null;
  readonly state: "UNVERIFIED" | "PENDING" | "VERIFIED" | "REJECTED";
  readonly observedAt: string | null;
}
export interface ReceivingVerificationObservation {
  readonly kind: "OBSERVATION";
  readonly profile: "rv1";
  readonly verifiable: true;
  readonly scope: ReceivingVerificationScope;
  readonly destination: {
    readonly id: string;
    readonly version: number;
    readonly bankReference: string;
  };
  readonly account: ReceivingVerificationAccountObservation;
  readonly bank: ReceivingVerificationBankObservation;
}
export interface PreparedReceivingVerificationObservation
  extends ReceivingVerificationObservation {
  readonly evidenceId: string;
  readonly verificationReference: string;
}
export interface ReceivingVerificationCandidate {
  readonly kind: "DESTINATION";
  readonly profile: "rv1";
  readonly verifiable: true;
  readonly scope: ReceivingVerificationScope;
  readonly bankReference: string;
  readonly maskedDescriptor: string | null;
  readonly mappingReference: string;
}
export interface ReceivingVerificationFence {
  readonly scope: ReceivingVerificationScope;
  readonly account: Readonly<Record<string, unknown>>;
  readonly operation: Readonly<Record<string, unknown>>;
  readonly destinations: readonly Readonly<Record<string, unknown>>[];
  readonly evidence: readonly Readonly<Record<string, unknown>>[];
}
export type ReceivingVerificationAuthorization =
  import("./receivingNomination").ReceivingNominationCurrentAuthorization;
export interface ReceivingVerificationRepository {
  captureSelection(
    scope: ReceivingVerificationScope,
    authorization: ReceivingVerificationAuthorization,
  ): Promise<ReceivingVerificationFence>;
  selectDestination(
    fence: ReceivingVerificationFence,
    selectionId: string,
    candidate: ReceivingVerificationCandidate,
    authorization: ReceivingVerificationAuthorization,
  ): Promise<void>;
  captureObservation(
    scope: ReceivingVerificationScope,
  ): Promise<ReceivingVerificationFence>;
  appendObservation(
    fence: ReceivingVerificationFence,
    observation: PreparedReceivingVerificationObservation,
  ): Promise<void>;
  consultSelection(
    fence: ReceivingVerificationFence,
    selectionId: string,
    candidate: ReceivingVerificationCandidate,
  ): Promise<boolean>;
  consultObservation(
    observation: PreparedReceivingVerificationObservation,
  ): Promise<boolean>;
}
export interface ReceivingVerificationNativeOwner {
  readonly result: Promise<
    ReceivingVerificationCandidate | ReceivingVerificationObservation
  >;
  readonly completion: Promise<void>;
  cancel(): void;
}
export interface ReceivingVerificationObserver {
  readonly profile: "rv1";
  // Retrieves authenticated candidate/evidence facts only; never changes a bank or provider account.
  acquire(
    kind: "SELECT" | "OBSERVE",
    fence: ReceivingVerificationFence,
    signal: AbortSignal,
  ): ReceivingVerificationNativeOwner;
  close(): Promise<void>;
}
export interface ReceivingVerificationOptions {
  readonly profile: "rv1";
  readonly readObserverPolicy: (
    scope: ReceivingVerificationScope,
    action: "SELECT" | "OBSERVE",
  ) => Promise<boolean>;
  readonly observer: ReceivingVerificationObserver;
  readonly repository: ReceivingVerificationRepository;
  readonly now: () => Date;
}
export type ReceivingVerificationCommand =
  | {
      action: "SELECT";
      scope: ReceivingVerificationScope;
      selectionId: string;
      authorization: ReceivingVerificationAuthorization;
      confirmDestinationSelection: true;
    }
  | { action: "OBSERVE"; scope: ReceivingVerificationScope };
export interface ReceivingVerificationFeedback {
  state: "UNAVAILABLE" | "UNKNOWN" | "STORED";
  siteId?: string;
  resultId?: string;
}
export interface ReceivingVerificationOwner {
  readonly feedback: Promise<ReceivingVerificationFeedback>;
  readonly completion: Promise<void>;
  cancel(): void;
}
export interface ReceivingVerificationService {
  readonly available: boolean;
  begin(command: ReceivingVerificationCommand): ReceivingVerificationOwner;
  close(): Promise<void>;
}

export function verificationIdentifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  )
    return unavailable();
  return value;
}
export function verificationTimestamp(value: unknown): string {
  const microseconds =
    typeof value === "bigint"
      ? value
      : databaseTimestampEpochMicroseconds(readDatabaseTimestamp(value));
  if (microseconds < 0n) return unavailable();
  const date = new Date(Number(microseconds / 1000n));
  if (!Number.isSafeInteger(date.getTime()) || date.getUTCFullYear() > 9999)
    return unavailable();
  return `${date.toISOString().slice(0, 19)}.${(microseconds % 1000000n).toString().padStart(6, "0")}Z`;
}
export function readReceivingVerificationScope(
  value: unknown,
): ReceivingVerificationScope {
  const data = receivingVerificationData(value, [
    "provider",
    "siteId",
    "accountId",
    "operatorUserId",
    "environment",
    "operatorReference",
    "accountReference",
    "recipientReference",
  ]);
  if (
    data.provider !== "ASAAS" ||
    (data.environment !== "sandbox" && data.environment !== "live")
  )
    return unavailable();
  return Object.freeze({
    provider: "ASAAS",
    siteId: verificationIdentifier(data.siteId),
    accountId: verificationIdentifier(data.accountId),
    operatorUserId: verificationIdentifier(data.operatorUserId),
    environment: data.environment,
    operatorReference:
      data.operatorReference === null
        ? null
        : verificationIdentifier(data.operatorReference),
    accountReference: verificationIdentifier(data.accountReference),
    recipientReference: verificationIdentifier(data.recipientReference),
  });
}
export function readReceivingVerificationCandidate(
  value: unknown,
): ReceivingVerificationCandidate {
  const data = receivingVerificationData(value, [
    "kind",
    "profile",
    "verifiable",
    "scope",
    "bankReference",
    "maskedDescriptor",
    "mappingReference",
  ]);
  if (
    data.kind !== "DESTINATION" ||
    data.profile !== "rv1" ||
    data.verifiable !== true
  )
    return unavailable();
  const scope = readReceivingVerificationScope(data.scope);
  if (scope.operatorReference === null) return unavailable();
  const mask = data.maskedDescriptor;
  if (
    mask !== null &&
    !withdrawalPreviewSchema.shape.maskedDestination.safeParse(mask).success
  )
    return unavailable();
  return Object.freeze({
    kind: "DESTINATION",
    profile: "rv1",
    verifiable: true,
    scope,
    bankReference: verificationIdentifier(data.bankReference),
    maskedDescriptor: mask as string | null,
    mappingReference: sourceId(data.mappingReference),
  });
}
export function prepareReceivingVerificationObservation(
  value: ReceivingVerificationObservation,
): PreparedReceivingVerificationObservation {
  try {
    const data = receivingVerificationData(value, [
      "kind",
      "profile",
      "verifiable",
      "scope",
      "destination",
      "account",
      "bank",
    ]);
    if (
      data.kind !== "OBSERVATION" ||
      data.profile !== "rv1" ||
      data.verifiable !== true
    )
      return unavailable();
    const scope = readReceivingVerificationScope(data.scope);
    if (scope.operatorReference === null) return unavailable();
    const destinationData = receivingVerificationData(data.destination, [
      "id",
      "version",
      "bankReference",
    ]);
    if (
      !Number.isSafeInteger(destinationData.version) ||
      Number(destinationData.version) <= 0 ||
      Number(destinationData.version) > 2147483647
    )
      return unavailable();
    const destination = Object.freeze({
      id: verificationIdentifier(destinationData.id),
      version: Number(destinationData.version),
      bankReference: verificationIdentifier(destinationData.bankReference),
    });
    const accountData = receivingVerificationData(data.account, [
      "sourceId",
      "sourceOrder",
      "state",
      "observedAt",
      "receiving",
      "withdrawal",
      "commercial",
    ]);
    if (
      ![
        "UNVERIFIED",
        "ONBOARDING",
        "UNDER_REVIEW",
        "APPROVED",
        "BLOCKED",
        "SUSPENDED",
      ].includes(accountData.state as string) ||
      [
        accountData.receiving,
        accountData.withdrawal,
        accountData.commercial,
      ].some((value) => typeof value !== "boolean")
    )
      return unavailable();
    const account: ReceivingVerificationAccountObservation = Object.freeze({
      sourceId: sourceId(accountData.sourceId),
      sourceOrder: sourceOrder(accountData.sourceOrder),
      state:
        accountData.state as ReceivingVerificationAccountObservation["state"],
      observedAt: verificationTimestamp(accountData.observedAt),
      receiving: accountData.receiving as boolean,
      withdrawal: accountData.withdrawal as boolean,
      commercial: accountData.commercial as boolean,
    });
    const bankData = receivingVerificationData(data.bank, [
      "sourceId",
      "sourceOrder",
      "state",
      "observedAt",
    ]);
    if (
      !["UNVERIFIED", "PENDING", "VERIFIED", "REJECTED"].includes(
        bankData.state as string,
      )
    )
      return unavailable();
    const identity = receipt({
      accountSourceId: account.sourceId,
      accountSourceOrder: account.sourceOrder,
      bankSourceId: bankData.sourceId,
      bankSourceOrder: bankData.sourceOrder,
    });
    const bank: ReceivingVerificationBankObservation = Object.freeze({
      sourceId: identity.bankSourceId,
      sourceOrder: identity.bankSourceOrder,
      state: bankData.state as ReceivingVerificationBankObservation["state"],
      observedAt:
        bankData.observedAt === null
          ? null
          : verificationTimestamp(bankData.observedAt),
    });
    if (
      (bank.sourceId === null &&
        (bank.observedAt !== null ||
          !["UNVERIFIED", "PENDING"].includes(bank.state))) ||
      (bank.sourceId !== null && bank.observedAt === null)
    )
      return unavailable();
    const evidenceId =
      "re1_" +
      createHash("sha256")
        .update(
          JSON.stringify([
            "entrelacos.receiving-verification.observation.v1",
            "rv1",
            "ASAAS",
            scope.siteId,
            scope.accountId,
            scope.operatorUserId,
            scope.environment,
            scope.operatorReference,
            scope.accountReference,
            scope.recipientReference,
            destination.id,
            destination.version,
            destination.bankReference,
            account.sourceId,
            bank.sourceId,
          ]),
        )
        .digest("hex");
    return Object.freeze({
      kind: "OBSERVATION",
      profile: "rv1",
      verifiable: true,
      scope,
      destination,
      account,
      bank,
      evidenceId,
      verificationReference: encodeReceivingVerificationReceipt(identity),
    });
  } catch {
    return unavailable();
  }
}
function capturedAuthorization(
  value: unknown,
  scope: ReceivingVerificationScope,
): ReceivingVerificationAuthorization {
  const data = receivingVerificationData(value, ["actor", "recentAuth"]);
  const actorData = receivingVerificationData(data.actor, [
    "userId",
    "siteId",
    "sessionId",
  ]);
  const proofData = receivingVerificationData(data.recentAuth, [
    "userId",
    "siteId",
    "sessionId",
    "proofKind",
    "provenance",
    "verification",
    "authenticatedAt",
    "expiresAt",
  ]);
  const actor = Object.freeze({
    userId: verificationIdentifier(actorData.userId),
    siteId: verificationIdentifier(actorData.siteId),
    sessionId: verificationIdentifier(actorData.sessionId),
  });
  if (
    actor.userId !== scope.operatorUserId ||
    actor.siteId !== scope.siteId ||
    proofData.userId !== actor.userId ||
    proofData.siteId !== actor.siteId ||
    proofData.sessionId !== actor.sessionId ||
    proofData.provenance !== "backend" ||
    proofData.verification !== "verified" ||
    (proofData.proofKind !== "PASSWORD_REAUTHENTICATION" &&
      proofData.proofKind !== "MFA_REAUTHENTICATION")
  )
    return unavailable();
  return Object.freeze({
    actor,
    recentAuth: Object.freeze({
      ...actor,
      proofKind: proofData.proofKind,
      provenance: "backend",
      verification: "verified",
      authenticatedAt: readDatabaseTimestamp(proofData.authenticatedAt),
      expiresAt: readDatabaseTimestamp(proofData.expiresAt),
    }),
  });
}
function sameScope(
  actual: ReceivingVerificationScope,
  original: ReceivingVerificationScope,
  initial = false,
): boolean {
  return isDeepStrictEqual(actual, {
    ...original,
    operatorReference:
      initial && original.operatorReference === null
        ? actual.operatorReference
        : original.operatorReference,
  });
}
export function createReceivingVerification(
  options?: ReceivingVerificationOptions,
): ReceivingVerificationService {
  const closed = Promise.resolve();
  const inactive = (): ReceivingVerificationService =>
    Object.freeze({
      available: false,
      begin: () =>
        Object.freeze({
          feedback: Promise.resolve({ state: "UNAVAILABLE" as const }),
          completion: closed,
          cancel: () => {},
        }),
      close: () => closed,
    });
  let repository: ReceivingVerificationRepository;
  let observer: ReceivingVerificationObserver;
  let policy: ReceivingVerificationOptions["readObserverPolicy"];
  let now: () => Date;
  try {
    if (options?.profile !== "rv1") return inactive();
    const readPolicy = options.readObserverPolicy;
    if (typeof readPolicy !== "function") return inactive();
    const native = options.observer;
    if (native?.profile !== "rv1") return inactive();
    const acquire = native.acquire,
      close = native.close;
    if (typeof acquire !== "function" || typeof close !== "function")
      return inactive();
    const source = options.repository;
    const clock = options.now;
    if (!source || typeof clock !== "function") return inactive();
    const names = [
      "captureSelection",
      "selectDestination",
      "captureObservation",
      "appendObservation",
      "consultSelection",
      "consultObservation",
    ] as const;
    const methods = {
      captureSelection: source.captureSelection,
      selectDestination: source.selectDestination,
      captureObservation: source.captureObservation,
      appendObservation: source.appendObservation,
      consultSelection: source.consultSelection,
      consultObservation: source.consultObservation,
    };
    if (names.some((name) => typeof methods[name] !== "function"))
      return inactive();
    repository = Object.freeze({
      captureSelection: methods.captureSelection.bind(source),
      selectDestination: methods.selectDestination.bind(source),
      captureObservation: methods.captureObservation.bind(source),
      appendObservation: methods.appendObservation.bind(source),
      consultSelection: methods.consultSelection.bind(source),
      consultObservation: methods.consultObservation.bind(source),
    });
    observer = Object.freeze({
      profile: "rv1",
      acquire: acquire.bind(native),
      close: close.bind(native),
    });
    policy = readPolicy.bind(options);
    now = clock.bind(options);
  } catch {
    return inactive();
  }
  let closing: Promise<void> | undefined;
  const owned = new Set<{ completion: Promise<void>; cancel: () => void }>();
  return Object.freeze<ReceivingVerificationService>({
    available: true,
    begin(command) {
      if (closing) return inactive().begin(command);
      let resolve!: (value: ReceivingVerificationFeedback) => void;
      const feedback = new Promise<ReceivingVerificationFeedback>((yes) => {
        resolve = yes;
      });
      const abort = new AbortController();
      let native: ReceivingVerificationNativeOwner | undefined;
      let nativeCompletion: Promise<void> | undefined;
      let mutation = false;
      let scope: ReceivingVerificationScope | undefined;
      let resultId: string | undefined;
      let settle!: () => void;
      const report = (state: ReceivingVerificationFeedback["state"]) =>
        resolve({
          state,
          ...(scope ? { siteId: scope.siteId } : {}),
          ...(resultId ? { resultId } : {}),
        });
      const cancel = () => {
        abort.abort();
        try {
          native?.cancel();
        } catch {}
        report(mutation ? "UNKNOWN" : "UNAVAILABLE");
      };
      const entry = {
        completion: new Promise<void>((yes) => {
          settle = yes;
        }),
        cancel,
      };
      owned.add(entry);
      const timer = setTimeout(cancel, 45000);
      let lastTime = -1n;
      const current = () => {
        if (closing || abort.signal.aborted) return unavailable();
        const at = databaseTimestampEpochMicroseconds(now());
        if (at < lastTime) return unavailable();
        lastTime = at;
      };
      void (async () => {
        try {
          current();
          const data = receivingVerificationData(command);
          const action = data.action;
          if (action !== "SELECT" && action !== "OBSERVE") return unavailable();
          receivingVerificationData(
            command,
            action === "SELECT"
              ? [
                  "action",
                  "scope",
                  "selectionId",
                  "authorization",
                  "confirmDestinationSelection",
                ]
              : ["action", "scope"],
          );
          scope = readReceivingVerificationScope(data.scope);
          const selectionId =
            action === "SELECT"
              ? verificationIdentifier(data.selectionId)
              : undefined;
          const authorization =
            action === "SELECT"
              ? capturedAuthorization(data.authorization, scope)
              : undefined;
          if (action === "SELECT" && data.confirmDestinationSelection !== true)
            return unavailable();
          if (action === "OBSERVE" && scope.operatorReference === null)
            return unavailable();
          if ((await policy(scope, action)) !== true) return unavailable();
          current();
          const fence =
            action === "SELECT" && authorization
              ? await repository.captureSelection(scope, authorization)
              : await repository.captureObservation(scope);
          current();
          if (!sameScope(fence.scope, scope)) return unavailable();
          native = observer.acquire(action, fence, abort.signal);
          nativeCompletion = native.completion;
          void nativeCompletion.catch(() => {});
          const original = await native.result;
          const capturedCandidate =
            action === "SELECT"
              ? readReceivingVerificationCandidate(original)
              : null;
          const capturedObservation =
            action === "OBSERVE"
              ? prepareReceivingVerificationObservation(
                  original as ReceivingVerificationObservation,
                )
              : null;
          await nativeCompletion;
          current();
          if (action === "SELECT" && authorization && selectionId) {
            const candidate = capturedCandidate;
            if (!candidate) return unavailable();
            if (!sameScope(candidate.scope, scope, true)) return unavailable();
            resultId = selectionId;
            mutation = true;
            try {
              await repository.selectDestination(
                fence,
                selectionId,
                candidate,
                authorization,
              );
            } catch {}
            if (
              !(await repository.consultSelection(
                fence,
                selectionId,
                candidate,
              ))
            )
              return unavailable();
          } else {
            const prepared = capturedObservation;
            if (!prepared) return unavailable();
            const currentDestination = fence.destinations.find(
              (row) => row.is_current === true,
            );
            if (
              !sameScope(prepared.scope, scope) ||
              !currentDestination ||
              currentDestination.id !== prepared.destination.id ||
              currentDestination.version !== prepared.destination.version ||
              currentDestination.bank_reference !==
                prepared.destination.bankReference
            )
              return unavailable();
            resultId = prepared.evidenceId;
            mutation = true;
            try {
              await repository.appendObservation(fence, prepared);
            } catch {}
            if (!(await repository.consultObservation(prepared)))
              return unavailable();
          }
          report("STORED");
        } catch {
          report(mutation ? "UNKNOWN" : "UNAVAILABLE");
        } finally {
          if (nativeCompletion) await nativeCompletion.catch(() => {});
          clearTimeout(timer);
          owned.delete(entry);
          settle();
        }
      })();
      return Object.freeze({ feedback, completion: entry.completion, cancel });
    },
    close() {
      if (closing) return closing;
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      closing = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      for (const entry of owned) entry.cancel();
      void Promise.allSettled([...owned].map((entry) => entry.completion)).then(
        async () => {
          try {
            await observer.close();
            resolve();
          } catch {
            reject(new ReceivingVerificationError());
          }
        },
      );
      return closing;
    },
  });
}

export interface ReceivingVerificationReceipt {
  readonly accountSourceId: string;
  readonly accountSourceOrder: string;
  readonly bankSourceId: string | null;
  readonly bankSourceOrder: string | null;
}
export class ReceivingVerificationError extends Error {
  readonly status = 503;
  readonly code = "RECEIVING_VERIFICATION_UNAVAILABLE";
  constructor() {
    super("Receiving verification unavailable");
  }
}
function unavailable(): never {
  throw new ReceivingVerificationError();
}
export function receivingVerificationData(
  value: unknown,
  fields?: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return unavailable();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype)
    return unavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (
    fields &&
    (names.length !== fields.length ||
      names.some((name) => typeof name !== "string" || !fields.includes(name)))
  )
    return unavailable();
  const result: Record<string, unknown> = {};
  for (const name of names) {
    if (typeof name !== "string" || !("value" in descriptors[name]))
      return unavailable();
    result[name] = descriptors[name].value;
  }
  return result;
}
function sourceId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)
  )
    return unavailable();
  return value;
}
function sourceOrder(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(value) ||
    BigInt(value) > 18446744073709551615n
  )
    return unavailable();
  return value;
}
function receipt(value: unknown): ReceivingVerificationReceipt {
  const data = receivingVerificationData(value, [
    "accountSourceId",
    "accountSourceOrder",
    "bankSourceId",
    "bankSourceOrder",
  ]);
  if ((data.bankSourceId === null) !== (data.bankSourceOrder === null))
    return unavailable();
  return Object.freeze({
    accountSourceId: sourceId(data.accountSourceId),
    accountSourceOrder: sourceOrder(data.accountSourceOrder),
    bankSourceId:
      data.bankSourceId === null ? null : sourceId(data.bankSourceId),
    bankSourceOrder:
      data.bankSourceOrder === null ? null : sourceOrder(data.bankSourceOrder),
  });
}
export function encodeReceivingVerificationReceipt(
  value: ReceivingVerificationReceipt,
): string {
  // rv1 is an immutable local identity/order profile; this codec is not native provider proof.
  try {
    const normalized = receipt(value);
    const body = JSON.stringify([
      normalized.accountSourceId,
      normalized.accountSourceOrder,
      normalized.bankSourceId,
      normalized.bankSourceOrder,
    ]);
    return `rv1.${Buffer.from(body, "utf8").toString("base64url")}`;
  } catch {
    return unavailable();
  }
}
export function readReceivingVerificationReceipt(
  value: unknown,
): ReceivingVerificationReceipt {
  try {
    if (
      typeof value !== "string" ||
      value.length > 246 ||
      !/^rv1\.[A-Za-z0-9_-]+$/.test(value)
    )
      return unavailable();
    const payload = value.slice(4);
    const bytes = Buffer.from(payload, "base64url");
    if (bytes.toString("base64url") !== payload) return unavailable();
    const body: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (!Array.isArray(body) || body.length !== 4) return unavailable();
    const result = receipt({
      accountSourceId: body[0],
      accountSourceOrder: body[1],
      bankSourceId: body[2],
      bankSourceOrder: body[3],
    });
    if (encodeReceivingVerificationReceipt(result) !== value)
      return unavailable();
    return result;
  } catch {
    return unavailable();
  }
}
