// Reads a ZIP archive in memory without extracting it to disk and without running anything from it.
// Only the central directory is trusted for the list of entries; each entry is read through its local header with
// strict bounds, a per-entry output cap, a compression-ratio cap and a CRC check. Zip64, multi-disk and encrypted
// entries are listed but never decompressed.

import { crc32, inflateRawSync } from 'node:zlib';

export class ZipError extends Error {
  constructor(readonly code: string) { super(code); }
}

export type ZipEntry = {
  name: string;
  directory: boolean;
  method: number;
  compressedSize: number;
  size: number;
  crc: number;
  encrypted: boolean;
  symlink: boolean;
  unsafePath: boolean;
  localOffset: number;
};

export const ZIP_LIMITS = { maxEntries: 5000, maxDeclaredTotal: 500 * 1024 * 1024, maxRatio: 200 };

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function findEndOfCentralDirectory(buffer: Buffer): number {
  const min = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD) return offset;
  }
  throw new ZipError('ZIP_INVALID');
}

/** True for absolute paths, drive letters, backslashes, `..` segments and control characters (a "zip slip" name). */
export function isUnsafeEntryName(name: string): boolean {
  if (!name || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes('\\') || /[\u0000-\u001f]/.test(name)) return true;
  return name.split('/').some((part) => part === '..');
}

export function listZipEntries(buffer: Buffer): ZipEntry[] {
  if (buffer.length < 22) throw new ZipError('ZIP_INVALID');
  const end = findEndOfCentralDirectory(buffer);
  const disk = buffer.readUInt16LE(end + 4);
  const cdDisk = buffer.readUInt16LE(end + 6);
  const count = buffer.readUInt16LE(end + 10);
  const cdSize = buffer.readUInt32LE(end + 12);
  const cdOffset = buffer.readUInt32LE(end + 16);
  if (disk !== 0 || cdDisk !== 0) throw new ZipError('ZIP_MULTI_DISK');
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('ZIP64_NOT_SUPPORTED');
  if (count > ZIP_LIMITS.maxEntries) throw new ZipError('ZIP_TOO_MANY_ENTRIES');
  if (cdOffset + cdSize > end) throw new ZipError('ZIP_INVALID');
  const entries: ZipEntry[] = [];
  let pointer = cdOffset;
  let declared = 0;
  for (let index = 0; index < count; index += 1) {
    if (pointer + 46 > end || buffer.readUInt32LE(pointer) !== CENTRAL) throw new ZipError('ZIP_INVALID');
    const madeBy = buffer.readUInt16LE(pointer + 4) >> 8;
    const flags = buffer.readUInt16LE(pointer + 8);
    const method = buffer.readUInt16LE(pointer + 10);
    const crc = buffer.readUInt32LE(pointer + 16);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const size = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const externalAttributes = buffer.readUInt32LE(pointer + 38);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const next = pointer + 46 + nameLength + extraLength + commentLength;
    if (next > end) throw new ZipError('ZIP_INVALID');
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ZipError('ZIP64_NOT_SUPPORTED');
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength);
    const unixMode = madeBy === 3 ? externalAttributes >>> 16 : 0;
    declared += size;
    if (declared > ZIP_LIMITS.maxDeclaredTotal) throw new ZipError('ZIP_TOO_LARGE_UNPACKED');
    entries.push({
      name, directory: name.endsWith('/'), method, compressedSize, size, crc, encrypted: (flags & 1) === 1,
      symlink: (unixMode & 0o170000) === 0o120000, unsafePath: isUnsafeEntryName(name), localOffset,
    });
    pointer = next;
  }
  return entries;
}

/**
 * Bytes of one entry, or a reason it was not read. `maxBytes` caps the output; the declared size is checked against
 * the actual output and the CRC, so a lying header cannot make us inflate more than the cap.
 */
export function readZipEntry(buffer: Buffer, entry: ZipEntry, maxBytes: number): { data: Buffer } | { skipped: 'encrypted' | 'too_large' | 'ratio' | 'method' | 'corrupt' | 'unsafe' } {
  if (entry.encrypted) return { skipped: 'encrypted' };
  if (entry.unsafePath || entry.symlink) return { skipped: 'unsafe' };
  if (entry.size > maxBytes) return { skipped: 'too_large' };
  if (entry.compressedSize > 0 && entry.size / entry.compressedSize > ZIP_LIMITS.maxRatio) return { skipped: 'ratio' };
  const offset = entry.localOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== LOCAL) return { skipped: 'corrupt' };
  const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
  const stop = start + entry.compressedSize;
  if (stop > buffer.length) return { skipped: 'corrupt' };
  const raw = buffer.subarray(start, stop);
  let data: Buffer;
  if (entry.method === 0) data = Buffer.from(raw);
  else if (entry.method === 8) {
    try { data = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) }); } catch { return { skipped: 'corrupt' }; }
  } else return { skipped: 'method' };
  if (data.length !== entry.size || (crc32(data) >>> 0) !== entry.crc) return { skipped: 'corrupt' };
  return { data };
}

/** GitHub and GitLab archives put everything under one folder (`owner-repo-sha/`); reports show paths without it. */
export function commonRoot(entries: ZipEntry[]): string {
  const files = entries.filter((entry) => !entry.directory);
  if (!files.length) return '';
  const first = files[0].name.split('/')[0];
  if (!first || files.some((entry) => !entry.name.startsWith(`${first}/`))) return '';
  return `${first}/`;
}
