import type {
  GiftMediaPublicAsset,
  GiftMediaUploadInput,
} from "@entrelacos/contracts";
import sharp from "sharp";

const maxBytes = 5_242_880;
const maxInputDimension = 4096;
const maxInputPixels = 16_000_000;
const maxOutputDimension = 2048;
const processingTimeoutMs = 20_000;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export type DecodedGiftImage = Pick<
  GiftMediaPublicAsset,
  "contentType" | "byteLength" | "width" | "height"
> & { bytes: Uint8Array };

export class GiftImageDecodeError extends Error {
  readonly status = 400;
  readonly code = "GIFT_MEDIA_INVALID";
  readonly title = "Imagem inválida ou não suportada.";

  constructor() {
    super("Imagem inválida ou não suportada.");
    this.name = "GiftImageDecodeError";
  }
}

export class GiftImageProcessingError extends Error {
  readonly status = 503;
  readonly code = "MEDIA_STORAGE_UNAVAILABLE";
  constructor() {
    super("Processamento de imagens indisponível.");
    this.name = "GiftImageProcessingError";
  }
}

export interface GiftImageDecoderOptions {
  signal?: AbortSignal;
  createDecoder?: typeof sharp;
}

function matchesSignature(
  bytes: Buffer,
  contentType: GiftMediaUploadInput["contentType"],
): boolean {
  switch (contentType) {
    case "image/jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/png":
      return bytes.subarray(0, 8).equals(pngSignature);
    case "image/webp":
      return (
        bytes.toString("ascii", 0, 4) === "RIFF" &&
        bytes.toString("ascii", 8, 12) === "WEBP"
      );
  }
}

function hasPngAnimation(bytes: Buffer): boolean {
  // Sharp exposes APNG as PNG without frame metadata.
  for (let offset = 8; offset + 12 <= bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    if (offset + length + 12 > bytes.length) throw new GiftImageDecodeError();
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "acTL" || type === "fcTL" || type === "fdAT") return true;
    offset += length + 12;
  }
  return false;
}

export async function decodeGiftImage(
  bytes: Uint8Array,
  declaredContentType: GiftMediaUploadInput["contentType"],
  options: GiftImageDecoderOptions = {},
): Promise<DecodedGiftImage> {
  const { signal, createDecoder = sharp } = options;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
  }, processingTimeoutMs);
  const current = () => {
    if (signal?.aborted || timedOut) throw new GiftImageProcessingError();
  };
  try {
    current();
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength < 1 ||
      bytes.byteLength > maxBytes ||
      !["image/jpeg", "image/png", "image/webp"].includes(declaredContentType)
    ) {
      throw new GiftImageDecodeError();
    }
    const input = Buffer.from(bytes);
    if (
      !matchesSignature(input, declaredContentType) ||
      (declaredContentType === "image/png" && hasPngAnimation(input))
    ) {
      throw new GiftImageDecodeError();
    }

    const instance = createDecoder(input, {
      failOn: "warning",
      limitInputPixels: maxInputPixels,
      unlimited: false,
    });
    current();
    const configureTimeout = instance.timeout;
    current();
    const decoder = configureTimeout.call(instance, { seconds: 20 });
    current();
    const readMetadata = decoder.metadata;
    current();
    const metadata = await readMetadata.call(decoder);
    current();
    const expectedFormat = declaredContentType.slice("image/".length);
    if (
      metadata.format !== expectedFormat ||
      !metadata.width ||
      !metadata.height ||
      !Number.isInteger(metadata.width) ||
      !Number.isInteger(metadata.height) ||
      metadata.width > maxInputDimension ||
      metadata.height > maxInputDimension ||
      metadata.width * metadata.height > maxInputPixels ||
      (metadata.pages ?? 1) !== 1 ||
      metadata.delay !== undefined ||
      metadata.loop !== undefined ||
      (metadata.pageHeight !== undefined &&
        metadata.pageHeight !== metadata.height)
    ) {
      throw new GiftImageDecodeError();
    }
    current();
    const output = decoder
      .autoOrient()
      .resize({
        width: maxOutputDimension,
        height: maxOutputDimension,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 80 });
    current();
    const readOutput = output.toUint8Array;
    current();
    const { data, info } = await readOutput.call(output);
    current();
    const byteLength = data.byteLength;
    const { format, width, height } = info;
    current();
    if (
      byteLength < 1 ||
      byteLength > maxBytes ||
      format !== "webp" ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > maxOutputDimension ||
      height > maxOutputDimension
    ) {
      throw new GiftImageDecodeError();
    }
    const result: DecodedGiftImage = {
      bytes: data,
      contentType: "image/webp",
      byteLength,
      width,
      height,
    };
    current();
    return result;
  } catch (error) {
    current();
    if (
      error instanceof GiftImageDecodeError ||
      error instanceof GiftImageProcessingError
    )
      throw error;
    // Unknown native failures cannot prove the input invalid or authorize a terminal seal.
    if (
      error instanceof Error &&
      /^(Input buffer contains unsupported image format|Input image exceeds pixel limit)$|VipsJpeg:.*premature/i.test(
        error.message,
      )
    )
      throw new GiftImageDecodeError();
    throw new GiftImageProcessingError();
  } finally {
    clearTimeout(timer);
  }
}
