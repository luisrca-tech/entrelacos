import { crc32 } from "node:zlib";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeGiftImage, GiftImageDecodeError } from "./giftImageDecoder";

const maxBytes = 5 * 1024 * 1024;

afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function nativeFixture() {
  const metadata = deferred<unknown>();
  const output = deferred<unknown>();
  const pipeline = {
    metadata: vi.fn(() => metadata.promise),
    timeout: vi.fn(),
    autoOrient: vi.fn(),
    resize: vi.fn(),
    webp: vi.fn(),
    toUint8Array: vi.fn(() => output.promise),
  };
  for (const method of [
    pipeline.timeout,
    pipeline.autoOrient,
    pipeline.resize,
    pipeline.webp,
  ])
    method.mockReturnValue(pipeline);
  const createDecoder = vi.fn(() => pipeline);
  const input = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return { metadata, output, pipeline, createDecoder, input };
}
const nativeMetadata = { format: "png", width: 16, height: 8 };
const nativeOutput = {
  data: new Uint8Array([1, 2, 3]),
  info: { format: "webp", width: 16, height: 8 },
};

describe("decoder owns actual native completion", () => {
  it("refuses a canceled call before creating native work", async () => {
    const f = nativeFixture();
    const abort = new AbortController();
    abort.abort();
    await expect(
      decodeGiftImage(f.input, "image/png", {
        signal: abort.signal,
        createDecoder: f.createDecoder as never,
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.createDecoder).not.toHaveBeenCalled();
  });
  it("keeps canceled metadata owned until settlement and never starts output", async () => {
    const f = nativeFixture();
    const abort = new AbortController();
    let settled = false;
    const result = decodeGiftImage(f.input, "image/png", {
      signal: abort.signal,
      createDecoder: f.createDecoder as never,
    })
      .catch((error) => error)
      .finally(() => {
        settled = true;
      });
    expect(f.pipeline.metadata).toHaveBeenCalledTimes(1);
    abort.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    f.metadata.resolve(nativeMetadata);
    expect(await result).toMatchObject({ status: 503 });
    expect(f.pipeline.toUint8Array).not.toHaveBeenCalled();
  });
  it("keeps canceled output owned until actual native completion", async () => {
    const f = nativeFixture();
    const abort = new AbortController();
    let settled = false;
    const result = decodeGiftImage(f.input, "image/png", {
      signal: abort.signal,
      createDecoder: f.createDecoder as never,
    })
      .catch((error) => error)
      .finally(() => {
        settled = true;
      });
    f.metadata.resolve(nativeMetadata);
    await vi.waitFor(() =>
      expect(f.pipeline.toUint8Array).toHaveBeenCalledTimes(1),
    );
    abort.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    f.output.resolve(nativeOutput);
    expect(await result).toMatchObject({ status: 503 });
  });
  it("applies the native timeout without changing input validation or releasing early", async () => {
    vi.useFakeTimers();
    const f = nativeFixture();
    let settled = false;
    const result = decodeGiftImage(f.input, "image/png", {
      createDecoder: f.createDecoder as never,
    })
      .catch((error) => error)
      .finally(() => {
        settled = true;
      });
    expect(f.pipeline.timeout).toHaveBeenCalledWith({ seconds: 20 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(settled).toBe(false);
    f.metadata.resolve(nativeMetadata);
    expect(await result).toMatchObject({ status: 503 });
    expect(f.pipeline.toUint8Array).not.toHaveBeenCalled();
  });
  it("keeps confirmed invalid metadata distinct from operational cancellation", async () => {
    const f = nativeFixture();
    const result = decodeGiftImage(f.input, "image/png", {
      createDecoder: f.createDecoder as never,
    }).catch((error) => error);
    expect(f.pipeline.metadata).toHaveBeenCalledTimes(1);
    f.metadata.resolve({ ...nativeMetadata, pages: 2 });
    expect(await result).toBeInstanceOf(GiftImageDecodeError);
    expect(f.pipeline.toUint8Array).not.toHaveBeenCalled();
  });
  it("returns only after both native stages settle on the happy path", async () => {
    const f = nativeFixture();
    const result = decodeGiftImage(f.input, "image/png", {
      createDecoder: f.createDecoder as never,
    }).catch((error) => error);
    f.metadata.resolve(nativeMetadata);
    await vi.waitFor(() =>
      expect(f.pipeline.toUint8Array).toHaveBeenCalledTimes(1),
    );
    f.output.resolve(nativeOutput);
    await expect(result).resolves.toMatchObject({
      contentType: "image/webp",
      byteLength: 3,
      width: 16,
      height: 8,
    });
    expect(f.pipeline.resize).toHaveBeenCalledWith({
      width: 2048,
      height: 2048,
      fit: "inside",
      withoutEnlargement: true,
    });
  });
  it("does not mistake an unknown native operational failure for sealed invalid input", async () => {
    const f = nativeFixture();
    f.pipeline.metadata.mockRejectedValueOnce(
      new Error("private allocation/backend failure"),
    );
    await expect(
      decodeGiftImage(f.input, "image/png", {
        createDecoder: f.createDecoder as never,
      }),
    ).rejects.toMatchObject({
      status: 503,
      message: "Processamento de imagens indisponível.",
    });
    expect(f.pipeline.toUint8Array).not.toHaveBeenCalled();
  });
  it("treats an ambiguous corrupt-header wrapper as operational rather than proving invalid input", async () => {
    const f = nativeFixture();
    f.pipeline.metadata.mockRejectedValueOnce(
      new Error("Input buffer has corrupt header: allocation failure"),
    );
    await expect(
      decodeGiftImage(f.input, "image/png", {
        createDecoder: f.createDecoder as never,
      }),
    ).rejects.toMatchObject({ status: 503 });
  });
  it.each(["factory", "timeout", "metadata-getter", "output-getter"])(
    "fences native dispatch after cancellation in %s",
    async (boundary) => {
      const f = nativeFixture();
      const abort = new AbortController();
      const metadataRead = f.pipeline.metadata;
      const outputRead = f.pipeline.toUint8Array;
      if (boundary === "factory")
        f.createDecoder.mockImplementationOnce(() => {
          abort.abort();
          return f.pipeline;
        });
      if (boundary === "timeout")
        f.pipeline.timeout.mockImplementationOnce(() => {
          abort.abort();
          return f.pipeline;
        });
      if (boundary === "metadata-getter")
        Object.defineProperty(f.pipeline, "metadata", {
          get() {
            abort.abort();
            return metadataRead;
          },
        });
      if (boundary === "output-getter")
        Object.defineProperty(f.pipeline, "toUint8Array", {
          get() {
            abort.abort();
            return outputRead;
          },
        });
      const result = decodeGiftImage(f.input, "image/png", {
        signal: abort.signal,
        createDecoder: f.createDecoder as never,
      }).catch((error) => error);
      f.metadata.resolve(nativeMetadata);
      f.output.resolve(nativeOutput);
      expect(await result).toMatchObject({ status: 503 });
      if (boundary !== "output-getter")
        expect(metadataRead).not.toHaveBeenCalled();
      expect(outputRead).not.toHaveBeenCalled();
      expect(abort.signal.aborted).toBe(true);
    },
  );
  it.each(["width", "height", "format"])(
    "does not publish decoded success after cancellation from output %s",
    async (field) => {
      const f = nativeFixture();
      const abort = new AbortController();
      const info = { ...nativeOutput.info };
      const expected = info[field as keyof typeof info];
      Object.defineProperty(info, field, {
        get() {
          abort.abort();
          return expected;
        },
      });
      const result = decodeGiftImage(f.input, "image/png", {
        signal: abort.signal,
        createDecoder: f.createDecoder as never,
      }).catch((error) => error);
      f.metadata.resolve(nativeMetadata);
      await vi.waitFor(() =>
        expect(f.pipeline.toUint8Array).toHaveBeenCalledTimes(1),
      );
      f.output.resolve({ ...nativeOutput, info });
      expect(await result).toMatchObject({ status: 503 });
      expect(abort.signal.aborted).toBe(true);
    },
  );
});

async function fixture(
  format: "jpeg" | "png" | "webp",
  width = 16,
  height = 8,
) {
  return sharp({
    create: { width, height, channels: 4, background: "#e6926280" },
  })
    .toFormat(format)
    .toBuffer();
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

async function animatedPngFixture(): Promise<Buffer> {
  const frames = await Promise.all(
    ["red", "blue"].map((background) =>
      sharp({ create: { width: 4, height: 3, channels: 3, background } })
        .png()
        .toBuffer(),
    ),
  );
  const chunks = frames.map((frame) => {
    const values: Array<{ type: string; data: Buffer }> = [];
    for (let offset = 8; offset + 12 <= frame.length; ) {
      const length = frame.readUInt32BE(offset);
      values.push({
        type: frame.toString("ascii", offset + 4, offset + 8),
        data: frame.subarray(offset + 8, offset + 8 + length),
      });
      offset += length + 12;
    }
    return values;
  });
  const animation = Buffer.alloc(8);
  animation.writeUInt32BE(2);
  const frameControl = (sequence: number) => {
    const data = Buffer.alloc(26);
    data.writeUInt32BE(sequence, 0);
    data.writeUInt32BE(4, 4);
    data.writeUInt32BE(3, 8);
    data.writeUInt16BE(1, 20);
    data.writeUInt16BE(10, 22);
    return pngChunk("fcTL", data);
  };
  const secondFrame = Buffer.concat(
    chunks[1]
      .filter((chunk) => chunk.type === "IDAT")
      .map((chunk) => chunk.data),
  );
  const sequence = Buffer.alloc(4);
  sequence.writeUInt32BE(2);
  return Buffer.concat([
    frames[0].subarray(0, 8),
    pngChunk("IHDR", chunks[0][0].data),
    pngChunk("acTL", animation),
    frameControl(0),
    ...chunks[0]
      .filter((chunk) => chunk.type === "IDAT")
      .map((chunk) => pngChunk("IDAT", chunk.data)),
    frameControl(1),
    pngChunk("fdAT", Buffer.concat([sequence, secondFrame])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("real gift image decoder", () => {
  it.each([
    ["jpeg", "image/jpeg"],
    ["png", "image/png"],
    ["webp", "image/webp"],
  ] as const)(
    "decodes real %s pixels and emits a bounded static WebP",
    async (format, contentType) => {
      const input = await fixture(format);
      const snapshot = Buffer.from(input);
      const result = await decodeGiftImage(input, contentType);
      const metadata = await sharp(result.bytes).metadata();

      expect(result.bytes).toBeInstanceOf(Uint8Array);
      expect(result.bytes).not.toBe(input);
      expect(result).toMatchObject({
        contentType: "image/webp",
        width: 16,
        height: 8,
      });
      expect(result.byteLength).toBe(result.bytes.byteLength);
      expect(result.byteLength).toBeGreaterThan(0);
      expect(result.byteLength).toBeLessThanOrEqual(maxBytes);
      expect(metadata).toMatchObject({
        format: "webp",
        width: result.width,
        height: result.height,
      });
      expect(metadata.pages ?? 1).toBe(1);
      expect(input).toEqual(snapshot);
    },
  );

  it.each([
    ["jpeg", "image/png"],
    ["png", "image/webp"],
    ["webp", "image/jpeg"],
  ] as const)(
    "rejects real %s bytes mislabeled as %s",
    async (format, declaredType) => {
      await expect(
        decodeGiftImage(await fixture(format), declaredType),
      ).rejects.toBeInstanceOf(GiftImageDecodeError);
    },
  );

  it.each([
    "image/svg+xml",
    "image/gif",
    "application/octet-stream",
    "constructor",
  ])("rejects unsupported declared type %s", async (contentType) => {
    await expect(
      decodeGiftImage(await fixture("png"), contentType as never),
    ).rejects.toMatchObject({ status: 400, code: "GIFT_MEDIA_INVALID" });
  });

  it("rejects empty, invalid and oversized bytes with one sanitized error", async () => {
    for (const bytes of [
      new Uint8Array(),
      new Uint8Array([255]),
      Buffer.from("private-path /secret/upload.jpg"),
      new Uint8Array(maxBytes + 1),
    ]) {
      await expect(decodeGiftImage(bytes, "image/jpeg")).rejects.toMatchObject({
        status: 400,
        code: "GIFT_MEDIA_INVALID",
        message: "Imagem inválida ou não suportada.",
      });
    }
  });

  it("rejects a truncated image even when its metadata is readable", async () => {
    const jpeg = await fixture("jpeg");
    const truncated = jpeg.subarray(0, jpeg.length - 2);
    expect((await sharp(truncated).metadata()).format).toBe("jpeg");
    await expect(
      decodeGiftImage(truncated, "image/jpeg"),
    ).rejects.toBeInstanceOf(GiftImageDecodeError);
  });

  it("rejects SVG and other actual formats disguised with an allowed type", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3" fill="red"/></svg>',
    );
    const gif = await sharp(await fixture("png"))
      .gif()
      .toBuffer();
    expect((await sharp(svg).metadata()).format).toBe("svg");
    expect((await sharp(gif).metadata()).format).toBe("gif");
    await expect(decodeGiftImage(svg, "image/png")).rejects.toBeInstanceOf(
      GiftImageDecodeError,
    );
    await expect(decodeGiftImage(gif, "image/png")).rejects.toBeInstanceOf(
      GiftImageDecodeError,
    );
  });

  it.each([
    [4097, 1],
    [1, 4097],
    [4097, 4097],
  ])("rejects decoded dimensions %sx%s", async (width, height) => {
    const input = await fixture("png", width, height);
    expect(input.length).toBeLessThan(maxBytes);
    await expect(decodeGiftImage(input, "image/png")).rejects.toBeInstanceOf(
      GiftImageDecodeError,
    );
  });

  it("rejects a 4096-square image whose pixels exceed the shared 16-million limit", async () => {
    const input = await fixture("png", 4096, 4096);
    await expect(decodeGiftImage(input, "image/png")).rejects.toBeInstanceOf(
      GiftImageDecodeError,
    );
  });

  it("accepts the exact 16-million pixel boundary and resizes inside 2048", async () => {
    const input = await fixture("png", 4000, 4000);
    const result = await decodeGiftImage(input, "image/png");
    expect(result).toMatchObject({ width: 2048, height: 2048 });
    expect((await sharp(result.bytes).metadata()).width).toBe(2048);
  });

  it("accepts the exact 4096-pixel dimension boundary within the pixel limit", async () => {
    const result = await decodeGiftImage(
      await fixture("png", 4096, 32),
      "image/png",
    );
    expect(result).toMatchObject({ width: 2048, height: 16 });
  });

  it("preserves aspect ratio while reducing large derivatives without enlargement", async () => {
    const result = await decodeGiftImage(
      await fixture("jpeg", 3000, 1500),
      "image/jpeg",
    );
    expect(result).toMatchObject({ width: 2048, height: 1024 });
  });

  it("uses EXIF orientation visually and strips EXIF, ICC and XMP metadata", async () => {
    const input = await sharp({
      create: { width: 12, height: 6, channels: 3, background: "red" },
    })
      .withMetadata({ orientation: 6 })
      .withExif({
        IFD0: { Artist: "Private test author", Copyright: "Private fixture" },
      })
      .withXmp("<private>test-owner</private>")
      .jpeg()
      .toBuffer();
    const original = await sharp(input).metadata();
    expect(original.orientation).toBe(6);
    expect(original.exif).toBeDefined();
    expect(original.icc).toBeDefined();
    expect(original.xmp).toBeDefined();
    const result = await decodeGiftImage(input, "image/jpeg");
    const metadata = await sharp(result.bytes).metadata();
    expect(result).toMatchObject({ width: 6, height: 12 });
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(metadata.iptc).toBeUndefined();
    expect(
      Buffer.from(result.bytes).includes(Buffer.from("Private test author")),
    ).toBe(false);
  });

  it("rejects a valid animated WebP instead of flattening its first frame", async () => {
    const frames = await Promise.all(
      ["red", "blue"].map((background) =>
        sharp({ create: { width: 4, height: 3, channels: 3, background } })
          .png()
          .toBuffer(),
      ),
    );
    const input = await sharp(frames, { join: { animated: true } })
      .webp({ delay: [100, 100], loop: 0 })
      .toBuffer();
    const metadata = await sharp(input).metadata();
    expect(metadata.pages).toBe(2);
    await expect(decodeGiftImage(input, "image/webp")).rejects.toBeInstanceOf(
      GiftImageDecodeError,
    );
  });

  it("rejects animated PNG control chunks even when the decoder exposes only PNG metadata", async () => {
    const input = await animatedPngFixture();
    expect((await sharp(input).metadata()).format).toBe("png");
    await expect(sharp(input).png().toBuffer()).resolves.toBeInstanceOf(Buffer);
    await expect(decodeGiftImage(input, "image/png")).rejects.toBeInstanceOf(
      GiftImageDecodeError,
    );
  });

  it("accepts animation chunk names inside ordinary PNG text metadata", async () => {
    const png = await fixture("png");
    const input = Buffer.concat([
      png.subarray(0, png.length - 12),
      pngChunk("tEXt", Buffer.from("Comment\0acTL fcTL fdAT")),
      png.subarray(png.length - 12),
    ]);
    const result = await decodeGiftImage(input, "image/png");
    expect(result).toMatchObject({ width: 16, height: 8 });
    expect(Buffer.from(result.bytes).includes(Buffer.from("acTL"))).toBe(false);
  });

  it("rejects an otherwise valid input whose reencoded WebP exceeds 5 MiB", async () => {
    const pixels = Buffer.alloc(2048 * 2048 * 4);
    let state = 927461;
    for (let index = 0; index < pixels.length; index++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      pixels[index] = state & 255;
    }
    const input = await sharp(pixels, {
      raw: { width: 2048, height: 2048, channels: 4 },
    })
      .webp({ quality: 1 })
      .toBuffer();
    expect(input.length).toBeLessThanOrEqual(maxBytes);
    const derivative = await sharp(input).webp({ quality: 80 }).toBuffer();
    expect(derivative.length).toBeGreaterThan(maxBytes);
    await expect(decodeGiftImage(input, "image/webp")).rejects.toBeInstanceOf(
      GiftImageDecodeError,
    );
  }, 10_000);

  it("respects typed-array slices and takes an immutable input snapshot before asynchronous decoding", async () => {
    const png = await fixture("png");
    const wrapped = new Uint8Array(png.length + 20).fill(0xee);
    wrapped.set(png, 10);
    const view = wrapped.subarray(10, 10 + png.length);
    const pending = decodeGiftImage(view, "image/png");
    view.fill(0);
    const result = await pending;
    expect((await sharp(result.bytes).metadata()).format).toBe("webp");
    expect(result).toMatchObject({ width: 16, height: 8 });
  });
});
