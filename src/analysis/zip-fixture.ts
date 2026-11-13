// Builds small ZIP archives for tests: stored or deflated entries, optional flags and attributes to fake bad archives.
import { crc32, deflateRawSync } from 'node:zlib';

export type FixtureEntry = { name: string; data?: string | Buffer; store?: boolean; encrypted?: boolean; symlink?: boolean; declaredSize?: number; badCrc?: boolean };

export function buildZip(entries: FixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = typeof entry.data === 'string' ? Buffer.from(entry.data) : entry.data ?? Buffer.alloc(0);
    const directory = entry.name.endsWith('/');
    const method = entry.store || directory ? 0 : 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const crc = entry.badCrc ? (crc32(raw) ^ 1) >>> 0 : crc32(raw) >>> 0;
    const size = entry.declaredSize ?? raw.length;
    const name = Buffer.from(entry.name);
    const flags = entry.encrypted ? 1 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.symlink ? 0o120777 : directory ? 0o040755 : 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
