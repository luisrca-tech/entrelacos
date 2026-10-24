import { createHash, randomUUID } from "node:crypto";
import type { ReceivingReadiness } from "@entrelacos/contracts";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import {
  giftItem,
  giftMediaAsset,
  giftMediaPublicationIntent,
  site,
  siteMembership,
  siteTerm,
  user,
} from "@entrelacos/database/schema";
import { and, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { decodeGiftImage, GiftImageDecodeError } from "./giftImageDecoder";
import {
  consultGiftMediaUpload,
  createGiftMediaProcessing,
  finalizeGiftMediaUpload,
  type GiftMediaServiceOptions,
  issueGiftMediaUpload,
  recoverGiftMediaUpload,
} from "./giftMedia";
import {
  type GiftMediaStorage,
  GiftMediaStorageError,
} from "./giftMediaStorage";
import { createSiteGift } from "./gifts";

const prefix = `media-db-${process.pid}-${randomUUID()}`;
const initialTime = new Date("2026-10-12T12:00:00.000Z");
const fixtures: Array<{ siteId: string; userId: string }> = [];
const processors: ReturnType<typeof createGiftMediaProcessing>[] = [];
let connection: DatabaseConnection;
let png: Uint8Array;
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function body(bytes = png) {
  let sent = false;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new Uint8Array(bytes));
        } else controller.close();
      },
    },
    { highWaterMark: 0 },
  );
}
function syntheticStorage() {
  const objects = new Map<string, Uint8Array>();
  const storage = {
    storageNamespace: "existing-gifts",
    getDerivativeUrl: vi.fn<GiftMediaStorage["getDerivativeUrl"]>(
      (key) => `https://media.example.test/${key}`,
    ),
    headDerivative: vi.fn<GiftMediaStorage["headDerivative"]>(async (key) => {
      const bytes = objects.get(key);
      if (!bytes) throw new GiftMediaStorageError(404, "GIFT_MEDIA_NOT_FOUND");
      return {
        etag: '"synthetic-version"',
        byteLength: bytes.length,
        contentType: "image/webp",
      };
    }),
    readDerivative: vi.fn<GiftMediaStorage["readDerivative"]>(
      async (key, etag, byteLength) => {
        const bytes = objects.get(key);
        if (
          !bytes ||
          etag !== '"synthetic-version"' ||
          bytes.length !== byteLength
        )
          throw new GiftMediaStorageError(503, "MEDIA_STORAGE_UNAVAILABLE");
        return new Uint8Array(bytes);
      },
    ),
    publishDerivative: vi.fn<GiftMediaStorage["publishDerivative"]>(
      async (key, bytes) => {
        if (objects.has(key))
          throw new GiftMediaStorageError(412, "GIFT_MEDIA_CONFLICT");
        objects.set(key, new Uint8Array(bytes));
        return { url: `https://media.example.test/${key}` };
      },
    ),
    close: vi.fn<GiftMediaStorage["close"]>(async () => {}),
  };
  return { storage, objects };
}
async function fixture() {
  const siteId = randomUUID();
  const userId = `${prefix}-${randomUUID()}`;
  fixtures.push({ siteId, userId });
  await connection.db.insert(user).values({
    id: userId,
    name: "Media assistant fixture",
    email: `${userId}@example.test`,
    role: "SITE_ASSISTANT",
    state: "ACTIVE",
  });
  await connection.db.insert(site).values({
    id: siteId,
    repositorySlug: `${prefix}-${siteId}`,
    provisioningKey: `${prefix}:${siteId}`,
    displayName: "Media fixture",
    partnerOneName: "Ana",
    partnerTwoName: "João",
    eventDate: "2027-05-22",
    lifecycle: "ACTIVE",
    publicationState: "PUBLISHED",
    isDemo: true,
    createdAt: initialTime,
    updatedAt: initialTime,
  });
  await connection.db.insert(siteTerm).values({
    id: randomUUID(),
    siteId,
    startsOn: "2026-01-01",
    endsOn: "2027-01-01",
    approvedAt: initialTime,
  });
  await connection.db
    .insert(siteMembership)
    .values({ id: randomUUID(), siteId, userId, role: "SITE_ASSISTANT" });
  let now = new Date(initialTime);
  const actor = { userId, role: "SITE_ASSISTANT" as const };
  // Synthetic readiness/session and storage are fixture boundaries, never provider or native-session proof.
  const readiness: ReceivingReadiness = {
    siteId,
    state: "READY",
    reason: null,
    observedAt: initialTime.toISOString(),
    destinationVersion: 1,
    catalogEligible: true,
    mode: "sandbox",
  };
  const { storage, objects } = syntheticStorage();
  const processing = createGiftMediaProcessing();
  processors.push(processing);
  const options: GiftMediaServiceOptions = {
    storage,
    storageNamespace: "existing-gifts",
    processing,
    authorize: async () => ({ ...actor }),
    now: () => new Date(now),
    readReadiness: async (requested) => {
      expect(requested).toBe(siteId);
      return { ...readiness };
    },
  };
  return {
    siteId,
    userId,
    actor,
    storage,
    objects,
    readiness,
    options,
    setTime: (value: Date) => {
      now = new Date(value);
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function issue(f: Fixture) {
  return issueGiftMediaUpload(
    connection.db,
    f.actor,
    f.siteId,
    {
      contentType: "image/png",
      byteLength: png.byteLength,
      contentSha256: hash(png),
    },
    f.options,
  );
}
async function finalize(f: Fixture, id: string, selected = png) {
  return finalizeGiftMediaUpload(
    connection.db,
    f.actor,
    f.siteId,
    id,
    { contentType: "image/png", body: body(selected) },
    f.options,
  );
}
async function readAsset(f: Fixture, id: string) {
  const [row] = await connection.db
    .select()
    .from(giftMediaAsset)
    .where(and(eq(giftMediaAsset.siteId, f.siteId), eq(giftMediaAsset.id, id)));
  expect(row).toBeDefined();
  return row;
}
async function readIntents(f: Fixture, id: string) {
  return connection.db
    .select()
    .from(giftMediaPublicationIntent)
    .where(
      and(
        eq(giftMediaPublicationIntent.siteId, f.siteId),
        eq(giftMediaPublicationIntent.assetId, id),
      ),
    );
}
describe("gift media PostgreSQL inline service acceptance (separate execution grant required)", () => {
  beforeAll(async () => {
    connection = createDatabaseConnection({ target: "test" });
    await verifyDatabaseConnection(connection);
    png = await sharp({
      create: {
        width: 2,
        height: 3,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    })
      .png()
      .toBuffer();
  });
  afterAll(async () => {
    await Promise.all(
      processors.splice(0).map((processing) => processing.close()),
    );
    if (!connection) return;
    try {
      for (const { siteId, userId } of fixtures) {
        await connection.db.delete(giftItem).where(eq(giftItem.siteId, siteId));
        await connection.db
          .delete(giftMediaPublicationIntent)
          .where(eq(giftMediaPublicationIntent.siteId, siteId));
        await connection.db
          .delete(giftMediaAsset)
          .where(eq(giftMediaAsset.siteId, siteId));
        await connection.db
          .delete(siteMembership)
          .where(
            and(
              eq(siteMembership.siteId, siteId),
              eq(siteMembership.userId, userId),
            ),
          );
        await connection.db.delete(siteTerm).where(eq(siteTerm.siteId, siteId));
        await connection.db.delete(site).where(eq(site.id, siteId));
        await connection.db.delete(user).where(eq(user.id, userId));
      }
    } finally {
      await connection.close();
    }
  });
  it("issues one inline expectation and finalizes real validated derivative bytes under actual constraints", async () => {
    const f = await fixture();
    const upload = await issue(f);
    const pending = await readAsset(f, upload.upload.id);
    expect(upload.upload).not.toHaveProperty("putUrl");
    expect(pending.stagingKey).toMatch(/^inline-v1\//);
    expect(pending.stableObjectVersion).toBe(`inline-v1:expected:${hash(png)}`);
    expect(f.storage.publishDerivative).not.toHaveBeenCalled();
    const response = await finalize(f, upload.upload.id);
    const completed = await readAsset(f, upload.upload.id);
    const intents = await readIntents(f, upload.upload.id);
    const bytes = f.objects.get(String(completed.derivativeKey));
    if (!bytes) throw new Error("Published derivative fixture missing");
    expect((await sharp(bytes).metadata()).format).toBe("webp");
    expect(completed.stableObjectVersion).toBe(
      `inline-v1:verified:${hash(png)}:${hash(bytes)}`,
    );
    expect(completed.state).toBe("FINALIZED");
    expect(intents).toHaveLength(1);
    expect(intents[0].state).toBe("ASSOCIATED");
    expect(response.media).toMatchObject({
      id: upload.upload.id,
      siteId: f.siteId,
      width: 2,
      height: 3,
    });
  });
  it("keeps lookup read-only and returns known finalized duplicates without another PUT", async () => {
    const f = await fixture();
    const upload = await issue(f);
    const before = await readAsset(f, upload.upload.id);
    await consultGiftMediaUpload(
      connection.db,
      f.actor,
      f.siteId,
      upload.upload.id,
      f.options,
    );
    expect(await readAsset(f, upload.upload.id)).toEqual(before);
    expect(await readIntents(f, upload.upload.id)).toHaveLength(0);
    const result = await finalize(f, upload.upload.id);
    await expect(finalize(f, upload.upload.id)).resolves.toEqual(result);
    expect(f.storage.publishDerivative).toHaveBeenCalledTimes(1);
  });
  it("atomically pins result/UNKNOWN before the synthetic external write", async () => {
    const f = await fixture();
    const upload = await issue(f);
    f.storage.publishDerivative.mockImplementationOnce(async (key, bytes) => {
      const row = await readAsset(f, upload.upload.id);
      const intents = await readIntents(f, upload.upload.id);
      expect(row.stableObjectVersion).toBe(
        `inline-v1:verified:${hash(png)}:${hash(bytes)}`,
      );
      expect(row.publicUrl).toBe(f.storage.getDerivativeUrl(key));
      expect(row.derivativeKey).toBe(key);
      expect(intents).toHaveLength(1);
      expect(intents[0].state).toBe("UNKNOWN");
      f.objects.set(key, new Uint8Array(bytes));
      return { url: String(row.publicUrl) };
    });
    await finalize(f, upload.upload.id);
  });
  it("retains exact original bytes/result/claim after lost PUT ACK and recovers after expiry without decode or PUT", async () => {
    const f = await fixture();
    const upload = await issue(f);
    f.storage.publishDerivative.mockImplementationOnce(async (key, bytes) => {
      f.objects.set(key, new Uint8Array(bytes));
      throw new Error("Synthetic acknowledgment lost");
    });
    await expect(finalize(f, upload.upload.id)).rejects.toMatchObject({
      status: 503,
    });
    const original = await readAsset(f, upload.upload.id);
    const [intent] = await readIntents(f, upload.upload.id);
    expect(intent.state).toBe("UNKNOWN");
    expect(original.state).toBe("PROCESSING");
    f.setTime(new Date(initialTime.getTime() + 300_001));
    const result = await recoverGiftMediaUpload(
      connection.db,
      f.actor,
      f.siteId,
      upload.upload.id,
      f.options,
    );
    expect(result.status.state).toBe("FINALIZED");
    expect(f.storage.publishDerivative).toHaveBeenCalledTimes(1);
    expect((await readAsset(f, upload.upload.id)).derivativeKey).toBe(
      original.derivativeKey,
    );
    expect(await readIntents(f, upload.upload.id)).toHaveLength(1);
  });
  it("404 retains UNKNOWN and does not permit a new publication identity", async () => {
    const f = await fixture();
    const upload = await issue(f);
    f.storage.publishDerivative.mockRejectedValueOnce(
      new Error("Uncertain write"),
    );
    await expect(finalize(f, upload.upload.id)).rejects.toBeInstanceOf(Error);
    const original = await readAsset(f, upload.upload.id);
    f.setTime(new Date(initialTime.getTime() + 300_001));
    await expect(
      recoverGiftMediaUpload(
        connection.db,
        f.actor,
        f.siteId,
        upload.upload.id,
        f.options,
      ),
    ).resolves.toMatchObject({
      status: { state: "UNKNOWN", canRetrySameBytes: false, media: null },
    });
    expect((await readAsset(f, upload.upload.id)).derivativeKey).toBe(
      original.derivativeKey,
    );
    expect(await readIntents(f, upload.upload.id)).toHaveLength(1);
    expect(f.storage.publishDerivative).toHaveBeenCalledTimes(1);
  });
  it("known invalid original closes atomically and rejects re-arm", async () => {
    const f = await fixture();
    const upload = await issue(f);
    await expect(
      finalize(f, upload.upload.id, new Uint8Array(png.length)),
    ).rejects.toMatchObject({ status: 400 });
    const row = await readAsset(f, upload.upload.id);
    expect(row.state).toBe("FAILED");
    expect(row.stableObjectVersion).toBe(`inline-v1:closed:${hash(png)}`);
    const [intent] = await readIntents(f, upload.upload.id);
    expect(intent.state).toBe("ORPHANED");
    await expect(finalize(f, upload.upload.id)).rejects.toBeInstanceOf(Error);
    expect(f.storage.publishDerivative).not.toHaveBeenCalled();
  });
  it("a one-microsecond same-ID renewal fences the old decoder and cleanup", async () => {
    const f = await fixture();
    const upload = await issue(f);
    const entered = gate();
    const resume = gate();
    f.options.decode = async () => {
      entered.release();
      await resume.promise;
      throw new GiftImageDecodeError();
    };
    const result = finalize(f, upload.upload.id).catch((error) => error);
    await entered.promise;
    const old = await readAsset(f, upload.upload.id);
    try {
      await connection.db.execute(
        sql`UPDATE gift_media_asset SET processing_expires_at = processing_expires_at + interval '1 microsecond' WHERE id = ${upload.upload.id}`,
      );
    } finally {
      resume.release();
    }
    expect(await result).toBeInstanceOf(Error);
    const current = await readAsset(f, upload.upload.id);
    expect(current.processingId).toBe(old.processingId);
    expect(current.stableObjectVersion).toBe(`inline-v1:expected:${hash(png)}`);
    expect((await readIntents(f, upload.upload.id))[0].state).toBe("REQUESTED");
    expect(f.storage.publishDerivative).not.toHaveBeenCalled();
  });
  it("only explicit same-byte retry reuses the original claim/key after lease expiry", async () => {
    const f = await fixture();
    const upload = await issue(f);
    f.storage.publishDerivative.mockRejectedValueOnce(
      new Error("Uncertain ACK"),
    );
    await expect(finalize(f, upload.upload.id)).rejects.toBeInstanceOf(Error);
    const old = await readAsset(f, upload.upload.id);
    f.setTime(new Date(initialTime.getTime() + 60_001));
    await finalize(f, upload.upload.id);
    const current = await readAsset(f, upload.upload.id);
    expect(current.derivativeKey).toBe(old.derivativeKey);
    expect(await readIntents(f, upload.upload.id)).toHaveLength(1);
  });
  it("a delayed old PUT cannot associate after same-claim recovery renews the exact lease", async () => {
    const f = await fixture();
    const upload = await issue(f);
    const entered = gate();
    const resume = gate();
    f.storage.publishDerivative.mockImplementationOnce(async (key, bytes) => {
      entered.release();
      await resume.promise;
      f.objects.set(key, new Uint8Array(bytes));
      return { url: f.storage.getDerivativeUrl(key) };
    });
    const oldResult = finalize(f, upload.upload.id).catch((error) => error);
    await entered.promise;
    const other = createGiftMediaProcessing();
    processors.push(other);
    try {
      f.setTime(new Date(initialTime.getTime() + 60_001));
      await expect(
        recoverGiftMediaUpload(
          connection.db,
          f.actor,
          f.siteId,
          upload.upload.id,
          { ...f.options, processing: other },
        ),
      ).resolves.toMatchObject({ status: { state: "UNKNOWN" } });
    } finally {
      resume.release();
    }
    expect(await oldResult).toBeInstanceOf(Error);
    expect((await readAsset(f, upload.upload.id)).state).toBe("PROCESSING");
    f.setTime(new Date(initialTime.getTime() + 120_002));
    await expect(
      recoverGiftMediaUpload(
        connection.db,
        f.actor,
        f.siteId,
        upload.upload.id,
        f.options,
      ),
    ).resolves.toMatchObject({ status: { state: "FINALIZED" } });
    expect(await readIntents(f, upload.upload.id)).toHaveLength(1);
  });
  it("revoked real membership prevents publication after actual decoding", async () => {
    const f = await fixture();
    const upload = await issue(f);
    f.options.decode = async (...args) => {
      const decoded = await decodeGiftImage(...args);
      await connection.db
        .update(siteMembership)
        .set({ revokedAt: initialTime })
        .where(
          and(
            eq(siteMembership.siteId, f.siteId),
            eq(siteMembership.userId, f.userId),
          ),
        );
      return decoded;
    };
    await expect(finalize(f, upload.upload.id)).rejects.toMatchObject({
      status: 403,
    });
    expect(f.storage.publishDerivative).not.toHaveBeenCalled();
  });
  it("legacy pending and historical ETag remain untouched", async () => {
    const f = await fixture();
    const upload = await issue(f);
    await connection.db
      .update(giftMediaAsset)
      .set({
        stagingKey: `staging/${f.siteId}/${upload.upload.id}/legacy`,
        stableObjectVersion: '"historical-etag"',
      })
      .where(eq(giftMediaAsset.id, upload.upload.id));
    const before = await readAsset(f, upload.upload.id);
    await expect(finalize(f, upload.upload.id)).rejects.toBeInstanceOf(Error);
    await expect(
      consultGiftMediaUpload(
        connection.db,
        f.actor,
        f.siteId,
        upload.upload.id,
        f.options,
      ),
    ).resolves.toMatchObject({
      status: { state: "UNKNOWN", canRetrySameBytes: false },
    });
    expect(await readAsset(f, upload.upload.id)).toEqual(before);
    expect(f.storage.publishDerivative).not.toHaveBeenCalled();
  });
  it("catalog attachment still requires positive FINALIZED media", async () => {
    const f = await fixture();
    const upload = await issue(f);
    const input = {
      title: "Gift",
      description: "",
      nominalCents: 10_000,
      currency: "BRL" as const,
      mediaAssetId: upload.upload.id,
      altText: "Gift image",
    };
    await expect(
      createSiteGift(connection.db, f.actor, f.siteId, input, f.options),
    ).rejects.toBeInstanceOf(Error);
    await finalize(f, upload.upload.id);
    await expect(
      createSiteGift(connection.db, f.actor, f.siteId, input, f.options),
    ).resolves.toHaveProperty("gift");
  });
});
