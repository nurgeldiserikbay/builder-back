// Own domain for a site on BuildPath: address rules, the DNS record to create, and the check that it points here.
import { promises as dns } from 'node:dns';
import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';

export interface DomainTarget { cname: string | null; ipv4: string[]; hostedInKz: boolean }

export function domainTarget(env = process.env): DomainTarget | null {
  const cname = env.SITES_CNAME_TARGET?.trim().toLowerCase().replace(/\.$/, '') || null;
  const ipv4 = (env.SITES_PUBLIC_IPV4 ?? '').split(',').map((item) => item.trim()).filter((item) => isIP(item) === 4);
  if (!cname && !ipv4.length) return null;
  return { cname, ipv4, hostedInKz: env.SITES_HOSTED_IN_KZ === 'true' };
}

export type DomainProblem = 'DOMAIN_INVALID' | 'DOMAIN_IS_PLATFORM' | 'DOMAIN_KZ_NEEDS_KZ_HOSTING';

/** Lower-case ASCII (punycode) form; Cyrillic .қаз names are converted. */
export function normalizeDomain(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  if (!trimmed || trimmed.includes(':') || trimmed.includes('@')) return null;
  const ascii = domainToASCII(trimmed);
  if (!ascii || ascii.length > 253 || isIP(ascii)) return null;
  const labels = ascii.split('.');
  if (labels.length < 2) return null;
  if (!labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(labels.at(-1)!)) return null;
  return ascii;
}

/** .kz and .қаз sites must be hosted on servers in Kazakhstan (KazNIC rules). */
export const isKzZone = (domain: string) => domain.endsWith('.kz') || domain.endsWith('.xn--80ao21a');

export function domainProblem(domain: string | null, baseDomain: string, target: DomainTarget): DomainProblem | null {
  if (!domain) return 'DOMAIN_INVALID';
  if (domain === baseDomain || domain.endsWith(`.${baseDomain}`)) return 'DOMAIN_IS_PLATFORM';
  if (isKzZone(domain) && !target.hostedInKz) return 'DOMAIN_KZ_NEEDS_KZ_HOSTING';
  return null;
}

/** A subdomain (www.shop.kz) can use CNAME; the main name (shop.kz) needs A records. */
export function isApex(domain: string): boolean {
  const labels = domain.split('.');
  const secondLevel = ['com', 'org', 'net', 'edu', 'gov'].includes(labels.at(-2) ?? '') && labels.length >= 3;
  return labels.length === (secondLevel ? 3 : 2);
}

export interface DnsRecord { type: 'CNAME' | 'A'; name: string; value: string }

export function recordsFor(domain: string, target: DomainTarget): DnsRecord[] {
  const host = isApex(domain) ? '@' : domain.split('.')[0]!;
  if (!isApex(domain) && target.cname) return [{ type: 'CNAME', name: host, value: target.cname }];
  return target.ipv4.map((ip) => ({ type: 'A' as const, name: host, value: ip }));
}

type Resolver = { resolveCname: (name: string) => Promise<string[]>; resolve4: (name: string) => Promise<string[]> };

/** Points here if the CNAME is our target, or every A record is one of our addresses. */
export async function pointsHere(domain: string, target: DomainTarget, resolver: Resolver = dns): Promise<{ ok: boolean; found: string[] }> {
  const cnames = await resolver.resolveCname(domain).catch(() => [] as string[]);
  const clean = cnames.map((item) => item.toLowerCase().replace(/\.$/, ''));
  if (target.cname && clean.includes(target.cname)) return { ok: true, found: clean };
  const addresses = await resolver.resolve4(domain).catch(() => [] as string[]);
  if (addresses.length && target.ipv4.length && addresses.every((ip) => target.ipv4.includes(ip))) return { ok: true, found: addresses };
  return { ok: false, found: [...clean, ...addresses] };
}
