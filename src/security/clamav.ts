import { connect } from 'node:net';

export type ScanResult = 'clean' | 'infected' | 'unavailable';

/** Streams bytes to clamd (INSTREAM). Any connection or protocol problem is reported as unavailable. */
export function scanWithClamAv(bytes: Buffer, env: NodeJS.ProcessEnv = process.env): Promise<ScanResult> {
  const host = env.CLAMAV_HOST; const port = Number(env.CLAMAV_PORT || '3310');
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve('unavailable');
  return new Promise((resolve) => {
    const socket = connect(port, host); let response = ''; let settled = false;
    const done = (result: ScanResult) => { if (!settled) { settled = true; socket.destroy(); resolve(result); } };
    socket.setTimeout(10_000, () => done('unavailable'));
    socket.on('error', () => done('unavailable'));
    socket.on('data', (chunk) => { response += chunk.toString('utf8'); if (response.includes('FOUND')) done('infected'); else if (response.includes('OK')) done('clean'); else if (response.includes('ERROR')) done('unavailable'); });
    socket.on('connect', () => {
      socket.write(Buffer.from('zINSTREAM\0'));
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        const part = bytes.subarray(offset, Math.min(offset + 64 * 1024, bytes.length));
        const header = Buffer.alloc(4); header.writeUInt32BE(part.length); socket.write(header); socket.write(part);
      }
      socket.write(Buffer.alloc(4));
    });
  });
}

/** Uploads are scanned unless explicitly disabled for local development (UPLOAD_MALWARE_SCAN=disabled outside production). */
export function scanRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return !(env.UPLOAD_MALWARE_SCAN === 'disabled' && env.NODE_ENV !== 'production');
}
