import sharp from 'sharp';

export interface VisualDiffRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  changedPercent: number;
}

export interface VisualDiffResult {
  overlay: Buffer;
  changedPercent: number;
  changedPixels: number;
  totalPixels: number;
  width: number;
  height: number;
  threshold: number;
  regions: VisualDiffRegion[];
}

/** Compare two images in bounded, normalized RGB space and mark changed pixels red. */
export async function compareDesignToCapture(
  screenshotBytes: Buffer,
  designBytes: Buffer,
): Promise<VisualDiffResult> {
  const maxPixels = 4_000_000;
  const maxDimension = 2400;
  const threshold = 28;
  const options = { limitInputPixels: 25_000_000 };

  const screenshotMeta = await sharp(screenshotBytes, options).metadata();
  const designMeta = await sharp(designBytes, options).metadata();
  if (!screenshotMeta.width || !screenshotMeta.height || !designMeta.width || !designMeta.height) {
    throw new Error('VISUAL_DIFF_INVALID_IMAGE');
  }
  const width = Math.max(1, Math.min(screenshotMeta.width, designMeta.width, maxDimension));
  const height = Math.max(1, Math.min(screenshotMeta.height, designMeta.height, maxDimension));
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
  const targetWidth = Math.max(1, Math.floor(width * scale));
  const targetHeight = Math.max(1, Math.floor(height * scale));

  const normalizedOptions = { width: targetWidth, height: targetHeight, fit: 'contain' as const, background: '#ffffff' };
  const [{ data: site, info }, { data: design }] = await Promise.all([
    sharp(screenshotBytes, options).flatten({ background: '#ffffff' }).resize(normalizedOptions).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(designBytes, options).flatten({ background: '#ffffff' }).resize(normalizedOptions).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (info.channels !== 3 || site.length !== design.length) throw new Error('VISUAL_DIFF_NORMALIZATION_FAILED');

  const mask = Buffer.alloc(info.width * info.height * 4);
  const cols = 24;
  const rows = 24;
  const regionCounts = new Uint32Array(cols * rows);
  let changedPixels = 0;
  for (let pixel = 0; pixel < info.width * info.height; pixel++) {
    const offset = pixel * 3;
    const difference = Math.max(
      Math.abs(site[offset]! - design[offset]!),
      Math.abs(site[offset + 1]! - design[offset + 1]!),
      Math.abs(site[offset + 2]! - design[offset + 2]!),
    );
    if (difference <= threshold) continue;
    changedPixels++;
    const x = pixel % info.width;
    const y = Math.floor(pixel / info.width);
    regionCounts[Math.min(rows - 1, Math.floor(y * rows / info.height))! * cols + Math.min(cols - 1, Math.floor(x * cols / info.width))!]++;
    const alpha = Math.min(210, Math.max(100, difference));
    const maskOffset = pixel * 4;
    mask[maskOffset] = 255;
    mask[maskOffset + 1] = 36;
    mask[maskOffset + 2] = 60;
    mask[maskOffset + 3] = alpha;
  }

  const regions = Array.from(regionCounts, (count, index) => ({
    x: (index % cols) / cols,
    y: Math.floor(index / cols) / rows,
    width: 1 / cols,
    height: 1 / rows,
    changedPercent: Number(Math.min(100, count * 100 / (info.width * info.height / (cols * rows))).toFixed(1)),
  }))
    .filter((region) => region.changedPercent > 0)
    .sort((a, b) => b.changedPercent - a.changedPercent)
    .slice(0, 50);
  const overlay = await sharp(site, { raw: { width: info.width, height: info.height, channels: 3 } })
    .composite([{ input: mask, raw: { width: info.width, height: info.height, channels: 4 }, blend: 'over' }])
    .png()
    .toBuffer();

  return {
    overlay,
    changedPercent: Number((changedPixels * 100 / (info.width * info.height)).toFixed(2)),
    changedPixels,
    totalPixels: info.width * info.height,
    width: info.width,
    height: info.height,
    threshold,
    regions,
  };
}
