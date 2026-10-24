import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type GiftMediaPublicAsset,
  type GiftMediaStatusResponse,
  type GiftMediaUploadInput,
  type GiftMediaUploadResponse,
  giftMediaFinalizeResponseSchema,
  giftMediaPublicAssetSchema,
  giftMediaStatusResponseSchema,
  giftMediaUploadInputSchema,
  giftMediaUploadResponseSchema,
} from "@entrelacos/contracts";
import {
  giftMediaAsset,
  giftMediaPublicationIntent,
} from "@entrelacos/database/schema";
import { sql } from "drizzle-orm";
import { AdminSessionRequiredError } from "./authHttp";
import {
  compareDatabaseTimestamps,
  databaseTimestampEpochMicroseconds,
  readDatabaseTimestamp,
} from "./databaseTimestamp";
import { decodeGiftImage, GiftImageDecodeError } from "./giftImageDecoder";
import {
  type GiftMediaStorage,
  GiftMediaStorageError,
  type GiftUploadContentType,
} from "./giftMediaStorage";
import {
  type GiftDatabase,
  GiftServiceError,
  type GiftServiceOptions,
  withGiftCatalogMutation,
} from "./gifts";
import { type SiteAccessActor, SiteAccessDeniedError } from "./siteAccess";

const uploadTtlMs = 300_000;
const processingTtlMs = 60_000;
const callerTimeoutMs = 45_000;
const bodyTimeoutMs = 15_000;
const maxBytes = 5_242_880;
type MediaRow = typeof giftMediaAsset.$inferSelect;
type PublicationIntent = typeof giftMediaPublicationIntent.$inferSelect;
interface Binding {
  phase: "expected" | "verified" | "closed";
  original: string;
  derivative?: string;
}
export interface GiftMediaBinaryInput {
  body: ReadableStream<Uint8Array>;
  contentType: GiftUploadContentType;
  contentLength?: number;
  signal?: AbortSignal;
}
export interface GiftMediaProcessing {
  process<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  track<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  close(): Promise<void>;
}
export interface GiftMediaServiceOptions extends GiftServiceOptions {
  storage?: GiftMediaStorage;
  storageNamespace?: string;
  processing?: GiftMediaProcessing;
  authorize?: (db?: GiftDatabase) => Promise<SiteAccessActor>;
  decode?: typeof decodeGiftImage;
  generateId?: () => string;
}
export class GiftMediaServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
  ) {
    super(title);
    this.name = "GiftMediaServiceError";
  }
}
function reject(status: number, code: string, title: string): never {
  throw new GiftMediaServiceError(status, code, title);
}
function invalid(): never {
  return reject(400, "GIFT_MEDIA_INVALID", "Gift image invalid");
}
function unavailable(): never {
  return reject(
    503,
    "MEDIA_STORAGE_UNAVAILABLE",
    "Gift media service unavailable",
  );
}
function expired(): never {
  return reject(409, "GIFT_MEDIA_EXPIRED", "Gift media upload expired");
}
function conflict(): never {
  return reject(409, "GIFT_MEDIA_CONFLICT", "Gift media operation conflicts");
}
function current(signal: AbortSignal): void {
  if (signal.aborted) unavailable();
}
function sanitize(error: unknown): Error {
  if (
    error instanceof GiftMediaServiceError ||
    error instanceof GiftServiceError ||
    error instanceof SiteAccessDeniedError ||
    error instanceof AdminSessionRequiredError
  )
    return error;
  if (error instanceof GiftImageDecodeError)
    return new GiftMediaServiceError(
      400,
      "GIFT_MEDIA_INVALID",
      "Gift image invalid",
    );
  return new GiftMediaServiceError(
    503,
    "MEDIA_STORAGE_UNAVAILABLE",
    "Gift media service unavailable",
  );
}
export function createGiftMediaProcessing(): GiftMediaProcessing {
  const owned = new Set<{
    abort: AbortController;
    completion: Promise<void>;
  }>();
  let busy = false;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  function run<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal | undefined,
    exclusive: boolean,
  ): Promise<T> {
    if (closing || signal?.aborted) return Promise.reject(sanitize(null));
    if (exclusive && busy)
      return Promise.reject(
        new GiftMediaServiceError(
          409,
          "GIFT_MEDIA_BUSY",
          "Gift media processing busy",
        ),
      );
    if (exclusive) busy = true;
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, callerTimeoutMs);
    let completed!: () => void;
    const entry = {
      abort,
      completion: new Promise<void>((resolve) => {
        completed = resolve;
      }),
    };
    owned.add(entry);
    return (async () => {
      try {
        current(abort.signal);
        const value = await operation(abort.signal);
        current(abort.signal);
        return value;
      } catch (error) {
        throw sanitize(error);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        owned.delete(entry);
        if (exclusive) busy = false;
        completed();
      }
    })();
  }
  return Object.freeze({
    process: <T>(
      operation: (signal: AbortSignal) => Promise<T>,
      signal?: AbortSignal,
    ) => run(operation, signal, true),
    track: <T>(
      operation: (signal: AbortSignal) => Promise<T>,
      signal?: AbortSignal,
    ) => run(operation, signal, false),
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      let complete!: () => void;
      closePromise = new Promise<void>((resolve) => {
        complete = resolve;
      });
      for (const entry of owned) entry.abort.abort();
      void Promise.allSettled(
        Array.from(owned, (entry) => entry.completion),
      ).then(() => complete());
      return closePromise;
    },
  });
}
function clock(options: GiftMediaServiceOptions): Date {
  const now = (options.now ?? (() => new Date()))();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) unavailable();
  return new Date(now.getTime());
}
function generateId(options: GiftMediaServiceOptions): string {
  const value = (options.generateId ?? randomUUID)();
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
  )
    unavailable();
  return value;
}
function timestamp(value: Date | null): string | null {
  if (value === null) return null;
  const microseconds = databaseTimestampEpochMicroseconds(value);
  const fraction = (((microseconds % 1_000_000n) + 1_000_000n) % 1_000_000n)
    .toString()
    .padStart(6, "0");
  return `${value.toISOString().slice(0, 19)}.${fraction}Z`;
}
function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function binding(row: MediaRow): Binding | null {
  const parts = row.stagingKey.split("/");
  if (
    parts.length !== 4 ||
    parts[0] !== "inline-v1" ||
    parts[1] !== row.siteId ||
    parts[2] !== row.id ||
    !/^[A-Za-z0-9_-]+$/.test(parts[3])
  )
    return null;
  const match =
    /^inline-v1:(expected|verified|closed):([a-f0-9]{64})(?::([a-f0-9]{64}))?$/.exec(
      row.stableObjectVersion ?? "",
    );
  if (!match || (match[1] === "verified") !== !!match[3]) return null;
  if (
    match[1] !== "verified" &&
    [
      row.derivativeKey,
      row.publicUrl,
      row.contentType,
      row.byteLength,
      row.width,
      row.height,
    ].some((value) => value !== null)
  )
    return null;
  return {
    phase: match[1] as Binding["phase"],
    original: match[2],
    derivative: match[3],
  };
}
const mediaColumns = sql`
  id, site_id AS "siteId", staging_key AS "stagingKey", declared_content_type AS "declaredContentType",
  declared_byte_length AS "declaredByteLength", processing_id AS "processingId", processing_expires_at AS "processingExpiresAt",
  expires_at AS "expiresAt", state, stable_object_version AS "stableObjectVersion", derivative_key AS "derivativeKey",
  public_url AS "publicUrl", content_type AS "contentType", byte_length AS "byteLength", width, height,
  created_at AS "createdAt", updated_at AS "updatedAt"
`;
async function readAsset(
  db: GiftDatabase,
  siteId: string,
  assetId: string,
): Promise<MediaRow> {
  const result = await db.execute(
    sql`SELECT ${mediaColumns} FROM gift_media_asset WHERE site_id = ${siteId} AND id = ${assetId} FOR UPDATE`,
  );
  const row = result.rows[0] as MediaRow | undefined;
  if (!row || row.id !== assetId || row.siteId !== siteId)
    reject(404, "GIFT_MEDIA_NOT_FOUND", "Gift image unavailable");
  try {
    return {
      ...row,
      expiresAt: readDatabaseTimestamp(row.expiresAt),
      createdAt: readDatabaseTimestamp(row.createdAt),
      updatedAt: readDatabaseTimestamp(row.updatedAt),
      processingExpiresAt:
        row.processingExpiresAt === null
          ? null
          : readDatabaseTimestamp(row.processingExpiresAt),
    };
  } catch {
    unavailable();
  }
}
async function readIntents(
  db: GiftDatabase,
  row: MediaRow,
): Promise<PublicationIntent[]> {
  const result = await db.execute(sql`
    SELECT id, site_id AS "siteId", asset_id AS "assetId", processing_id AS "processingId", storage_namespace AS "storageNamespace",
      derivative_key AS "derivativeKey", state, created_at AS "createdAt", observed_at AS "observedAt"
    FROM gift_media_publication_intent WHERE site_id = ${row.siteId} AND asset_id = ${row.id} FOR UPDATE
  `);
  return (result.rows as PublicationIntent[]).map((value) => {
    if (
      value.siteId !== row.siteId ||
      value.assetId !== row.id ||
      ![
        "REQUESTED",
        "UNKNOWN",
        "PUBLISHED",
        "ASSOCIATED",
        "ORPHANED",
        "CLEANED",
      ].includes(value.state)
    )
      unavailable();
    try {
      return {
        ...value,
        createdAt: readDatabaseTimestamp(value.createdAt),
        observedAt:
          value.observedAt === null
            ? null
            : readDatabaseTimestamp(value.observedAt),
      };
    } catch {
      return unavailable();
    }
  });
}
function fence(row: MediaRow, prefix: "" | "a." = "") {
  const column = (name: string) => sql.raw(prefix + name);
  return sql`
    ${column("site_id")} = ${row.siteId} AND ${column("id")} = ${row.id}
    AND ${column("state")} = ${row.state} AND ${column("staging_key")} = ${row.stagingKey}
    AND ${column("processing_id")} IS NOT DISTINCT FROM ${row.processingId}
    AND ${column("processing_expires_at")} IS NOT DISTINCT FROM ${timestamp(row.processingExpiresAt)}::timestamptz
    AND ${column("expires_at")} = ${timestamp(row.expiresAt)}::timestamptz
    AND ${column("declared_content_type")} IS NOT DISTINCT FROM ${row.declaredContentType}
    AND ${column("declared_byte_length")} IS NOT DISTINCT FROM ${row.declaredByteLength}
    AND ${column("stable_object_version")} IS NOT DISTINCT FROM ${row.stableObjectVersion}
    AND ${column("derivative_key")} IS NOT DISTINCT FROM ${row.derivativeKey}
    AND ${column("public_url")} IS NOT DISTINCT FROM ${row.publicUrl}
    AND ${column("content_type")} IS NOT DISTINCT FROM ${row.contentType}
    AND ${column("byte_length")} IS NOT DISTINCT FROM ${row.byteLength}
    AND ${column("width")} IS NOT DISTINCT FROM ${row.width} AND ${column("height")} IS NOT DISTINCT FROM ${row.height}
  `;
}
function sameRow(left: MediaRow, right: MediaRow): boolean {
  return (
    left.siteId === right.siteId &&
    left.id === right.id &&
    left.state === right.state &&
    left.stagingKey === right.stagingKey &&
    left.processingId === right.processingId &&
    ((left.processingExpiresAt === null &&
      right.processingExpiresAt === null) ||
      (left.processingExpiresAt !== null &&
        right.processingExpiresAt !== null &&
        compareDatabaseTimestamps(
          left.processingExpiresAt,
          right.processingExpiresAt,
        ) === 0)) &&
    compareDatabaseTimestamps(left.expiresAt, right.expiresAt) === 0 &&
    left.declaredContentType === right.declaredContentType &&
    left.declaredByteLength === right.declaredByteLength &&
    left.stableObjectVersion === right.stableObjectVersion &&
    left.derivativeKey === right.derivativeKey &&
    left.publicUrl === right.publicUrl &&
    left.contentType === right.contentType &&
    left.byteLength === right.byteLength &&
    left.width === right.width &&
    left.height === right.height
  );
}
function originalIntent(
  row: MediaRow,
  intents: PublicationIntent[],
  namespace: string,
  finalized = false,
): PublicationIntent | null {
  if (intents.length !== 1) return null;
  const value = intents[0];
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.processingId) ||
    value.storageNamespace !== namespace ||
    value.derivativeKey !==
      `gifts/${row.siteId}/${row.id}/${value.processingId}.webp` ||
    (!finalized && value.processingId !== row.processingId) ||
    (finalized &&
      (value.state !== "ASSOCIATED" ||
        value.derivativeKey !== row.derivativeKey))
  )
    return null;
  return value;
}
function possible(intents: PublicationIntent[]): boolean {
  return intents.some(
    (value) => value.state !== "REQUESTED" && value.state !== "ORPHANED",
  );
}
function active(row: MediaRow, now: Date): boolean {
  return (
    row.processingExpiresAt !== null &&
    compareDatabaseTimestamps(row.processingExpiresAt, now) > 0
  );
}
function liveClaim(
  context: Scope,
  signal: AbortSignal,
  row: MediaRow,
  allowExpiredUpload = false,
): void {
  context.check(signal);
  const now = clock(context.options);
  if (
    !active(row, now) ||
    (!allowExpiredUpload && compareDatabaseTimestamps(row.expiresAt, now) <= 0)
  )
    conflict();
}
function publicMedia(row: MediaRow): GiftMediaPublicAsset {
  const parsed = giftMediaPublicAssetSchema.safeParse({
    id: row.id,
    siteId: row.siteId,
    url: row.publicUrl,
    contentType: row.contentType,
    byteLength: row.byteLength,
    width: row.width,
    height: row.height,
  });
  if (
    !parsed.success ||
    !row.derivativeKey ||
    decodeURIComponent(new URL(parsed.data.url).pathname) !==
      `/${row.derivativeKey}` ||
    parsed.data.width > 2048 ||
    parsed.data.height > 2048
  )
    unavailable();
  return parsed.data;
}
interface Scope {
  options: GiftMediaServiceOptions;
  storage: GiftMediaStorage;
  namespace: string;
  processing: GiftMediaProcessing;
  check(signal: AbortSignal): void;
  locked<T>(
    signal: AbortSignal,
    operation: (tx: GiftDatabase, now: Date) => Promise<T>,
  ): Promise<T>;
}
function scope(
  db: GiftDatabase,
  actor: SiteAccessActor,
  siteId: string,
  supplied: GiftMediaServiceOptions,
): Scope {
  const options = { ...supplied };
  const { storage, processing, authorize } = options;
  const namespace = options.storageNamespace;
  const identity = { ...actor };
  if (
    !storage ||
    !processing ||
    typeof authorize !== "function" ||
    typeof namespace !== "string" ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(namespace) ||
    storage.storageNamespace !== namespace
  )
    unavailable();
  const check = (signal: AbortSignal) => {
    current(signal);
    if (
      supplied.storage !== storage ||
      supplied.processing !== processing ||
      supplied.authorize !== authorize ||
      supplied.storageNamespace !== namespace ||
      storage.storageNamespace !== namespace ||
      actor.userId !== identity.userId ||
      actor.role !== identity.role
    )
      unavailable();
  };
  const authorizeCurrent = async (
    signal: AbortSignal,
    transaction?: GiftDatabase,
  ) => {
    check(signal);
    const value = await authorize(transaction);
    check(signal);
    if (
      !value ||
      value.userId !== identity.userId ||
      value.role !== identity.role
    )
      throw new SiteAccessDeniedError();
  };
  return {
    options,
    storage,
    namespace,
    processing,
    check,
    locked: async (signal, operation) => {
      await authorizeCurrent(signal);
      const result = await withGiftCatalogMutation(
        db,
        identity,
        siteId,
        options,
        async (tx) => {
          await authorizeCurrent(signal, tx);
          check(signal);
          const value = await operation(tx, clock(options));
          check(signal);
          return value;
        },
      );
      check(signal);
      return result;
    },
  };
}
function status(
  row: MediaRow,
  intents: PublicationIntent[],
  context: Scope,
  now: Date,
): GiftMediaStatusResponse {
  const bound = binding(row);
  const intent = originalIntent(
    row,
    intents,
    context.namespace,
    row.state === "FINALIZED",
  );
  const uploadValid = compareDatabaseTimestamps(row.expiresAt, now) > 0;
  let state: GiftMediaStatusResponse["status"]["state"] = "UNKNOWN";
  let canRetrySameBytes = false;
  let media: GiftMediaPublicAsset | null = null;
  if (
    row.state === "FINALIZED" &&
    bound?.phase === "verified" &&
    intent?.state === "ASSOCIATED"
  ) {
    media = publicMedia(row);
    state = "FINALIZED";
  } else if (
    bound?.phase === "closed" &&
    (row.state === "FAILED" || row.state === "EXPIRED") &&
    !possible(intents) &&
    ((intents.length === 0 && row.processingId === null) ||
      intent?.state === "ORPHANED")
  ) {
    state = row.state;
  } else if (
    bound?.phase === "expected" &&
    !possible(intents) &&
    ((row.state === "PENDING" &&
      row.processingId === null &&
      intents.length === 0) ||
      (row.state === "PROCESSING" && intent?.state === "REQUESTED"))
  ) {
    state = active(row, now)
      ? "PROCESSING"
      : uploadValid
        ? "PENDING"
        : "UNKNOWN";
    canRetrySameBytes = state === "PENDING";
  } else if (
    bound?.phase === "verified" &&
    row.state === "PROCESSING" &&
    intent &&
    ["UNKNOWN", "PUBLISHED"].includes(intent.state)
  ) {
    publicMedia(row);
    const url = context.storage.getDerivativeUrl(intent.derivativeKey);
    canRetrySameBytes =
      uploadValid && !active(row, now) && url === row.publicUrl;
  }
  return giftMediaStatusResponseSchema.parse({
    status: {
      siteId: row.siteId,
      assetId: row.id,
      state,
      expiresAt: row.expiresAt.toISOString(),
      canRetrySameBytes,
      media,
    },
  });
}
async function observe(
  tx: GiftDatabase,
  row: MediaRow,
  intent: PublicationIntent,
  next: PublicationIntent["state"],
  now: Date,
  context: Scope,
  signal: AbortSignal,
): Promise<PublicationIntent> {
  const allowed =
    next === "UNKNOWN"
      ? intent.state === "REQUESTED"
      : next === "PUBLISHED"
        ? ["UNKNOWN", "PUBLISHED"].includes(intent.state)
        : next === "ASSOCIATED"
          ? intent.state === "PUBLISHED"
          : next === "ORPHANED" && intent.state === "REQUESTED";
  if (!allowed) conflict();
  const observedAt =
    compareDatabaseTimestamps(now, intent.createdAt) < 0
      ? intent.createdAt
      : now;
  context.check(signal);
  const updated = await tx.execute(sql`
    UPDATE gift_media_publication_intent SET state = ${next}, observed_at = ${timestamp(observedAt)}::timestamptz
    WHERE id = ${intent.id} AND site_id = ${intent.siteId} AND asset_id = ${intent.assetId}
      AND processing_id = ${intent.processingId} AND storage_namespace = ${intent.storageNamespace}
      AND derivative_key = ${intent.derivativeKey} AND state = ${intent.state}
      AND EXISTS (SELECT 1 FROM gift_media_asset a WHERE ${fence(row, "a.")}) RETURNING id
  `);
  context.check(signal);
  if (updated.rows.length !== 1) conflict();
  return { ...intent, state: next, observedAt };
}
async function seal(
  context: Scope,
  signal: AbortSignal,
  captured: MediaRow,
  expiredOnly = false,
): Promise<boolean> {
  return context.locked(signal, async (tx) => {
    const row = await readAsset(tx, captured.siteId, captured.id);
    context.check(signal);
    const bound = binding(row);
    if (!sameRow(row, captured) || bound?.phase !== "expected") return false;
    const intents = await readIntents(tx, row);
    context.check(signal);
    const intent = originalIntent(row, intents, context.namespace);
    const now = clock(context.options);
    if (
      possible(intents) ||
      !(
        (intents.length === 0 && row.processingId === null) ||
        intent?.state === "REQUESTED"
      )
    )
      return false;
    if (!expiredOnly && !active(row, now)) return false;
    const isExpired = compareDatabaseTimestamps(row.expiresAt, now) <= 0;
    if (expiredOnly && !isExpired) return false;
    const closed = {
      ...row,
      state: isExpired ? ("EXPIRED" as const) : ("FAILED" as const),
      stableObjectVersion: `inline-v1:closed:${bound.original}`,
      updatedAt: now,
    };
    const result = await tx.execute(sql`
      UPDATE gift_media_asset SET state = ${closed.state}, stable_object_version = ${closed.stableObjectVersion}, updated_at = ${now}
      WHERE ${fence(row)} RETURNING id
    `);
    context.check(signal);
    if (result.rows.length !== 1) conflict();
    if (!expiredOnly && !active(row, clock(context.options))) conflict();
    if (intent)
      await observe(tx, closed, intent, "ORPHANED", now, context, signal);
    if (!expiredOnly && !active(row, clock(context.options))) conflict();
    return true;
  });
}
async function readBody(
  input: GiftMediaBinaryInput,
  byteLength: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  current(signal);
  const reader = input.body.getReader();
  let timedOut = false;
  let canceled: Promise<void> | undefined;
  const cancel = () => {
    canceled ??= reader.cancel().then(
      () => {},
      () => {},
    );
  };
  const timer = setTimeout(() => {
    timedOut = true;
    cancel();
  }, bodyTimeoutMs);
  signal.addEventListener("abort", cancel, { once: true });
  let size = 0;
  try {
    const bytes = Buffer.alloc(byteLength);
    if (signal.aborted) cancel();
    while (true) {
      current(signal);
      if (timedOut) unavailable();
      const value = await reader.read();
      current(signal);
      if (timedOut) unavailable();
      if (value.done) break;
      if (!(value.value instanceof Uint8Array))
        throw new GiftImageDecodeError();
      if (size + value.value.byteLength > byteLength)
        throw new GiftImageDecodeError();
      bytes.set(value.value, size);
      size += value.value.byteLength;
    }
    return bytes.subarray(0, size);
  } catch (error) {
    cancel();
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    if (canceled) await canceled;
    reader.releaseLock();
  }
}
interface Claim {
  row: MediaRow;
  intent: PublicationIntent;
  bound: Binding;
}
async function acquire(
  context: Scope,
  signal: AbortSignal,
  siteId: string,
  assetId: string,
  recovery: boolean,
): Promise<Claim | { result: GiftMediaPublicAsset } | null> {
  return context.locked(signal, async (tx) => {
    let row = await readAsset(tx, siteId, assetId);
    const intents = await readIntents(tx, row);
    context.check(signal);
    const now = clock(context.options);
    const bound = binding(row);
    if (
      row.state === "FINALIZED" &&
      bound?.phase === "verified" &&
      originalIntent(row, intents, context.namespace, true)
    )
      return { result: publicMedia(row) };
    if (!bound || bound.phase === "closed") {
      if (recovery) return null;
      conflict();
    }
    if (
      !giftMediaUploadInputSchema.safeParse({
        contentType: row.declaredContentType,
        byteLength: row.declaredByteLength,
        contentSha256: bound.original,
      }).success
    )
      unavailable();
    if (!recovery && compareDatabaseTimestamps(row.expiresAt, now) <= 0)
      expired();
    if (!["PENDING", "PROCESSING"].includes(row.state)) {
      if (recovery) return null;
      conflict();
    }
    if (active(row, now)) {
      if (recovery) return null;
      conflict();
    }
    let intent = originalIntent(row, intents, context.namespace);
    if (recovery && bound.phase !== "verified") return null;
    if (
      bound.phase === "verified" &&
      (!intent || !["UNKNOWN", "PUBLISHED"].includes(intent.state))
    )
      unavailable();
    if (
      bound.phase === "expected" &&
      (possible(intents) ||
        (intents.length > 0 && intent?.state !== "REQUESTED"))
    )
      unavailable();
    if (
      row.state === "PROCESSING" &&
      (!row.processingId || !row.processingExpiresAt || !intent)
    )
      unavailable();
    if (
      row.state === "PENDING" &&
      (row.processingId !== null ||
        row.processingExpiresAt !== null ||
        intents.length > 0)
    )
      unavailable();
    const processingId = intent?.processingId ?? generateId(context.options);
    const processingExpiresAt = new Date(
      recovery
        ? now.getTime() + processingTtlMs
        : Math.min(now.getTime() + processingTtlMs, row.expiresAt.getTime()),
    );
    const updated = await tx.execute(sql`
      UPDATE gift_media_asset SET state = ${"PROCESSING"}, processing_id = ${processingId},
        processing_expires_at = ${processingExpiresAt}, updated_at = ${now} WHERE ${fence(row)} RETURNING id
    `);
    context.check(signal);
    if (updated.rows.length !== 1) conflict();
    row = {
      ...row,
      state: "PROCESSING",
      processingId,
      processingExpiresAt,
      updatedAt: now,
    };
    liveClaim(context, signal, row, recovery);
    if (!intent) {
      intent = {
        id: randomUUID(),
        siteId,
        assetId,
        processingId,
        storageNamespace: context.namespace,
        derivativeKey: `gifts/${siteId}/${assetId}/${processingId}.webp`,
        state: "REQUESTED",
        createdAt: now,
        observedAt: null,
      };
      await tx.insert(giftMediaPublicationIntent).values(intent);
      context.check(signal);
    }
    if (bound.phase === "verified") {
      publicMedia(row);
      const url = context.storage.getDerivativeUrl(intent.derivativeKey);
      context.check(signal);
      if (url !== row.publicUrl) unavailable();
    }
    liveClaim(context, signal, row, recovery);
    return { row, intent, bound };
  });
}
async function fenced(
  context: Scope,
  signal: AbortSignal,
  claim: Claim,
  allowExpired: boolean,
  operation: (
    tx: GiftDatabase,
    row: MediaRow,
    intent: PublicationIntent,
    now: Date,
  ) => Promise<Claim>,
): Promise<Claim> {
  return context.locked(signal, async (tx) => {
    const row = await readAsset(tx, claim.row.siteId, claim.row.id);
    const intents = await readIntents(tx, row);
    context.check(signal);
    const now = clock(context.options);
    const intent = originalIntent(row, intents, context.namespace);
    if (
      !sameRow(row, claim.row) ||
      !intent ||
      intent.id !== claim.intent.id ||
      intent.state !== claim.intent.state ||
      !active(row, now) ||
      (!allowExpired && compareDatabaseTimestamps(row.expiresAt, now) <= 0)
    )
      conflict();
    return operation(tx, row, intent, now);
  });
}
async function pin(
  context: Scope,
  signal: AbortSignal,
  claim: Claim,
  bytes: Uint8Array,
  decoded: Awaited<ReturnType<typeof decodeGiftImage>>,
): Promise<Claim> {
  return fenced(context, signal, claim, false, async (tx, row, intent, now) => {
    const url = context.storage.getDerivativeUrl(intent.derivativeKey);
    context.check(signal);
    if (
      !giftMediaPublicAssetSchema.shape.url.safeParse(url).success ||
      decodeURIComponent(new URL(url).pathname) !== `/${intent.derivativeKey}`
    )
      unavailable();
    const version = `inline-v1:verified:${hash(bytes)}:${hash(decoded.bytes)}`;
    const result = giftMediaPublicAssetSchema.safeParse({
      id: row.id,
      siteId: row.siteId,
      url,
      contentType: decoded.contentType,
      byteLength: decoded.byteLength,
      width: decoded.width,
      height: decoded.height,
    });
    context.check(signal);
    if (
      !result.success ||
      !(decoded.bytes instanceof Uint8Array) ||
      decoded.bytes.byteLength !== decoded.byteLength ||
      decoded.width > 2048 ||
      decoded.height > 2048
    )
      throw new GiftImageDecodeError();
    if (claim.bound.phase === "verified") {
      if (
        row.stableObjectVersion !== version ||
        row.derivativeKey !== intent.derivativeKey ||
        row.publicUrl !== url ||
        row.contentType !== decoded.contentType ||
        row.byteLength !== decoded.byteLength ||
        row.width !== decoded.width ||
        row.height !== decoded.height
      )
        invalid();
      return { row, intent, bound: claim.bound };
    }
    if (intent.state !== "REQUESTED" || binding(row)?.phase !== "expected")
      conflict();
    const pinned = {
      ...row,
      stableObjectVersion: version,
      derivativeKey: intent.derivativeKey,
      publicUrl: url,
      contentType: decoded.contentType,
      byteLength: decoded.byteLength,
      width: decoded.width,
      height: decoded.height,
      updatedAt: now,
    };
    const updated = await tx.execute(sql`
      UPDATE gift_media_asset SET stable_object_version = ${version}, derivative_key = ${pinned.derivativeKey}, public_url = ${url},
        content_type = ${pinned.contentType}, byte_length = ${pinned.byteLength}, width = ${pinned.width}, height = ${pinned.height}, updated_at = ${now}
      WHERE ${fence(row)} RETURNING id
    `);
    liveClaim(context, signal, row);
    if (updated.rows.length !== 1) conflict();
    const armed = await observe(
      tx,
      pinned,
      intent,
      "UNKNOWN",
      now,
      context,
      signal,
    );
    liveClaim(context, signal, row);
    return {
      row: pinned,
      intent: armed,
      bound: {
        phase: "verified",
        original: hash(bytes),
        derivative: hash(decoded.bytes),
      },
    };
  });
}
async function associate(
  context: Scope,
  signal: AbortSignal,
  claim: Claim,
  allowExpired: boolean,
): Promise<GiftMediaPublicAsset> {
  const result = await fenced(
    context,
    signal,
    claim,
    allowExpired,
    async (tx, row, intent, now) => {
      const published = await observe(
        tx,
        row,
        intent,
        "PUBLISHED",
        now,
        context,
        signal,
      );
      liveClaim(context, signal, row, allowExpired);
      const finalized = {
        ...row,
        state: "FINALIZED" as const,
        processingId: null,
        processingExpiresAt: null,
        updatedAt: now,
      };
      const updated = await tx.execute(sql`
      UPDATE gift_media_asset SET state = ${"FINALIZED"}, processing_id = NULL, processing_expires_at = NULL, updated_at = ${now}
      WHERE ${fence(row)} RETURNING id
    `);
      liveClaim(context, signal, row, allowExpired);
      if (updated.rows.length !== 1) conflict();
      const associated = await observe(
        tx,
        finalized,
        published,
        "ASSOCIATED",
        now,
        context,
        signal,
      );
      liveClaim(context, signal, row, allowExpired);
      return { row: finalized, intent: associated, bound: claim.bound };
    },
  );
  context.check(signal);
  return publicMedia(result.row);
}
async function exactReadback(
  context: Scope,
  signal: AbortSignal,
  claim: Claim,
  allowExpiredUpload = false,
): Promise<void> {
  const headPort = context.storage.headDerivative;
  liveClaim(context, signal, claim.row, allowExpiredUpload);
  const head = await headPort.call(
    context.storage,
    claim.intent.derivativeKey,
    signal,
  );
  context.check(signal);
  if (
    head.contentType !== "image/webp" ||
    head.byteLength !== claim.row.byteLength ||
    typeof head.etag !== "string" ||
    !/^"[^"\\\r\n]{1,128}"$/.test(head.etag)
  )
    unavailable();
  const readPort = context.storage.readDerivative;
  liveClaim(context, signal, claim.row, allowExpiredUpload);
  const bytes = await readPort.call(
    context.storage,
    claim.intent.derivativeKey,
    head.etag,
    head.byteLength,
    signal,
  );
  context.check(signal);
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength !== claim.row.byteLength ||
    hash(bytes) !== claim.bound.derivative
  )
    unavailable();
}
async function consultation(
  context: Scope,
  signal: AbortSignal,
  siteId: string,
  assetId: string,
): Promise<GiftMediaStatusResponse> {
  return context.locked(signal, async (tx) => {
    const row = await readAsset(tx, siteId, assetId);
    const intents = await readIntents(tx, row);
    context.check(signal);
    const value = status(row, intents, context, clock(context.options));
    context.check(signal);
    return value;
  });
}
export async function issueGiftMediaUpload(
  db: GiftDatabase,
  actor: SiteAccessActor,
  siteId: string,
  input: GiftMediaUploadInput,
  options: GiftMediaServiceOptions = {},
): Promise<GiftMediaUploadResponse> {
  const parsed = giftMediaUploadInputSchema.safeParse(input);
  if (!parsed.success) invalid();
  const context = scope(db, actor, siteId, options);
  return context.processing.track(async (signal) => {
    const record = await context.locked(signal, async (tx, now) => {
      const id = generateId(context.options);
      const row: MediaRow = {
        id,
        siteId,
        stagingKey: `inline-v1/${siteId}/${id}/${randomBytes(18).toString("base64url")}`,
        declaredContentType: parsed.data.contentType,
        declaredByteLength: parsed.data.byteLength,
        state: "PENDING",
        expiresAt: new Date(now.getTime() + uploadTtlMs),
        processingId: null,
        processingExpiresAt: null,
        stableObjectVersion: `inline-v1:expected:${parsed.data.contentSha256}`,
        derivativeKey: null,
        publicUrl: null,
        contentType: null,
        byteLength: null,
        width: null,
        height: null,
        createdAt: now,
        updatedAt: now,
      };
      await tx.insert(giftMediaAsset).values(row);
      context.check(signal);
      return row;
    });
    return giftMediaUploadResponseSchema.parse({
      upload: { id: record.id, expiresAt: record.expiresAt.toISOString() },
    });
  });
}
export async function consultGiftMediaUpload(
  db: GiftDatabase,
  actor: SiteAccessActor,
  siteId: string,
  assetId: string,
  options: GiftMediaServiceOptions = {},
  signal?: AbortSignal,
): Promise<GiftMediaStatusResponse> {
  if (!giftMediaPublicAssetSchema.shape.id.safeParse(assetId).success)
    invalid();
  const context = scope(db, actor, siteId, options);
  return context.processing.track(
    (ownedSignal) => consultation(context, ownedSignal, siteId, assetId),
    signal,
  );
}
export async function finalizeGiftMediaUpload(
  db: GiftDatabase,
  actor: SiteAccessActor,
  siteId: string,
  assetId: string,
  input: GiftMediaBinaryInput,
  options: GiftMediaServiceOptions = {},
) {
  if (
    !giftMediaPublicAssetSchema.shape.id.safeParse(assetId).success ||
    !input ||
    !(input.body instanceof ReadableStream) ||
    !["image/jpeg", "image/png", "image/webp"].includes(input.contentType)
  )
    invalid();
  const context = scope(db, actor, siteId, options);
  return context.processing.process(async (signal) => {
    let claim: Claim | undefined;
    try {
      const acquired = await acquire(context, signal, siteId, assetId, false);
      if (!acquired) unavailable();
      if ("result" in acquired)
        return giftMediaFinalizeResponseSchema.parse({
          media: acquired.result,
        });
      claim = acquired;
      liveClaim(context, signal, claim.row);
      if (
        input.contentType !== claim.row.declaredContentType ||
        (input.contentLength !== undefined &&
          input.contentLength !== claim.row.declaredByteLength)
      )
        throw new GiftImageDecodeError();
      const declaredByteLength = claim.row.declaredByteLength;
      if (declaredByteLength === null) unavailable();
      const bytes = await readBody(input, declaredByteLength, signal);
      context.check(signal);
      if (
        bytes.byteLength !== claim.row.declaredByteLength ||
        hash(bytes) !== claim.bound.original
      )
        throw new GiftImageDecodeError();
      const originalBinding = claim.bound;
      await fenced(context, signal, claim, false, async (_tx, row, intent) => ({
        row,
        intent,
        bound: originalBinding,
      }));
      const decode = context.options.decode ?? decodeGiftImage;
      liveClaim(context, signal, claim.row);
      const observed = await decode(new Uint8Array(bytes), input.contentType, {
        signal,
      });
      context.check(signal);
      const {
        bytes: produced,
        contentType,
        byteLength,
        width,
        height,
      } = observed;
      context.check(signal);
      if (
        !(produced instanceof Uint8Array) ||
        produced.byteLength !== byteLength ||
        byteLength < 1 ||
        byteLength > maxBytes
      )
        throw new GiftImageDecodeError();
      const decoded = {
        bytes: Buffer.from(produced),
        contentType,
        byteLength,
        width,
        height,
      };
      context.check(signal);
      claim = await pin(context, signal, claim, bytes, decoded);
      const pinnedBinding = claim.bound;
      await fenced(context, signal, claim, false, async (_tx, row, intent) => ({
        row,
        intent,
        bound: pinnedBinding,
      }));
      const publish = context.storage.publishDerivative;
      liveClaim(context, signal, claim.row);
      try {
        const published = await publish.call(
          context.storage,
          claim.intent.derivativeKey,
          decoded.bytes,
          signal,
        );
        context.check(signal);
        if (published.url !== claim.row.publicUrl) unavailable();
      } catch (error) {
        context.check(signal);
        if (!(error instanceof GiftMediaStorageError) || error.status !== 412)
          throw error;
        await exactReadback(context, signal, claim);
      }
      const media = await associate(context, signal, claim, false);
      return giftMediaFinalizeResponseSchema.parse({ media });
    } catch (error) {
      if (claim && error instanceof GiftImageDecodeError) {
        try {
          await seal(context, signal, claim.row);
        } catch (closeError) {
          throw sanitize(closeError);
        }
      }
      throw sanitize(error);
    }
  }, input.signal);
}
export async function recoverGiftMediaUpload(
  db: GiftDatabase,
  actor: SiteAccessActor,
  siteId: string,
  assetId: string,
  options: GiftMediaServiceOptions = {},
  signal?: AbortSignal,
): Promise<GiftMediaStatusResponse> {
  if (!giftMediaPublicAssetSchema.shape.id.safeParse(assetId).success)
    invalid();
  const context = scope(db, actor, siteId, options);
  return context.processing.process(async (ownedSignal) => {
    let claim: Claim | undefined;
    const acquired = await acquire(context, ownedSignal, siteId, assetId, true);
    if (acquired && !("result" in acquired)) claim = acquired;
    if (!claim) {
      const row = await context.locked(ownedSignal, async (tx) =>
        readAsset(tx, siteId, assetId),
      );
      if (
        binding(row)?.phase === "expected" &&
        compareDatabaseTimestamps(row.expiresAt, clock(context.options)) <= 0
      )
        await seal(context, ownedSignal, row, true);
      return consultation(context, ownedSignal, siteId, assetId);
    }
    try {
      await exactReadback(context, ownedSignal, claim, true);
      await associate(context, ownedSignal, claim, true);
    } catch (error) {
      context.check(ownedSignal);
      if (
        error instanceof SiteAccessDeniedError ||
        error instanceof AdminSessionRequiredError ||
        error instanceof GiftServiceError
      )
        throw error;
    }
    return consultation(context, ownedSignal, siteId, assetId);
  }, signal);
}
