import {
  meResponseSchema,
  siteIdSchema,
  type WithdrawalCreateInput,
  type WithdrawalIntent,
  type WithdrawalPreviewInput,
  type WithdrawalRequestContext,
  type WithdrawalRequestStatus,
  withdrawalCreateInputSchema,
  withdrawalPreviewInputSchema,
  withdrawalRequestContextResponseSchema,
  withdrawalRequestContextSchema,
  withdrawalRequestStatusResponseSchema,
  withdrawalRequestStatusSchema,
  withdrawalReservationInputSchema,
  withdrawalResponseSchema,
  withdrawalSealInputSchema,
} from "@entrelacos/contracts";
import { apiRequest } from "../lib/apiClient";

export type WithdrawalTransport = (
  path: string,
  options?: { method?: string; body?: unknown; signal?: AbortSignal },
) => Promise<unknown>;

function withdrawalPath(siteId: string): string {
  return `/v1/sites/${encodeURIComponent(siteIdSchema.parse(siteId))}/withdrawals`;
}

function validRequestId(requestId: string): string {
  return withdrawalReservationInputSchema.shape.requestId.parse(requestId);
}

function requestSettlement(
  response: unknown,
  siteId: string,
  requestId: string,
): WithdrawalRequestStatus {
  const { request } = withdrawalRequestStatusResponseSchema.parse(response);
  if (request.siteId !== siteId || request.requestId !== requestId)
    throw new Error("Unexpected withdrawal request scope");
  return request;
}

export async function loadWithdrawalContext(
  siteId: string,
  request: WithdrawalTransport = apiRequest,
  cursor?: string,
  signal?: AbortSignal,
): Promise<WithdrawalRequestContext> {
  const path = withdrawalPath(siteId);
  const query =
    cursor === undefined
      ? ""
      : `?cursor=${encodeURIComponent(withdrawalRequestContextSchema.shape.nextCursor.unwrap().parse(cursor)).replaceAll(".", "%2E")}`;
  const { context } = withdrawalRequestContextResponseSchema.parse(
    await (signal
      ? request(`${path}/context${query}`, { signal })
      : request(`${path}/context${query}`)),
  );
  if (context.siteId !== siteId)
    throw new Error("Unexpected withdrawal context scope");
  return context;
}

export async function loadWithdrawalRequest(
  siteId: string,
  requestId: string,
  request: WithdrawalTransport = apiRequest,
): Promise<WithdrawalRequestStatus> {
  const path = withdrawalPath(siteId);
  const validId = validRequestId(requestId);
  return requestSettlement(
    await request(
      `${path}/requests/${encodeURIComponent(validId).replaceAll(".", "%2E")}`,
    ),
    siteId,
    validId,
  );
}

export async function previewWithdrawal(
  siteId: string,
  input: WithdrawalPreviewInput,
  request: WithdrawalTransport = apiRequest,
): Promise<WithdrawalRequestStatus> {
  const path = withdrawalPath(siteId);
  const body = withdrawalPreviewInputSchema.parse(input);
  const result = requestSettlement(
    await request(`${path}/preview`, { method: "POST", body }),
    siteId,
    body.requestId,
  );
  const command = originalCommand(result);
  if (command && command.amountCents !== body.amountCents)
    throw new Error("Unexpected withdrawal preview amount");
  return result;
}

export async function postWithdrawalAction(
  siteId: string,
  input: WithdrawalCreateInput,
  request: WithdrawalTransport = apiRequest,
): Promise<WithdrawalIntent> {
  const path = withdrawalPath(siteId);
  const body = withdrawalCreateInputSchema.parse(input);
  const response = withdrawalResponseSchema.parse(
    await request(path, { method: "POST", body }),
  );
  if (
    response.requestId !== body.requestId ||
    response.withdrawal.siteId !== siteId
  )
    throw new Error("Unexpected withdrawal action scope");
  return response.withdrawal;
}

export async function sealWithdrawalRequest(
  siteId: string,
  requestId: string,
  token: string,
  request: WithdrawalTransport = apiRequest,
): Promise<WithdrawalRequestStatus> {
  const path = withdrawalPath(siteId);
  const validId = validRequestId(requestId);
  const body = withdrawalSealInputSchema.parse({
    reauthenticationToken: token,
  });
  return requestSettlement(
    await request(`${path}/${encodeURIComponent(validId)}/seal`, {
      method: "POST",
      body,
    }),
    siteId,
    validId,
  );
}

export type WithdrawalObservationComparison =
  | "same"
  | "newer"
  | "older"
  | "incomparable";

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareDimensions(
  previous: (bigint | null)[],
  next: (bigint | null)[],
): WithdrawalObservationComparison {
  let increases = false;
  let decreases = false;
  for (let index = 0; index < previous.length; index++) {
    const before = previous[index];
    const after = next[index];
    if (before === null || after === null) {
      if (before !== after) return "incomparable";
    } else {
      increases ||= after > before;
      decreases ||= after < before;
    }
  }
  return increases && decreases
    ? "incomparable"
    : increases
      ? "newer"
      : decreases
        ? "older"
        : "same";
}

function originalCommand(value: WithdrawalRequestStatus) {
  return value.state === "OPEN"
    ? {
        requestId: value.requestId,
        amountCents: value.preview.amountCents,
        destinationVersion: value.preview.destinationVersion,
      }
    : value.command;
}

function originalPreview(value: WithdrawalRequestStatus) {
  return value.state === "OPEN" || value.state === "EXISTING"
    ? value.preview
    : null;
}

export function compareWithdrawalObservations(
  previous: WithdrawalRequestStatus,
  next: WithdrawalRequestStatus,
): WithdrawalObservationComparison {
  const before = withdrawalRequestStatusSchema.safeParse(previous);
  const after = withdrawalRequestStatusSchema.safeParse(next);
  if (!before.success || !after.success) return "incomparable";
  const a = before.data;
  const b = after.data;
  if (a.siteId !== b.siteId || a.requestId !== b.requestId || a.mode !== b.mode)
    return "incomparable";
  const aCommand = originalCommand(a);
  const bCommand = originalCommand(b);
  const aPreview = originalPreview(a);
  const bPreview = originalPreview(b);
  if (
    (aCommand && bCommand && !equal(aCommand, bCommand)) ||
    (aPreview && bPreview && !equal(aPreview, bPreview)) ||
    (a.state === "EXISTING" &&
      b.state === "EXISTING" &&
      (a.withdrawal.id !== b.withdrawal.id ||
        a.withdrawal.createdAt !== b.withdrawal.createdAt ||
        a.withdrawal.feeCents !== b.withdrawal.feeCents ||
        a.withdrawal.feeSemantics !== b.withdrawal.feeSemantics ||
        a.withdrawal.netCents !== b.withdrawal.netCents))
  )
    return "incomparable";
  const dimensions = (value: WithdrawalRequestStatus): (bigint | null)[] => [
    BigInt(value.scopeRevision),
    value.requestRevision === null ? null : BigInt(value.requestRevision),
    value.observationOrder.recordUpdatedAtMicroseconds === null
      ? null
      : BigInt(value.observationOrder.recordUpdatedAtMicroseconds),
  ];
  const order = compareDimensions(dimensions(a), dimensions(b));
  const timeOrder = compareDimensions(
    [BigInt(Date.parse(a.observedAt))],
    [BigInt(Date.parse(b.observedAt))],
  );
  if (order === "incomparable") {
    const resolvesUnknown = (
      unknown: WithdrawalRequestStatus,
      known: WithdrawalRequestStatus,
    ): boolean => {
      if (
        unknown.state !== "UNRESOLVED" ||
        (known.state !== "OPEN" &&
          known.state !== "EXISTING" &&
          known.state !== "SEALED_NOT_CREATED") ||
        known.requestRevision === null ||
        known.observationOrder.recordUpdatedAtMicroseconds === null ||
        BigInt(known.scopeRevision) <= BigInt(unknown.scopeRevision) ||
        Date.parse(known.observedAt) < Date.parse(unknown.observedAt)
      )
        return false;
      return (
        (unknown.requestRevision === null ||
          BigInt(known.requestRevision) >= BigInt(unknown.requestRevision)) &&
        (unknown.observationOrder.recordUpdatedAtMicroseconds === null ||
          BigInt(known.observationOrder.recordUpdatedAtMicroseconds) >=
            BigInt(unknown.observationOrder.recordUpdatedAtMicroseconds))
      );
    };
    if (resolvesUnknown(a, b)) return "newer";
    if (resolvesUnknown(b, a)) return "older";
    return order;
  }
  if (order === "same") {
    return equal({ ...a, observedAt: null }, { ...b, observedAt: null })
      ? timeOrder === "older"
        ? "older"
        : "same"
      : "incomparable";
  }
  if (
    (order === "newer" && timeOrder === "older") ||
    (order === "older" && timeOrder === "newer") ||
    (a.state !== b.state && a.scopeRevision === b.scopeRevision)
  )
    return "incomparable";
  const older = order === "newer" ? a : b;
  const newer = order === "newer" ? b : a;
  if (
    (older.state === "EXISTING" &&
      older.withdrawal.state === "COMPLETED" &&
      (newer.state !== "EXISTING" ||
        newer.withdrawal.state !== "COMPLETED" ||
        (older.withdrawal.settlement &&
          !equal(older.withdrawal.settlement, newer.withdrawal.settlement)))) ||
    (originalPreview(older) && newer.state === "EXISTING" && !newer.preview) ||
    (older.state === "SEALED_NOT_CREATED" && newer.state !== older.state) ||
    (older.state === "EXISTING" &&
      newer.state !== "EXISTING" &&
      newer.state !== "UNRESOLVED")
  )
    return "incomparable";
  return order;
}

export function compareWithdrawalContexts(
  previous: WithdrawalRequestContext,
  next: WithdrawalRequestContext,
): WithdrawalObservationComparison {
  const before = withdrawalRequestContextSchema.safeParse(previous);
  const after = withdrawalRequestContextSchema.safeParse(next);
  if (!before.success || !after.success) return "incomparable";
  const a = before.data;
  const b = after.data;
  if (a.siteId !== b.siteId || a.mode !== b.mode) return "incomparable";
  const order = compareDimensions(
    [BigInt(a.scopeRevision)],
    [BigInt(b.scopeRevision)],
  );
  const timeOrder = compareDimensions(
    [BigInt(Date.parse(a.observedAt))],
    [BigInt(Date.parse(b.observedAt))],
  );
  const requests = (value: WithdrawalRequestContext) => [
    ...(value.openRequest ? [value.openRequest] : []),
    ...value.recoverableRequests,
  ];
  for (const previousRequest of requests(a)) {
    const nextRequest = requests(b).find(
      (value) => value.requestId === previousRequest.requestId,
    );
    if (!nextRequest) continue;
    const requestOrder = compareWithdrawalObservations(
      previousRequest,
      nextRequest,
    );
    if (
      requestOrder === "incomparable" ||
      (order === "newer" && requestOrder === "older") ||
      (order === "older" && requestOrder === "newer") ||
      (order === "same" && timeOrder === "older" && requestOrder === "newer") ||
      (order === "same" && timeOrder !== "older" && requestOrder === "older")
    )
      return "incomparable";
  }
  if (order === "same") {
    const stable = (value: WithdrawalRequestContext) => ({
      ...value,
      observedAt: null,
      openRequest: value.openRequest
        ? { ...value.openRequest, observedAt: null }
        : null,
      recoverableRequests: value.recoverableRequests.map((request) => ({
        ...request,
        observedAt: null,
      })),
    });
    const beforeState = stable(a);
    const afterState = stable(b);
    if (equal(beforeState, afterState))
      return timeOrder === "older" ? "older" : "same";
    // Provider settlement and receiving readiness do not advance request revisions.
    if (
      timeOrder !== "same" &&
      equal(
        {
          ...beforeState,
          newRequestAllowed: null,
          reason: null,
          openRequest: a.openRequest?.requestId ?? null,
          recoverableRequests: a.recoverableRequests.map(
            (row) => row.requestId,
          ),
        },
        {
          ...afterState,
          newRequestAllowed: null,
          reason: null,
          openRequest: b.openRequest?.requestId ?? null,
          recoverableRequests: b.recoverableRequests.map(
            (row) => row.requestId,
          ),
        },
      )
    )
      return timeOrder;
    return "incomparable";
  }
  if (
    (order === "newer" && timeOrder === "older") ||
    (order === "older" && timeOrder === "newer")
  )
    return "incomparable";
  return order;
}

type WithdrawalMarkerScope = {
  siteId: string;
  operatorUserId: string;
  mode: "sandbox" | "live";
  requestId: string;
};
export type WithdrawalMarker = WithdrawalMarkerScope &
  ({ version: 1 } | { version: 2; previewInput: WithdrawalPreviewInput });
export type WithdrawalStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

function parseMarker(value: unknown): WithdrawalMarker {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid withdrawal correlation");
  const record = value as Record<string, unknown>;
  const keys = ["version", "siteId", "operatorUserId", "mode", "requestId"];
  if (record.version === 2) keys.push("previewInput");
  if (
    Object.keys(record).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(record, key)) ||
    (record.version !== 1 && record.version !== 2) ||
    (record.mode !== "sandbox" && record.mode !== "live")
  )
    throw new Error("Invalid withdrawal correlation");
  const scope: WithdrawalMarkerScope = {
    siteId: siteIdSchema.parse(record.siteId),
    operatorUserId: meResponseSchema.shape.user.shape.id.parse(
      record.operatorUserId,
    ),
    mode: record.mode,
    requestId: withdrawalReservationInputSchema.shape.requestId.parse(
      record.requestId,
    ),
  };
  if (record.version === 1) return { version: 1, ...scope };
  const previewInput = withdrawalPreviewInputSchema.parse(record.previewInput);
  if (previewInput.requestId !== scope.requestId)
    throw new Error("Unexpected withdrawal preview correlation");
  return { version: 2, ...scope, previewInput };
}

export function withdrawalMarkerKey(
  siteId: string,
  operatorUserId: string,
): string {
  const site = siteIdSchema.parse(siteId);
  const operator = meResponseSchema.shape.user.shape.id.parse(operatorUserId);
  return `entrelacos.withdrawal.v1:${encodeURIComponent(site)}:${encodeURIComponent(operator)}`;
}

export function readWithdrawalMarker(
  storage: WithdrawalStorage,
  siteId: string,
  operatorUserId: string,
): WithdrawalMarker | null {
  const stored = storage.getItem(withdrawalMarkerKey(siteId, operatorUserId));
  if (stored === null) return null;
  const marker = parseMarker(JSON.parse(stored));
  if (marker.siteId !== siteId || marker.operatorUserId !== operatorUserId)
    throw new Error("Unexpected withdrawal correlation scope");
  return marker;
}

export function writeWithdrawalMarker(
  storage: WithdrawalStorage,
  value: WithdrawalMarker,
): void {
  const marker = parseMarker(value);
  const key = withdrawalMarkerKey(marker.siteId, marker.operatorUserId);
  const previous = readWithdrawalMarker(
    storage,
    marker.siteId,
    marker.operatorUserId,
  );
  if (previous && !equal(previous, marker))
    throw new Error("A withdrawal correlation is already retained");
  const serialized = JSON.stringify(marker);
  storage.setItem(key, serialized);
  if (storage.getItem(key) !== serialized)
    throw new Error("Withdrawal correlation was not retained");
}

export function removeWithdrawalMarker(
  storage: WithdrawalStorage,
  value: WithdrawalMarker,
): boolean {
  const expected = parseMarker(value);
  const key = withdrawalMarkerKey(expected.siteId, expected.operatorUserId);
  const previous = readWithdrawalMarker(
    storage,
    expected.siteId,
    expected.operatorUserId,
  );
  if (!previous || !equal(previous, expected)) return false;
  // Storage has no atomic compare-and-remove; server ordering remains authoritative.
  const current = storage.getItem(key);
  if (current === null || !equal(parseMarker(JSON.parse(current)), expected))
    return false;
  storage.removeItem(key);
  if (storage.getItem(key) !== null)
    throw new Error("Withdrawal correlation retirement was not confirmed");
  return true;
}
