// How a session or a sign-in is shown to its owner: a short device name and a coarse network hint.
// The full IP address and User-Agent are not shown back; the hint is enough to notice «this was not me».

/** «Chrome · macOS», «Safari · iPhone», «Telegram», or «Неизвестное устройство». */
export function describeDevice(userAgent: string | null | undefined): string {
  const ua = userAgent ?? '';
  if (!ua) return 'Неизвестное устройство';
  if (/Telegram/i.test(ua)) return 'Telegram';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /YaBrowser/.test(ua) ? 'Яндекс Браузер' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  const system = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : null;
  return [browser, system].filter(Boolean).join(' · ') || 'Неизвестное устройство';
}

/** IPv4 «85.117.x.x», IPv6 the first two groups; empty for local addresses. */
export function ipHint(ip: string | null | undefined): string | null {
  const value = (ip ?? '').replace(/^::ffff:/, '');
  if (!value || value === '::1' || value.startsWith('127.')) return null;
  const v4 = value.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (v4) return `${v4[1]}.${v4[2]}.x.x`;
  const groups = value.split(':').filter(Boolean);
  return groups.length >= 2 ? `${groups[0]}:${groups[1]}::` : null;
}
