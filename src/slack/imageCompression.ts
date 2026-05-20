import { Jimp, JimpMime } from "jimp";

const defaultMaxDimension = 1280;
const defaultTargetBytes = 650_000;
const jpegQualitySteps = [72, 62, 52, 44];

export interface CompressedSlackImage {
  bytes: Buffer;
  mimeType: "image/jpeg";
  originalBytes: number;
  compressedBytes: number;
  originalWidth?: number;
  originalHeight?: number;
  width?: number;
  height?: number;
}

export interface CompressSlackImageOptions {
  maxDimension?: number;
  targetBytes?: number;
}

export function isCompressibleSlackImageMimeType(mimeType?: string): boolean {
  return mimeType === "image/jpeg" || mimeType === "image/png" || mimeType === "image/webp";
}

export async function compressSlackImageForModel(
  input: Buffer,
  mimeType: string | undefined,
  options: CompressSlackImageOptions = {},
): Promise<CompressedSlackImage | null> {
  if (!isCompressibleSlackImageMimeType(mimeType)) {
    return null;
  }

  const targetBytes = options.targetBytes ?? defaultTargetBytes;
  const maxDimension = options.maxDimension ?? defaultMaxDimension;
  const image = await Jimp.read(input);
  const originalWidth = image.bitmap.width;
  const originalHeight = image.bitmap.height;

  resizeToMaxDimension(image, maxDimension);

  let best = await encodeJpeg(image, jpegQualitySteps[0]);
  for (const quality of jpegQualitySteps) {
    const candidate = await encodeJpeg(image, quality);
    best = candidate.byteLength < best.byteLength ? candidate : best;
    if (candidate.byteLength <= targetBytes) {
      best = candidate;
      break;
    }
  }

  if (best.byteLength > targetBytes) {
    resizeToMaxDimension(image, Math.floor(maxDimension * 0.75));
    for (const quality of jpegQualitySteps.slice(1)) {
      const candidate = await encodeJpeg(image, quality);
      best = candidate.byteLength < best.byteLength ? candidate : best;
      if (candidate.byteLength <= targetBytes) {
        best = candidate;
        break;
      }
    }
  }

  const compressedBytes = Buffer.from(best);
  return {
    bytes: compressedBytes,
    mimeType: "image/jpeg",
    originalBytes: input.byteLength,
    compressedBytes: compressedBytes.byteLength,
    originalWidth,
    originalHeight,
    width: image.bitmap.width,
    height: image.bitmap.height,
  };
}

function resizeToMaxDimension(image: Awaited<ReturnType<typeof Jimp.read>>, maxDimension: number): void {
  const { width, height } = image.bitmap;
  const longestSide = Math.max(width, height);
  if (longestSide <= maxDimension) {
    return;
  }

  if (width >= height) {
    image.resize({ w: maxDimension });
  } else {
    image.resize({ h: maxDimension });
  }
}

async function encodeJpeg(image: Awaited<ReturnType<typeof Jimp.read>>, quality: number): Promise<Buffer> {
  return Buffer.from(await image.getBuffer(JimpMime.jpeg, { quality }));
}
