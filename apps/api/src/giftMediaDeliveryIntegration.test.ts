import { Readable } from "node:stream";
import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { createGiftMediaProcessing } from "./giftMedia";
import { createR2GiftMediaStorage } from "./giftMediaStorage";

const bytes = Buffer.from("RIFF0000WEBPimmutable-native-derivative");
const etag = '"native-etag"';
const options = {
  accountId: "a".repeat(32),
  accessKeyId: "offline-key",
  secretAccessKey: "offline-secret",
  bucketName: "existing-production-bucket",
  publicOrigin: "https://api.example.test",
  applicationEnvironment: "production" as const,
};
afterEach(() => vi.restoreAllMocks());

describe("API public delivery through the native R2 storage boundary", () => {
  it("delivers the same stable URL emitted by storage and pins the actual GET with IfMatch", async () => {
    const send = vi
      .spyOn(S3Client.prototype, "send")
      .mockImplementation(async (command: unknown) => {
        const metadata = {
          ETag: etag,
          ContentLength: bytes.length,
          ContentType: "image/webp",
        };
        if (command instanceof HeadObjectCommand) return metadata;
        if (command instanceof GetObjectCommand)
          return { ...metadata, Body: Readable.from([bytes]) };
        throw new Error("Unexpected storage write");
      });
    const storage = createR2GiftMediaStorage(options);
    const processing = createGiftMediaProcessing();
    const database = vi.fn(() => {
      throw new Error("Public image must not query the database");
    });
    const api = createApp(
      {
        db: { execute: database } as never,
        auth: {} as never,
        adminOrigin: "https://panel.example.test",
        storage,
        processing,
        storageNamespace: storage.storageNamespace,
      },
      { sink: () => {} },
    );
    try {
      const url = storage.getDerivativeUrl(
        "gifts/wedding-a/asset-a/processing-a.webp",
      );
      const response = await api.request(url);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
      expect(response.headers.get("Content-Type")).toBe("image/webp");
      const get = send.mock.calls.find(
        ([command]) => command instanceof GetObjectCommand,
      )?.[0] as GetObjectCommand | undefined;
      expect(get?.input).toMatchObject({
        Bucket: options.bucketName,
        Key: "gifts/wedding-a/asset-a/processing-a.webp",
        IfMatch: etag,
      });
      const head = await api.request(url, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      const cached = await api.request(url, {
        headers: { "If-None-Match": etag },
      });
      expect(cached.status).toBe(304);
      const denied = await api.request(url, { method: "PUT" });
      expect(denied.status).toBe(405);
      expect(denied.headers.get("Cache-Control")).toBe("no-store");
      expect(
        send.mock.calls.filter(
          ([command]) => command instanceof GetObjectCommand,
        ),
      ).toHaveLength(1);
      expect(database).not.toHaveBeenCalled();
    } finally {
      await api.close();
      await processing.close();
      await storage.close();
    }
  });
  it("sanitizes native missing-object responses without storing a public error", async () => {
    vi.spyOn(S3Client.prototype, "send").mockRejectedValue({
      $metadata: { httpStatusCode: 404 },
      message: "private-account-token",
    });
    const storage = createR2GiftMediaStorage(options);
    const processing = createGiftMediaProcessing();
    const api = createApp(
      {
        db: {} as never,
        auth: {} as never,
        adminOrigin: "https://panel.example.test",
        storage,
        processing,
      },
      { sink: () => {} },
    );
    try {
      for (const method of ["GET", "HEAD"]) {
        const response = await api.request(
          storage.getDerivativeUrl("gifts/wedding-a/asset-a/missing.webp"),
          { method },
        );
        expect(response.status).toBe(404);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        const text = await response.text();
        expect(text).not.toContain("private-account-token");
        if (method === "HEAD") expect(text).toBe("");
      }
    } finally {
      await api.close();
      await processing.close();
      await storage.close();
    }
  });
});
