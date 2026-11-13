// Untrusted photo -> safe WebP: signature check, pixel limit, auto-rotate, resize, re-encode without metadata (EXIF/GPS).
import { createHash } from 'node:crypto';
import sharp, { type OutputInfo } from 'sharp';

export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 2_000_000;
export const MAX_EDGE = 1600;

export class ImageRejectedError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'ImageRejectedError'; }
}

export function detectImageType(bytes: Buffer): 'jpeg' | 'png' | 'webp' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

export async function processImage(bytes: Buffer): Promise<{ data: Buffer; width: number; height: number; sha256: string }> {
  if (bytes.length === 0) throw new ImageRejectedError('IMAGE_EMPTY');
  if (bytes.length > MAX_UPLOAD_BYTES) throw new ImageRejectedError('IMAGE_TOO_LARGE');
  if (!detectImageType(bytes)) throw new ImageRejectedError('IMAGE_TYPE_NOT_SUPPORTED');
  for (const quality of [80, 65, 50]) {
    let result: { data: Buffer; info: OutputInfo };
    try {
      result = await sharp(bytes, { limitInputPixels: 50_000_000, failOn: 'error', animated: false })
        .rotate()
        .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
        .webp({ quality })
        .toBuffer({ resolveWithObject: true });
    } catch {
      throw new ImageRejectedError('IMAGE_UNREADABLE');
    }
    if (result.data.length <= MAX_OUTPUT_BYTES) {
      return { data: result.data, width: result.info.width, height: result.info.height, sha256: createHash('sha256').update(result.data).digest('hex') };
    }
  }
  throw new ImageRejectedError('IMAGE_TOO_LARGE');
}

/** Replaces /img/<id>.webp references with data URIs (sandboxed previews and downloadable files). */
export async function inlineImages(html: string, load: (ids: string[]) => Promise<Map<string, Buffer>>): Promise<string> {
  const ids = [...new Set([...html.matchAll(/\/img\/([0-9a-f-]{36})\.webp/g)].map((match) => match[1]))];
  if (!ids.length) return html;
  const images = await load(ids);
  return html.replace(/\/img\/([0-9a-f-]{36})\.webp/g, (whole, id: string) => {
    const data = images.get(id);
    return data ? `data:image/webp;base64,${data.toString('base64')}` : whole;
  });
}

/** A crop as fractions of the stored photo (0–1), so the app can work on any preview size. */
export type CropRect = { x: number; y: number; width: number; height: number };

/** Checks a crop rectangle; returns the pixel box or an error code. At least 64 px on each side. */
export function cropBox(rect: unknown, size: { width: number; height: number }): { left: number; top: number; width: number; height: number } | string {
  if (!rect || typeof rect !== 'object' || Array.isArray(rect)) return 'CROP_INVALID';
  const { x, y, width, height } = rect as Record<string, unknown>;
  const values = [x, y, width, height];
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) return 'CROP_INVALID';
  const [fx, fy, fw, fh] = values as number[];
  if (fx! + fw! > 1.0001 || fy! + fh! > 1.0001) return 'CROP_INVALID';
  const left = Math.round(fx! * size.width);
  const top = Math.round(fy! * size.height);
  const boxWidth = Math.min(size.width - left, Math.round(fw! * size.width));
  const boxHeight = Math.min(size.height - top, Math.round(fh! * size.height));
  if (boxWidth < 64 || boxHeight < 64) return 'CROP_TOO_SMALL';
  return { left, top, width: boxWidth, height: boxHeight };
}

/** Cuts the box out of an already safe WebP and re-encodes it the same way as an upload. */
export async function cropImage(bytes: Buffer, box: { left: number; top: number; width: number; height: number }) {
  const cut = await sharp(bytes, { limitInputPixels: 50_000_000, failOn: 'error' }).extract(box).webp({ quality: 85 }).toBuffer();
  return processImage(cut);
}
