// Watermarks on what a specialist downloads (STAGE_WORK_MODEL §7.2): the owner turns them on per assignment.
//
// The mark names who took the file and when, so a leaked copy points back to its source. It is a deterrent, not
// protection: a determined person can crop or retype. Photos and PDF get a repeated diagonal mark on every page, a
// Markdown or text file gets a first line. Other files (Word, Excel, PowerPoint, archives, JSON, YAML…) cannot be marked
// without breaking them: they are handed over as they are, and every download is written to the project's activity.

import sharp from 'sharp';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';

/** ASCII only: the PDF standard font and the photo font cover it, and an address is ASCII almost always. */
export function watermarkLabel(email: string, at: Date): string {
  const when = at.toISOString().slice(0, 16).replace('T', ' ');
  return `${email} | ${when} UTC | BuildPath`.normalize('NFKD').replace(/[^\x20-\x7e]/g, '?');
}

const escapeXml = (value: string) => value.replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]!);

/** Extensions whose files read fine with one more first line. */
const LINE_FIRST = new Set(['md', 'markdown', 'txt']);

export type MarkResult = { data: Buffer; marked: boolean };

/** The file as the specialist receives it. Anything that cannot be marked safely comes back unchanged with marked: false. */
export async function watermarkFile(file: { kind: string; mime: string; name: string; data: Buffer }, label: string): Promise<MarkResult> {
  try {
    if (file.kind === 'image') return { data: await markImage(file.data, file.mime, label), marked: true };
    if (file.kind === 'pdf') return { data: await markPdf(file.data, label), marked: true };
    const ext = file.name.toLowerCase().split('.').pop() ?? '';
    if (file.kind === 'text' && LINE_FIRST.has(ext)) {
      const line = ext === 'txt' ? `[${label}]\n\n` : `> ${label}\n\n`;
      return { data: Buffer.concat([Buffer.from(line, 'utf8'), file.data]), marked: true };
    }
  } catch {
    // A damaged or encrypted file: hand nothing out rather than an unmarked copy the owner asked to mark.
    throw new WatermarkError();
  }
  return { data: file.data, marked: false };
}

export class WatermarkError extends Error {
  constructor() { super('WATERMARK_FAILED'); }
}

async function markImage(data: Buffer, mime: string, label: string): Promise<Buffer> {
  const image = sharp(data, { failOn: 'error' }).rotate();
  const meta = await image.metadata();
  const width = meta.autoOrient?.width ?? meta.width ?? 0;
  const height = meta.autoOrient?.height ?? meta.height ?? 0;
  if (!width || !height) throw new Error('no size');
  const size = Math.max(12, Math.round(Math.min(width, height) / 28));
  const step = size * 7;
  const text = escapeXml(label);
  const rows: string[] = [];
  // A grid larger than the picture, turned −30°: the mark crosses every part of it.
  for (let y = -height; y < height * 2; y += step) {
    rows.push(`<text x="${-width}" y="${y}" font-size="${size}">${Array.from({ length: Math.ceil((width * 3) / (label.length * size * 0.6)) + 1 }, () => text).join('    ')}</text>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g transform="rotate(-30 ${width / 2} ${height / 2})" font-family="DejaVu Sans, sans-serif" fill="#ffffff" fill-opacity="0.45" stroke="#000000" stroke-opacity="0.35" stroke-width="${Math.max(0.5, size / 24)}">${rows.join('')}</g></svg>`;
  const out = image.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]);
  if (mime === 'image/png') return out.png().toBuffer();
  if (mime === 'image/webp') return out.webp({ quality: 90 }).toBuffer();
  return out.jpeg({ quality: 90 }).toBuffer();
}

async function markPdf(data: Buffer, label: string): Promise<Buffer> {
  const pdf = await PDFDocument.load(data, { updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();
    const size = Math.max(9, Math.min(width, height) / 40);
    const lineWidth = font.widthOfTextAtSize(label, size);
    for (let y = -height; y < height * 2; y += size * 8) {
      for (let x = -width; x < width * 2; x += lineWidth + size * 4) {
        page.drawText(label, { x, y, size, font, color: rgb(0.45, 0.45, 0.45), opacity: 0.25, rotate: degrees(30) });
      }
    }
    // A plain line at the foot of the page too: it stays readable when the page is printed light.
    page.drawText(label, { x: 24, y: 12, size: Math.max(7, size * 0.8), font, color: rgb(0.35, 0.35, 0.35), opacity: 0.8 });
  }
  return Buffer.from(await pdf.save());
}
