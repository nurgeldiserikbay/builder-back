// What a stage file is, decided from its bytes, not from the name or the browser's content type. Only formats people
// read or download are accepted; HTML, SVG and executables are refused because they could run in a browser or on a
// computer.
import { listZipEntries } from './zip-reader.js';

export type StageFileKind = 'pdf' | 'image' | 'text' | 'docx' | 'xlsx' | 'pptx' | 'zip';
export const STAGE_FILE_LIMITS = { fileBytes: 15 * 1024 * 1024, perStage: 20, projectBytes: 150 * 1024 * 1024, name: 200, note: 500 };

const textMime: Record<string, string> = { txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json' };

export function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** A file name safe to show and to put in a download header: no folders, no control characters, bounded length. */
export function cleanFileName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const base = raw.split(/[\\/]/).pop() ?? '';
  const name = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').replace(/\s+/g, ' ').trim().slice(-STAGE_FILE_LIMITS.name);
  return name && name !== '.' && name !== '..' ? name : null;
}

function isUtf8Text(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(buffer); return true; } catch { return false; }
}

export function detectStageFile(buffer: Buffer, name: string): { kind: StageFileKind; mime: string } | null {
  const ext = extension(name);
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-') return ext === 'pdf' ? { kind: 'pdf', mime: 'application/pdf' } : null;
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47) return ext === 'png' ? { kind: 'image', mime: 'image/png' } : null;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return ext === 'jpg' || ext === 'jpeg' ? { kind: 'image', mime: 'image/jpeg' } : null;
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return ext === 'webp' ? { kind: 'image', mime: 'image/webp' } : null;
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) {
    let names: string[];
    try { names = listZipEntries(buffer).map((entry) => entry.name); } catch { return null; }
    const office = (folder: string) => names.includes('[Content_Types].xml') && names.some((item) => item.startsWith(folder));
    if (ext === 'docx') return office('word/') ? { kind: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } : null;
    if (ext === 'xlsx') return office('xl/') ? { kind: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } : null;
    if (ext === 'pptx') return office('ppt/') ? { kind: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' } : null;
    if (ext === 'zip') return { kind: 'zip', mime: 'application/zip' };
    return null;
  }
  if (ext in textMime && isUtf8Text(buffer)) return { kind: 'text', mime: textMime[ext] };
  return null;
}
