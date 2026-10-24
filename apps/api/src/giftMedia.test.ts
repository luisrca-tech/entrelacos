import { createHash } from "node:crypto";
import type { ReceivingReadiness } from "@entrelacos/contracts";
import {
  giftMediaAsset,
  giftMediaPublicationIntent,
} from "@entrelacos/database/schema";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { databaseTimestampEpochMicroseconds } from "./databaseTimestamp";
import {
  GiftImageDecodeError,
  GiftImageProcessingError,
} from "./giftImageDecoder";
import {
  consultGiftMediaUpload,
  createGiftMediaProcessing,
  finalizeGiftMediaUpload,
  issueGiftMediaUpload,
  recoverGiftMediaUpload,
} from "./giftMedia";
import {
  type GiftMediaStorage,
  GiftMediaStorageError,
} from "./giftMediaStorage";
import { requireSiteCapability, SiteAccessDeniedError } from "./siteAccess";

vi.mock("./siteAccess", async (original) => ({
  ...(await original<typeof import("./siteAccess")>()),
  requireSiteCapability: vi.fn(),
}));

const siteId = "site-a";
const assetId = "asset-a";
const actor = { userId: "assistant-a", role: "SITE_ASSISTANT" as const };
const initialTime = new Date("2026-10-12T12:00:00.000Z");
const raw = new Uint8Array([1, 2, 3]);
const derivative = new Uint8Array([5, 6]);
const sha = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const input = {
  contentType: "image/png" as const,
  byteLength: raw.length,
  contentSha256: sha(raw),
};
const expectedTag = `inline-v1:expected:${input.contentSha256}`;
const verifiedTag = `inline-v1:verified:${input.contentSha256}:${sha(derivative)}`;
const closedTag = `inline-v1:closed:${input.contentSha256}`;
const pendingAsset = {
  id: assetId,
  siteId,
  stagingKey: "inline-v1/site-a/asset-a/nonce-a",
  declaredContentType: input.contentType,
  declaredByteLength: input.byteLength,
  processingId: null,
  processingExpiresAt: null,
  expiresAt: new Date(initialTime.getTime() + 300_000),
  stableObjectVersion: expectedTag,
  state: "PENDING",
  derivativeKey: null,
  publicUrl: null,
  contentType: null,
  byteLength: null,
  width: null,
  height: null,
  createdAt: initialTime,
  updatedAt: initialTime,
};
const decoded = {
  bytes: derivative,
  contentType: "image/webp" as const,
  byteLength: derivative.length,
  width: 1200,
  height: 800,
};
const dialect = new PgDialect();
const processors: ReturnType<typeof createGiftMediaProcessing>[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const camel = (value: string) =>
  value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
function comparable(field: string, value: unknown): unknown {
  if (value === null) return null;
  return /At$/.test(field) ? databaseTimestampEpochMicroseconds(value) : value;
}
function fixture(initial: Record<string, unknown> | null = pendingAsset) {
  let row = initial ? structuredClone(initial) : null;
  let intents: Record<string, unknown>[] = [];
  let now = new Date(initialTime);
  let depth = 0;
  let sequence = 0;
  let previous = Promise.resolve();
  const queries: ReturnType<PgDialect["sqlToQuery"]>[] = [];
  const hooks = {
    beforeQuery: undefined as
      | undefined
      | ((query: ReturnType<PgDialect["sqlToQuery"]>) => Promise<void>),
    afterCommit: undefined as undefined | (() => Promise<void>),
  };
  function matches(
    where: string,
    value: Record<string, unknown>,
    params: unknown[],
  ): boolean {
    for (const match of where.matchAll(
      /(?:(a)\.)?([a-z_]+)\s+(IS NOT DISTINCT FROM|=|>|<=)\s+\$(\d+)(?:::timestamptz)?/gi,
    )) {
      const field = camel(match[2]);
      const target = match[1] ? row : value;
      if (!target) return false;
      const left = comparable(field, target[field]);
      const right = comparable(field, params[Number(match[4]) - 1]);
      if (
        (match[3] === "=" ||
          match[3].toUpperCase() === "IS NOT DISTINCT FROM") &&
        left !== right
      )
        return false;
      if (match[3] === ">" && !((left as bigint) > (right as bigint)))
        return false;
      if (match[3] === "<=" && !((left as bigint) <= (right as bigint)))
        return false;
    }
    return true;
  }
  const execute = vi.fn(async (statement) => {
    const query = dialect.sqlToQuery(statement);
    queries.push(query);
    await hooks.beforeQuery?.(query);
    const text = query.sql.trim();
    if (/^SELECT[\s\S]*FROM site WHERE/i.test(text))
      return { rows: [{ id: siteId }] };
    if (/^SELECT[\s\S]*FROM site s/i.test(text))
      return {
        rows: [
          {
            id: siteId,
            lifecycle: "ACTIVE",
            publicationState: "PUBLISHED",
            isDemo: false,
            startsOn: "2026-01-01",
            endsOn: "2027-01-01",
          },
        ],
      };
    if (/^SELECT[\s\S]*FROM gift_media_asset/i.test(text))
      return {
        rows:
          row && row.siteId === query.params[0] && row.id === query.params[1]
            ? [structuredClone(row)]
            : [],
      };
    if (/^SELECT[\s\S]*FROM gift_media_publication_intent/i.test(text))
      return {
        rows: structuredClone(
          intents.filter(
            (value) =>
              value.siteId === query.params[0] &&
              value.assetId === query.params[1],
          ),
        ),
      };
    if (/^UPDATE gift_media_(asset|publication_intent)/i.test(text)) {
      const values = /^UPDATE gift_media_asset/i.test(text)
        ? row
          ? [row]
          : []
        : intents;
      const set = text.slice(
        text.indexOf(" SET ") + 5,
        text.indexOf(" WHERE "),
      );
      const where = text.slice(text.indexOf(" WHERE ") + 7);
      const updated = values.filter((value) =>
        matches(where, value, query.params),
      );
      for (const value of updated) {
        for (const part of set.matchAll(
          /([a-z_]+)\s*=\s*(?:\$(\d+)(?:::[a-z_]+)?|'([^']*)'|(NULL))/gi,
        )) {
          value[camel(part[1])] = part[2]
            ? query.params[Number(part[2]) - 1]
            : part[4]
              ? null
              : part[3];
        }
      }
      return { rows: updated.map((value) => ({ id: value.id })) };
    }
    throw new Error("Unsupported synthetic SQL statement");
  });
  const db = {
    execute,
    insert: vi.fn((table) => ({
      values: vi.fn(async (value) => {
        if (table === giftMediaAsset) row = structuredClone(value);
        else if (table === giftMediaPublicationIntent)
          intents.push(structuredClone(value));
        else throw new Error("Unexpected table");
      }),
    })),
    transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) => {
      const waiting = previous;
      const released = deferred<void>();
      previous = released.promise;
      await waiting;
      const snapshot = structuredClone(row);
      const oldIntents = structuredClone(intents);
      depth++;
      let result: unknown;
      try {
        result = await operation(db);
      } catch (error) {
        row = snapshot;
        intents = oldIntents;
        throw error;
      } finally {
        depth--;
        released.resolve();
      }
      await hooks.afterCommit?.();
      return result;
    }),
  };
  const outside = () => expect(depth).toBe(0);
  const storage = {
    storageNamespace: "existing-gifts",
    getDerivativeUrl: vi.fn<GiftMediaStorage["getDerivativeUrl"]>(
      (key) => `https://media.example.test/${key}`,
    ),
    headDerivative: vi.fn<GiftMediaStorage["headDerivative"]>(async () => {
      outside();
      return {
        etag: '"original"',
        byteLength: derivative.length,
        contentType: "image/webp" as const,
      };
    }),
    readDerivative: vi.fn<GiftMediaStorage["readDerivative"]>(async () => {
      outside();
      return new Uint8Array(derivative);
    }),
    publishDerivative: vi.fn<GiftMediaStorage["publishDerivative"]>(
      async (key) => {
        outside();
        return { url: `https://media.example.test/${key}` };
      },
    ),
    close: vi.fn<GiftMediaStorage["close"]>(async () => {}),
  };
  const decode = vi.fn(async () => {
    outside();
    return { ...decoded, bytes: new Uint8Array(derivative) };
  });
  const processing = createGiftMediaProcessing();
  processors.push(processing);
  const readiness: ReceivingReadiness = {
    siteId,
    state: "READY",
    reason: null,
    catalogEligible: true,
    observedAt: initialTime.toISOString(),
    destinationVersion: 1,
    mode: "sandbox",
  };
  const options = {
    storage,
    storageNamespace: "existing-gifts",
    decode,
    processing,
    authorize: vi.fn(async () => ({ ...actor })),
    readReadiness: vi.fn(async () => ({ ...readiness })),
    now: () => new Date(now),
    generateId: () => `generated-${++sequence}`,
  };
  const pulls = vi.fn();
  function binary(selected = raw, patch = {}) {
    let sent = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls();
          if (!sent) {
            sent = true;
            controller.enqueue(selected);
          } else controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    return { body, contentType: input.contentType, ...patch };
  }
  return {
    db: db as never,
    execute,
    transaction: db.transaction,
    options,
    storage,
    decode,
    pulls,
    binary,
    hooks,
    row: () => row as Record<string, unknown>,
    intents: () => intents,
    setIntents: (value: Record<string, unknown>[]) => {
      intents = structuredClone(value);
    },
    setNow: (value: Date) => {
      now = new Date(value);
    },
    setRow: (value: Record<string, unknown>) => {
      row = structuredClone(value);
    },
  };
}
function claim(f: ReturnType<typeof fixture>, phase = "UNKNOWN") {
  const processingId = "original-claim";
  const key = `gifts/site-a/asset-a/${processingId}.webp`;
  f.setRow({
    ...pendingAsset,
    createdAt: new Date(initialTime.getTime() - 60_000),
    expiresAt: new Date(initialTime.getTime() + 240_000),
    state: "PROCESSING",
    processingId,
    processingExpiresAt: new Date(initialTime.getTime() - 1),
    stableObjectVersion: phase === "REQUESTED" ? expectedTag : verifiedTag,
    ...(phase === "REQUESTED"
      ? {}
      : {
          derivativeKey: key,
          publicUrl: `https://media.example.test/${key}`,
          ...decoded,
          bytes: undefined,
        }),
  });
  f.setIntents([
    {
      id: "intent-a",
      siteId,
      assetId,
      processingId,
      storageNamespace: "existing-gifts",
      derivativeKey: key,
      state: phase,
      createdAt: initialTime,
      observedAt: phase === "REQUESTED" ? null : initialTime,
    },
  ]);
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireSiteCapability)
    .mockReset()
    .mockResolvedValue({} as never);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Real network forbidden");
    }),
  );
});
afterEach(async () => {
  await Promise.all(processors.splice(0).map((value) => value.close()));
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("inline media immutable lease and native gates", () => {
  it.each(["update", "commit"])(
    "does not pull after acquisition %s crosses upload expiry",
    async (boundary) => {
      const f = fixture();
      if (boundary === "update")
        f.hooks.beforeQuery = async (query) => {
          if (
            /^UPDATE gift_media_asset SET state/.test(query.sql.trim()) &&
            query.params[0] === "PROCESSING"
          ) {
            f.hooks.beforeQuery = undefined;
            f.setNow(new Date(initialTime.getTime() + 300_001));
          }
        };
      else
        f.hooks.afterCommit = async () => {
          f.hooks.afterCommit = undefined;
          f.setNow(new Date(initialTime.getTime() + 300_001));
        };
      await expect(
        finalizeGiftMediaUpload(
          f.db,
          actor,
          siteId,
          assetId,
          f.binary(),
          f.options,
        ),
      ).rejects.toBeInstanceOf(Error);
      expect(f.pulls).not.toHaveBeenCalled();
      expect(f.decode).not.toHaveBeenCalled();
      expect(f.storage.publishDerivative).not.toHaveBeenCalled();
    },
  );
  it("does not dispatch decode after its fenced transaction acknowledgement expires", async () => {
    const f = fixture();
    let commits = 0;
    f.hooks.afterCommit = async () => {
      if (++commits === 2) f.setNow(new Date(initialTime.getTime() + 60_001));
    };
    await expect(
      finalizeGiftMediaUpload(
        f.db,
        actor,
        siteId,
        assetId,
        f.binary(),
        f.options,
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(f.decode).not.toHaveBeenCalled();
    expect(f.row().stableObjectVersion).toBe(expectedTag);
  });
  it.each([60_001, 300_001])(
    "does not dispatch PUT after its getter crosses a lease boundary (%s)",
    async (offset) => {
      const f = fixture();
      const publish = f.storage.publishDerivative;
      Object.defineProperty(f.storage, "publishDerivative", {
        get() {
          f.setNow(new Date(initialTime.getTime() + offset));
          return publish;
        },
      });
      await expect(
        finalizeGiftMediaUpload(
          f.db,
          actor,
          siteId,
          assetId,
          f.binary(),
          f.options,
        ),
      ).rejects.toBeInstanceOf(Error);
      expect(publish).not.toHaveBeenCalled();
      expect(f.row().stableObjectVersion).toBe(verifiedTag);
      expect(f.intents()[0].state).toBe("UNKNOWN");
    },
  );
  it.each(["headDerivative", "readDerivative"] as const)(
    "does not dispatch recovery %s after its getter expires the renewed lease",
    async (port) => {
      const f = fixture();
      claim(f);
      const selected = f.storage[port];
      Object.defineProperty(f.storage, port, {
        get() {
          f.setNow(new Date(initialTime.getTime() + 60_001));
          return selected;
        },
      });
      await expect(
        recoverGiftMediaUpload(f.db, actor, siteId, assetId, f.options),
      ).resolves.toMatchObject({ status: { state: "UNKNOWN", media: null } });
      expect(selected).not.toHaveBeenCalled();
      expect(f.intents()[0].state).toBe("UNKNOWN");
    },
  );
  it("owns body cancellation and unlock when bounded allocation fails", async () => {
    const f = fixture();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      { cancel },
      { highWaterMark: 0 },
    );
    const allocation = vi.spyOn(Buffer, "alloc").mockImplementationOnce(() => {
      throw new RangeError("Allocation failed");
    });
    try {
      await expect(
        finalizeGiftMediaUpload(
          f.db,
          actor,
          siteId,
          assetId,
          { body, contentType: "image/png" },
          f.options,
        ),
      ).rejects.toMatchObject({ status: 503 });
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
      expect(f.row().stableObjectVersion).toBe(expectedTag);
      expect(f.storage.publishDerivative).not.toHaveBeenCalled();
    } finally {
      allocation.mockRestore();
    }
  });
  it("uses the existing locked transaction for the native authorization recheck", async () => {
    const f = fixture();
    const targets: unknown[][] = [];
    f.options.authorize.mockImplementation(async (...args: unknown[]) => {
      targets.push(args);
      return { ...actor };
    });
    await consultGiftMediaUpload(f.db, actor, siteId, assetId, f.options);
    expect(targets.some((args) => args[0] === f.db)).toBe(true);
  });
  it("does not seal valid input because the storage URL port is misconfigured", async () => {
    const f = fixture();
    f.storage.getDerivativeUrl.mockReturnValue(
      "https://media.example.test/staging/site-a/asset-a/raw",
    );
    await expect(
      finalizeGiftMediaUpload(
        f.db,
        actor,
        siteId,
        assetId,
        f.binary(),
        f.options,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.row().stableObjectVersion).toBe(expectedTag);
    expect(f.intents()[0].state).toBe("REQUESTED");
    expect(f.storage.publishDerivative).not.toHaveBeenCalled();
  });
  it.each([
    { width: 2049 },
    { width: 0 },
    { height: 0 },
    { height: 2049 },
    { contentType: "image/png" },
    { byteLength: 1 },
    { bytes: new Uint8Array(5_242_881), byteLength: 5_242_881 },
  ])(
    "denies invalid actual derivative limits before arming/publication",
    async (patch) => {
      const f = fixture();
      f.decode.mockResolvedValueOnce({ ...decoded, ...patch } as never);
      await expect(
        finalizeGiftMediaUpload(
          f.db,
          actor,
          siteId,
          assetId,
          f.binary(),
          f.options,
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(f.storage.publishDerivative).not.toHaveBeenCalled();
      expect(f.row().stableObjectVersion).not.toBe(verifiedTag);
    },
  );
  it("issues only a hashed private inline lease without raw signing or remote I/O", async () => {
    const f = fixture(null);
    const value = await issueGiftMediaUpload(
      f.db,
      actor,
      siteId,
      input,
      f.options,
    );
    expect(value).toEqual({
      upload: { id: "generated-1", expiresAt: "2026-10-12T12:05:00.000Z" },
    });
    expect(f.row()).toMatchObject({
      state: "PENDING",
      stableObjectVersion: expectedTag,
      declaredByteLength: 3,
      processingId: null,
    });
    expect(f.row().stagingKey).toMatch(
      /^inline-v1\/site-a\/generated-1\/[A-Za-z0-9_-]+$/,
    );
    expect(f.storage.publishDerivative).not.toHaveBeenCalled();
    expect(f.decode).not.toHaveBeenCalled();
  });
  it.each([
    { contentSha256: undefined },
    { contentSha256: "A".repeat(64) },
    { byteLength: 0 },
    { byteLength: 5_242_881 },
    { contentType: "image/svg+xml" },
    { extra: true },
  ])("denies invalid metadata %j without inserting", async (patch) => {
    const f = fixture(null);
    await expect(
      issueGiftMediaUpload(
        f.db,
        actor,
        siteId,
        { ...input, ...patch } as never,
        f.options,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(f.row()).toBeNull();
  });
  it("consults without claim, body, decode, SDK or write", async () => {
    const f = fixture();
    const before = structuredClone(f.row());
    await expect(
      consultGiftMediaUpload(f.db, actor, siteId, assetId, f.options),
    ).resolves.toEqual({
      status: {
        siteId,
        assetId,
        state: "PENDING",
        expiresAt: "2026-10-12T12:05:00.000Z",
        canRetrySameBytes: true,
        media: null,
      },
    });
    expect(f.row()).toEqual(before);
    expect(f.decode).not.toHaveBeenCalled();
    expect(f.storage.headDerivative).not.toHaveBeenCalled();
    expect(f.storage.publishDerivative).not.toHaveBeenCalled();
    expect(
      f.execute.mock.calls.some(([statement]) =>
        /^UPDATE/.test(dialect.sqlToQuery(statement).sql.trim()),
      ),
    ).toBe(false);
  });
  it.each(["native", "membership", "readiness", "storage", "processing"])(
    "denies %s before pulling raw bytes",
    async (gate) => {
      const f = fixture();
      if (gate === "native")
        f.options.authorize.mockResolvedValueOnce({
          ...actor,
          userId: "another-user",
        });
      if (gate === "membership")
        vi.mocked(requireSiteCapability).mockRejectedValueOnce(
          new SiteAccessDeniedError(),
        );
      if (gate === "readiness")
        f.options.readReadiness.mockResolvedValueOnce({
          siteId,
          state: "NOT_READY",
        } as never);
      if (gate === "storage") f.options.storageNamespace = "other-bucket";
      if (gate === "processing") f.options.processing = undefined as never;
      await expect(
        finalizeGiftMediaUpload(
          f.db,
          actor,
          siteId,
          assetId,
          f.binary(),
          f.options,
        ),
      ).rejects.toBeInstanceOf(Error);
      expect(f.pulls).not.toHaveBeenCalled();
      expect(f.decode).not.toHaveBeenCalled();
      expect(f.storage.publishDerivative).not.toHaveBeenCalled();
    },
  );
  it("commits complete immutable verified result and UNKNOWN before the first PUT", async () => {
    const f = fixture();
    f.storage.publishDerivative.mockImplementationOnce(async (key) => {
      expect(f.row()).toMatchObject({
        state: "PROCESSING",
        stableObjectVersion: verifiedTag,
        derivativeKey: key,
        publicUrl: `https://media.example.test/${key}`,
        contentType: "image/webp",
        byteLength: 2,
        width: 1200,
        height: 800,
      });
      expect(f.intents()).toHaveLength(1);
      expect(f.intents()[0]).toMatchObject({
        state: "UNKNOWN",
        derivativeKey: key,
        storageNamespace: "existing-gifts",
      });
      return { url: `https://media.example.test/${key}` };
    });
    const result = await finalizeGiftMediaUpload(
      f.db,
      actor,
      siteId,
      assetId,
      f.binary(),
      f.options,
    );
    expect(result.media).toMatchObject({
      id: assetId,
      siteId,
      contentType: "image/webp",
      byteLength: 2,
      width: 1200,
      height: 800,
    });
    expect(f.row()).toMatchObject({
      state: "FINALIZED",
      stableObjectVersion: verifiedTag,
      processingId: null,
    });
    expect(f.intents()[0].state).toBe("ASSOCIATED");
    expect(f.storage.headDerivative).not.toHaveBeenCalled();
  });
  it("returns positive FINALIZED canonical media without pulling, decoding or republishing", async () => {
    const f = fixture();
    const first = await finalizeGiftMediaUpload(
      f.db,
      actor,
      siteId,
      assetId,
      f.binary(),
      f.options,
    );
    f.pulls.mockClear();
    f.decode.mockClear();
    f.storage.publishDerivative.mockClear();
    await expect(
      finalizeGiftMediaUpload(
        f.db,
        actor,
        siteId,
        assetId,
        f.binary(),
        f.options,
      ),
    ).resolves.toEqual(first);
    expect(f.pulls).not.toHaveBeenCalled();
    expect(f.decode).not.toHaveBeenCalled();
    expect(f.storage.publishDerivative).not.toHaveBeenCalled();
    await expect(
      consultGiftMediaUpload(f.db, actor, siteId, assetId, f.options),
    ).resolves.toMatchObject({
      status: {
        state: "FINALIZED",
        canRetrySameBytes: false,
        media: first.media,
      },
    });
  });
  it.each(["hash", "mime", "length", "decoder"])(
    "seals proven unarmed invalid %s and never re-arms it",
    async (fault) => {
      const f = fixture();
      if (fault === "decoder")
        f.decode.mockRejectedValueOnce(new GiftImageDecodeError());
      const selected =
        fault === "hash"
          ? new Uint8Array([3, 2, 1])
          : fault === "length"
            ? new Uint8Array([1, 2])
            : raw;
      await expect(
        finalizeGiftMediaUpload(
          f.db,
          actor,
          siteId,
          assetId,
          f.binary(
            selected,
            fault === "mime" ? { contentType: "image/jpeg" } : {},
          ),
          f.options,
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(f.row()).toMatchObject({
        state: "FAILED",
        stableObjectVersion: closedTag,
      });
      expect(f.intents()[0].state).toBe("ORPHANED");
      expect(f.storage.publishDerivative).not.toHaveBeenCalled();
      await expect(
        consultGiftMediaUpload(f.db, actor, siteId, assetId, f.options),
      ).resolves.toMatchObject({
        status: { state: "FAILED", canRetrySameBytes: false, media: null },
      });
      await expect(
        finalizeGiftMediaUpload(
          f.db,
          actor,
          siteId,
          assetId,
          f.binary(),
          f.options,
        ),
      ).rejects.toBeInstanceOf(Error);
      expect(f.storage.publishDerivative).not.toHaveBeenCalled();
    },
  );
  it("retains a transient unarmed original claim without falsely sealing it", async () => {
    const f = fixture();
    f.decode.mockRejectedValueOnce(new GiftImageProcessingError());
    await expect(
      finalizeGiftMediaUpload(
        f.db,
        actor,
        siteId,
        assetId,
        f.binary(),
        f.options,
      ),
    ).rejects.toMatchObject({ status: 503 });
    const original = f.row().processingId;
    expect(f.row().stableObjectVersion).toBe(expectedTag);
    expect(f.intents()[0].state).toBe("REQUESTED");
    f.setNow(new Date(initialTime.getTime() + 60_001));
    await expect(
      consultGiftMediaUpload(f.db, actor, siteId, assetId, f.options),
    ).resolves.toMatchObject({
      status: { state: "PENDING", canRetrySameBytes: true },
    });
    await finalizeGiftMediaUpload(
      f.db,
      actor,
      siteId,
      assetId,
      f.binary(),
      f.options,
    );
    expect(f.intents()).toHaveLength(1);
    expect(f.intents()[0].processingId).toBe(original);
  });
  it("retains irreversible UNKNOWN and pinned results after uncertain PUT", async () => {
    const f = fixture();
    f.storage.publishDerivative.mockRejectedValueOnce(
      new Error("private provider ACK"),
    );
    await expect(
      finalizeGiftMediaUpload(
        f.db,
        actor,
        siteId,
        assetId,
        f.binary(),
        f.options,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.row()).toMatchObject({
      state: "PROCESSING",
      stableObjectVersion: verifiedTag,
    });
    expect(f.intents()[0].state).toBe("UNKNOWN");
    await expect(
      consultGiftMediaUpload(f.db, actor, siteId, assetId, f.options),
    ).resolves.toMatchObject({
      status: { state: "UNKNOWN", canRetrySameBytes: false, media: null },
    });
  });
  it("does not let a later pre-dispatch failure erase older possible-PUT history", async () => {
    const f = fixture();
    claim(f);
    f.decode.mockRejectedValueOnce(new GiftImageDecodeError());
    const before = structuredClone(f.intents());
    await expect(
      finalizeGiftMediaUpload(
        f.db,
        actor,
        siteId,
        assetId,
        f.binary(),
        f.options,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(f.row().stableObjectVersion).toBe(verifiedTag);
    expect(f.intents()).toEqual(before);
    expect(f.storage.publishDerivative).not.toHaveBeenCalled();
  });
  it.each(["input", "derivative", "width", "namespace", "url"])(
    "denies changed immutable %s during explicit original retry",
    async (fault) => {
      const f = fixture();
      claim(f);
      const original = structuredClone(f.row());
      if (fault === "derivative")
        f.decode.mockResolvedValueOnce({
          ...decoded,
          bytes: new Uint8Array([6, 5]),
        });
      if (fault === "width")
        f.decode.mockResolvedValueOnce({ ...decoded, width: 1199 });
      if (fault === "namespace") f.intents()[0].storageNamespace = "old-bucket";
      if (fault === "url")
        f.storage.getDerivativeUrl.mockReturnValue(
          "https://other.example.test/gifts/site-a/asset-a/original-claim.webp",
        );
      await expect(
        finalizeGiftMediaUpload(
          f.db,
          actor,
          siteId,
          assetId,
          f.binary(fault === "input" ? new Uint8Array([3, 2, 1]) : raw),
          f.options,
        ),
      ).rejects.toBeInstanceOf(Error);
      expect(f.row().stableObjectVersion).toBe(original.stableObjectVersion);
      expect(f.row().derivativeKey).toBe(original.derivativeKey);
      expect(f.intents()).toHaveLength(1);
      expect(f.storage.publishDerivative).not.toHaveBeenCalled();
    },
  );
  it("explicit same-byte retry uses the original immutable key and does not allocate a second claim", async () => {
    const f = fixture();
    claim(f);
    const original = structuredClone(f.intents()[0]);
    await finalizeGiftMediaUpload(
      f.db,
      actor,
      siteId,
      assetId,
      f.binary(),
      f.options,
    );
    expect(f.intents()).toHaveLength(1);
    expect(f.intents()[0].processingId).toBe(original.processingId);
    expect(f.storage.publishDerivative.mock.calls[0][0]).toBe(
      original.derivativeKey,
    );
  });
  it.each([false, true])(
    "412 requires complete positive original readback, match=%s",
    async (match) => {
      const f = fixture();
      claim(f);
      f.storage.publishDerivative.mockRejectedValueOnce(
        new GiftMediaStorageError(412, "GIFT_MEDIA_CONFLICT"),
      );
      if (!match)
        f.storage.readDerivative.mockResolvedValueOnce(new Uint8Array([0, 0]));
      const result = finalizeGiftMediaUpload(
        f.db,
        actor,
        siteId,
        assetId,
        f.binary(),
        f.options,
      );
      if (match) await expect(result).resolves.toHaveProperty("media");
      else await expect(result).rejects.toBeInstanceOf(Error);
      expect(f.storage.readDerivative).toHaveBeenCalledTimes(1);
      expect(f.intents()[0].state).toBe(match ? "ASSOCIATED" : "UNKNOWN");
    },
  );
});

describe("original-target status and explicit recovery", () => {
  it.each(["expected", "closed"])(
    "does not infer a safe %s phase from contradictory partial result fields",
    async (phase) => {
      const f = fixture();
      claim(f, "REQUESTED");
      f.row().width = 1200;
      if (phase === "closed") {
        f.row().state = "FAILED";
        f.row().stableObjectVersion = closedTag;
        f.intents()[0].state = "ORPHANED";
      }
      await expect(
        consultGiftMediaUpload(f.db, actor, siteId, assetId, f.options),
      ).resolves.toMatchObject({
        status: { state: "UNKNOWN", canRetrySameBytes: false },
      });
      await expect(
        finalizeGiftMediaUpload(
          f.db,
          actor,
          siteId,
          assetId,
          f.binary(),
          f.options,
        ),
      ).rejects.toBeInstanceOf(Error);
      expect(f.pulls).not.toHaveBeenCalled();
      expect(f.storage.publishDerivative).not.toHaveBeenCalled();
      expect(f.row().width).toBe(1200);
    },
  );
  it.each(["FAILED", "EXPIRED", "PENDING"])(
    "uncertain retained history dominates ordinary asset %s",
    async (state) => {
      const f = fixture();
      claim(f);
      f.row().state = state;
      await expect(
        consultGiftMediaUpload(f.db, actor, siteId, assetId, f.options),
      ).resolves.toMatchObject({
        status: { state: "UNKNOWN", canRetrySameBytes: false, media: null },
      });
      expect(f.storage.headDerivative).not.toHaveBeenCalled();
    },
  );
  it("RECOVER after upload expiry reads exact original bytes and associates without decode/PUT", async () => {
    const f = fixture();
    claim(f);
    f.setNow(new Date(initialTime.getTime() + 300_001));
    const result = await recoverGiftMediaUpload(
      f.db,
      actor,
      siteId,
      assetId,
      f.options,
    );
    expect(result.status).toMatchObject({
      state: "FINALIZED",
      canRetrySameBytes: false,
      media: { id: assetId, siteId },
    });
    expect(f.storage.headDerivative).toHaveBeenCalledWith(
      "gifts/site-a/asset-a/original-claim.webp",
      expect.any(AbortSignal),
    );
    expect(f.storage.readDerivative).toHaveBeenCalledWith(
      "gifts/site-a/asset-a/original-claim.webp",
      '"original"',
      2,
      expect.any(AbortSignal),
    );
    expect(f.decode).not.toHaveBeenCalled();
    expect(f.storage.publishDerivative).not.toHaveBeenCalled();
    expect(f.intents()).toHaveLength(1);
  });
  it.each(["404", "mismatch", "wrong-mime", "wrong-length", "unavailable"])(
    "RECOVER retains UNKNOWN on %s with no new identity",
    async (fault) => {
      const f = fixture();
      claim(f);
      f.setNow(new Date(initialTime.getTime() + 300_001));
      const original = structuredClone(f.intents()[0]);
      if (fault === "404")
        f.storage.headDerivative.mockRejectedValueOnce(
          new GiftMediaStorageError(404, "GIFT_MEDIA_NOT_FOUND"),
        );
      if (fault === "mismatch")
        f.storage.readDerivative.mockResolvedValueOnce(new Uint8Array([0, 0]));
      if (fault === "wrong-mime")
        f.storage.headDerivative.mockResolvedValueOnce({
          etag: '"original"',
          byteLength: 2,
          contentType: "image/png",
        } as never);
      if (fault === "wrong-length")
        f.storage.headDerivative.mockResolvedValueOnce({
          etag: '"original"',
          byteLength: 1,
          contentType: "image/webp",
        });
      if (fault === "unavailable")
        f.storage.headDerivative.mockRejectedValueOnce(
          new Error("secret object URL"),
        );
      await expect(
        recoverGiftMediaUpload(f.db, actor, siteId, assetId, f.options),
      ).resolves.toMatchObject({
        status: { state: "UNKNOWN", canRetrySameBytes: false, media: null },
      });
      expect(f.intents()).toHaveLength(1);
      expect(f.intents()[0].processingId).toBe(original.processingId);
      expect(f.intents()[0].derivativeKey).toBe(original.derivativeKey);
      expect(f.decode).not.toHaveBeenCalled();
      expect(f.storage.publishDerivative).not.toHaveBeenCalled();
    },
  );
  it("denies binary after original upload expiry without reading or PUT", async () => {
    const f = fixture();
    claim(f);
    f.setNow(new Date(initialTime.getTime() + 300_001));
    await expect(
      finalizeGiftMediaUpload(
        f.db,
        actor,
        siteId,
        assetId,
        f.binary(),
        f.options,
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(f.pulls).not.toHaveBeenCalled();
    expect(f.decode).not.toHaveBeenCalled();
    expect(f.storage.publishDerivative).not.toHaveBeenCalled();
    expect(f.row().stableObjectVersion).toBe(verifiedTag);
  });
  it("known closed lease remains terminal without SDK or re-arm", async () => {
    const f = fixture();
    claim(f, "REQUESTED");
    f.row().state = "FAILED";
    f.row().stableObjectVersion = closedTag;
    f.intents()[0].state = "ORPHANED";
    await expect(
      recoverGiftMediaUpload(f.db, actor, siteId, assetId, f.options),
    ).resolves.toMatchObject({
      status: { state: "FAILED", canRetrySameBytes: false },
    });
    expect(f.storage.headDerivative).not.toHaveBeenCalled();
    expect(f.storage.publishDerivative).not.toHaveBeenCalled();
    expect(f.row().stableObjectVersion).toBe(closedTag);
  });
  it.each(["PENDING", "PROCESSING", "FAILED", "EXPIRED"])(
    "never adopts or mutates legacy raw rows/history: %s",
    async (state) => {
      const f = fixture({
        ...pendingAsset,
        state,
        stagingKey: "staging/site-a/asset-a/old",
        stableObjectVersion: '"historical-etag"',
      });
      const before = structuredClone(f.row());
      await expect(
        consultGiftMediaUpload(f.db, actor, siteId, assetId, f.options),
      ).resolves.toMatchObject({
        status: { state: "UNKNOWN", canRetrySameBytes: false },
      });
      await expect(
        finalizeGiftMediaUpload(
          f.db,
          actor,
          siteId,
          assetId,
          f.binary(),
          f.options,
        ),
      ).rejects.toBeInstanceOf(Error);
      expect(f.row()).toEqual(before);
      expect(f.storage.publishDerivative).not.toHaveBeenCalled();
      expect(f.pulls).not.toHaveBeenCalled();
    },
  );
  it("lost final commit acknowledgment preserves FINALIZED/ASSOCIATED and later consultation", async () => {
    const f = fixture();
    f.hooks.afterCommit = async () => {
      if (f.row().state === "FINALIZED") {
        f.hooks.afterCommit = undefined;
        throw new Error("commit acknowledgment lost");
      }
    };
    await expect(
      finalizeGiftMediaUpload(
        f.db,
        actor,
        siteId,
        assetId,
        f.binary(),
        f.options,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.row().state).toBe("FINALIZED");
    expect(f.intents()[0].state).toBe("ASSOCIATED");
    await expect(
      consultGiftMediaUpload(f.db, actor, siteId, assetId, f.options),
    ).resolves.toMatchObject({ status: { state: "FINALIZED" } });
  });
  it("lost close acknowledgment never returns known terminal failure from the binary response", async () => {
    const f = fixture();
    f.decode.mockRejectedValueOnce(new GiftImageDecodeError());
    f.hooks.afterCommit = async () => {
      if (f.row().stableObjectVersion === closedTag) {
        f.hooks.afterCommit = undefined;
        throw new Error("close acknowledgment lost");
      }
    };
    await expect(
      finalizeGiftMediaUpload(
        f.db,
        actor,
        siteId,
        assetId,
        f.binary(),
        f.options,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.row().stableObjectVersion).toBe(closedTag);
    await expect(
      consultGiftMediaUpload(f.db, actor, siteId, assetId, f.options),
    ).resolves.toMatchObject({ status: { state: "FAILED" } });
  });
});

describe("processing admission and full lease fencing", () => {
  it.each(["issue", "consult"])(
    "shutdown owns the actual %s database lookup until it settles",
    async (action) => {
      const f = fixture(action === "issue" ? null : pendingAsset);
      const entered = deferred<void>();
      const released = deferred<void>();
      f.hooks.beforeQuery = async (query) => {
        if (/^SELECT[\s\S]*FROM site WHERE/.test(query.sql.trim())) {
          f.hooks.beforeQuery = undefined;
          entered.resolve();
          await released.promise;
        }
      };
      const result = (
        action === "issue"
          ? issueGiftMediaUpload(f.db, actor, siteId, input, f.options)
          : consultGiftMediaUpload(f.db, actor, siteId, assetId, f.options)
      ).catch((error) => error);
      await entered.promise;
      let closed = false;
      const closing = f.options.processing.close().then(() => {
        closed = true;
      });
      try {
        await Promise.resolve();
        expect(closed).toBe(false);
      } finally {
        released.resolve();
      }
      expect(await result).toMatchObject({ status: 503 });
      await closing;
      expect(closed).toBe(true);
      if (action === "issue") expect(f.row()).toBeNull();
    },
  );
  it("shutdown tracks an actual metadata commit acknowledgment until it settles", async () => {
    const f = fixture(null);
    const entered = deferred<void>();
    const released = deferred<void>();
    f.hooks.afterCommit = async () => {
      f.hooks.afterCommit = undefined;
      entered.resolve();
      await released.promise;
    };
    const result = issueGiftMediaUpload(
      f.db,
      actor,
      siteId,
      input,
      f.options,
    ).catch((error) => error);
    await entered.promise;
    let closed = false;
    const closing = f.options.processing.close().then(() => {
      closed = true;
    });
    try {
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(f.row().state).toBe("PENDING");
    } finally {
      released.resolve();
    }
    expect(await result).toMatchObject({ status: 503 });
    await closing;
    expect(closed).toBe(true);
  });
  it("rolls back pinning if its actual UPDATE settlement crosses the processing expiry", async () => {
    const f = fixture();
    f.hooks.beforeQuery = async (query) => {
      if (
        /^UPDATE gift_media_asset SET stable_object_version/.test(
          query.sql.trim(),
        )
      ) {
        f.hooks.beforeQuery = undefined;
        f.setNow(new Date(initialTime.getTime() + 60_001));
      }
    };
    await expect(
      finalizeGiftMediaUpload(
        f.db,
        actor,
        siteId,
        assetId,
        f.binary(),
        f.options,
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(f.row().stableObjectVersion).toBe(expectedTag);
    expect(f.intents()[0].state).toBe("REQUESTED");
    expect(f.storage.publishDerivative).not.toHaveBeenCalled();
  });
  it("rolls back final association if its UPDATE settlement crosses the processing expiry", async () => {
    const f = fixture();
    f.hooks.beforeQuery = async (query) => {
      if (
        /^UPDATE gift_media_asset SET state/.test(query.sql.trim()) &&
        query.params[0] === "FINALIZED"
      ) {
        f.hooks.beforeQuery = undefined;
        f.setNow(new Date(initialTime.getTime() + 60_001));
      }
    };
    await expect(
      finalizeGiftMediaUpload(
        f.db,
        actor,
        siteId,
        assetId,
        f.binary(),
        f.options,
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(f.row().state).toBe("PROCESSING");
    expect(f.intents()[0].state).toBe("UNKNOWN");
  });
  it("does not pull a body when the asset lock wait outlives upload expiry", async () => {
    const f = fixture();
    f.hooks.beforeQuery = async (query) => {
      if (/^SELECT[\s\S]*FROM gift_media_asset/.test(query.sql.trim())) {
        f.hooks.beforeQuery = undefined;
        f.setNow(new Date(initialTime.getTime() + 300_001));
      }
    };
    await expect(
      finalizeGiftMediaUpload(
        f.db,
        actor,
        siteId,
        assetId,
        f.binary(),
        f.options,
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(f.pulls).not.toHaveBeenCalled();
    expect(f.storage.publishDerivative).not.toHaveBeenCalled();
  });
  it("does not arm UNKNOWN when pinning waits beyond the original processing lease", async () => {
    const f = fixture();
    let reads = 0;
    f.hooks.beforeQuery = async (query) => {
      if (
        /^SELECT[\s\S]*FROM gift_media_asset/.test(query.sql.trim()) &&
        ++reads === 3
      )
        f.setNow(new Date(initialTime.getTime() + 60_001));
    };
    await expect(
      finalizeGiftMediaUpload(
        f.db,
        actor,
        siteId,
        assetId,
        f.binary(),
        f.options,
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(f.row().stableObjectVersion).toBe(expectedTag);
    expect(f.intents()[0].state).toBe("REQUESTED");
    expect(f.storage.publishDerivative).not.toHaveBeenCalled();
  });
  it("an expired old invalid-input catch cannot seal an unrenewed claim", async () => {
    const f = fixture();
    f.decode.mockImplementationOnce(async () => {
      f.setNow(new Date(initialTime.getTime() + 60_001));
      throw new GiftImageDecodeError();
    });
    await expect(
      finalizeGiftMediaUpload(
        f.db,
        actor,
        siteId,
        assetId,
        f.binary(),
        f.options,
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(f.row().stableObjectVersion).toBe(expectedTag);
    expect(f.intents()[0].state).toBe("REQUESTED");
  });
  it("consultation uses the fresh clock after its asset read wait", async () => {
    const f = fixture();
    claim(f, "REQUESTED");
    f.row().processingExpiresAt = new Date(initialTime.getTime() + 60_000);
    f.hooks.beforeQuery = async (query) => {
      if (/^SELECT[\s\S]*FROM gift_media_asset/.test(query.sql.trim())) {
        f.hooks.beforeQuery = undefined;
        f.setNow(new Date(initialTime.getTime() + 60_001));
      }
    };
    await expect(
      consultGiftMediaUpload(f.db, actor, siteId, assetId, f.options),
    ).resolves.toMatchObject({
      status: { state: "PENDING", canRetrySameBytes: true },
    });
  });
  it("snapshots the native derivative before later readiness callbacks can mutate its bytes", async () => {
    const f = fixture();
    const produced = new Uint8Array(derivative);
    f.decode.mockResolvedValueOnce({ ...decoded, bytes: produced });
    f.options.readReadiness.mockImplementation(async () => {
      if (f.row().stableObjectVersion === verifiedTag) produced.fill(0);
      return {
        siteId,
        state: "READY",
        reason: null,
        catalogEligible: true,
        observedAt: initialTime.toISOString(),
        destinationVersion: 1,
        mode: "sandbox",
      };
    });
    await finalizeGiftMediaUpload(
      f.db,
      actor,
      siteId,
      assetId,
      f.binary(),
      f.options,
    );
    expect(produced).toEqual(new Uint8Array([0, 0]));
    expect(Array.from(f.storage.publishDerivative.mock.calls[0][1])).toEqual(
      Array.from(derivative),
    );
    expect(f.row().stableObjectVersion).toBe(verifiedTag);
  });
  it("explicit recovery can positively seal an expired never-armed expectation without SDK", async () => {
    const f = fixture();
    f.setNow(new Date(initialTime.getTime() + 300_001));
    await expect(
      recoverGiftMediaUpload(f.db, actor, siteId, assetId, f.options),
    ).resolves.toMatchObject({
      status: { state: "EXPIRED", canRetrySameBytes: false },
    });
    expect(f.row().stableObjectVersion).toBe(closedTag);
    expect(f.storage.headDerivative).not.toHaveBeenCalled();
    expect(f.storage.publishDerivative).not.toHaveBeenCalled();
  });
  it("rejects a second pipeline before body pull and holds admission until actual decode settles", async () => {
    const f = fixture();
    const waiting = deferred<typeof decoded>();
    const entered = deferred<void>();
    f.decode.mockImplementationOnce(async () => {
      entered.resolve();
      return waiting.promise;
    });
    const abort = new AbortController();
    const first = finalizeGiftMediaUpload(
      f.db,
      actor,
      siteId,
      assetId,
      f.binary(raw, { signal: abort.signal }),
      f.options,
    ).catch((error) => error);
    await entered.promise;
    abort.abort();
    const secondPull = vi.fn();
    const second = new ReadableStream<Uint8Array>(
      {
        pull() {
          secondPull();
        },
      },
      { highWaterMark: 0 },
    );
    try {
      await expect(
        finalizeGiftMediaUpload(
          f.db,
          actor,
          siteId,
          assetId,
          { contentType: "image/png", body: second },
          f.options,
        ),
      ).rejects.toMatchObject({ code: "GIFT_MEDIA_BUSY" });
      expect(secondPull).not.toHaveBeenCalled();
    } finally {
      waiting.resolve(decoded);
    }
    expect(await first).toMatchObject({ status: 503 });
    expect(f.storage.publishDerivative).not.toHaveBeenCalled();
  });
  it("shutdown keeps actual decoder and subsequent DB settlement owned", async () => {
    const f = fixture();
    const waiting = deferred<typeof decoded>();
    const entered = deferred<void>();
    f.decode.mockImplementationOnce(async () => {
      entered.resolve();
      return waiting.promise;
    });
    const result = finalizeGiftMediaUpload(
      f.db,
      actor,
      siteId,
      assetId,
      f.binary(),
      f.options,
    ).catch((error) => error);
    await entered.promise;
    let done = false;
    const closing = f.options.processing.close().then(() => {
      done = true;
    });
    await Promise.resolve();
    try {
      expect(done).toBe(false);
      expect(f.storage.publishDerivative).not.toHaveBeenCalled();
    } finally {
      waiting.resolve(decoded);
    }
    expect(await result).toMatchObject({ status: 503 });
    await closing;
    expect(done).toBe(true);
  });
  it("old invalid-input catch cannot close a same-ID renewed lease", async () => {
    const f = fixture();
    const waiting = deferred<typeof decoded>();
    const entered = deferred<void>();
    f.decode.mockImplementationOnce(async () => {
      entered.resolve();
      return waiting.promise;
    });
    const result = finalizeGiftMediaUpload(
      f.db,
      actor,
      siteId,
      assetId,
      f.binary(),
      f.options,
    ).catch((error) => error);
    await entered.promise;
    const original = f.row().processingId;
    const renewed = "2026-10-12 12:02:00.000001+00";
    f.row().processingExpiresAt = renewed;
    waiting.reject(new GiftImageDecodeError());
    expect(await result).toBeInstanceOf(Error);
    expect(f.row()).toMatchObject({
      processingId: original,
      processingExpiresAt: renewed,
      stableObjectVersion: expectedTag,
      state: "PROCESSING",
    });
    expect(f.intents()[0].state).toBe("REQUESTED");
  });
  it("stale publication completion cannot downgrade/associate the same original ID after renewal", async () => {
    const f = fixture();
    const waiting = deferred<{ url: string }>();
    const entered = deferred<void>();
    f.storage.publishDerivative.mockImplementationOnce(async () => {
      entered.resolve();
      return waiting.promise;
    });
    const result = finalizeGiftMediaUpload(
      f.db,
      actor,
      siteId,
      assetId,
      f.binary(),
      f.options,
    ).catch((error) => error);
    await entered.promise;
    const original = f.row().processingId;
    f.row().processingExpiresAt = "2026-10-12 12:02:00.000001+00";
    waiting.resolve({ url: String(f.row().publicUrl) });
    expect(await result).toBeInstanceOf(Error);
    expect(f.row()).toMatchObject({
      state: "PROCESSING",
      processingId: original,
      stableObjectVersion: verifiedTag,
    });
    expect(f.intents()[0].state).toBe("UNKNOWN");
  });
  it("an active one-microsecond lease is not rounded into takeover", async () => {
    const f = fixture();
    claim(f, "REQUESTED");
    f.row().processingExpiresAt = "2026-10-12 12:00:00.000001+00";
    await expect(
      finalizeGiftMediaUpload(
        f.db,
        actor,
        siteId,
        assetId,
        f.binary(),
        f.options,
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(f.pulls).not.toHaveBeenCalled();
    expect(f.intents()).toHaveLength(1);
  });
  it.each(["createdAt", "updatedAt", "expiresAt", "processingExpiresAt"])(
    "rejects invalid stored timestamp %s without publishing",
    async (field) => {
      const f = fixture();
      claim(f);
      f.row()[field] = "invalid";
      await expect(
        finalizeGiftMediaUpload(
          f.db,
          actor,
          siteId,
          assetId,
          f.binary(),
          f.options,
        ),
      ).rejects.toBeInstanceOf(Error);
      expect(f.storage.publishDerivative).not.toHaveBeenCalled();
    },
  );
});
