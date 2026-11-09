// Untrusted photo -> safe WebP: signature check, pixel limit, auto-rotate, resize, re-encode without metadata (EXIF/GPS).
import { createHash } from 'node:crypto';
import sharp from 'sharp';

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
    let result: { data: Buffer; info: sharp.OutputInfo };
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
