import { lookup } from 'node:dns/promises';

interface ReviewDnsAddress {
  readonly address: string;
  readonly family: number;
}
import { isIP } from 'node:net';

export type ReviewTargetPolicyErrorCode =
  | 'URL_INVALID'
  | 'URL_SCHEME_NOT_ALLOWED'
  | 'URL_CREDENTIALS_NOT_ALLOWED'
  | 'URL_PORT_NOT_ALLOWED'
  | 'URL_HOST_NOT_ALLOWED'
  | 'URL_DNS_LOOKUP_FAILED'
  | 'URL_ADDRESS_NOT_PUBLIC';

export class ReviewTargetPolicyError extends Error {
  constructor(readonly code: ReviewTargetPolicyErrorCode) {
    super(code);
    this.name = 'ReviewTargetPolicyError';
  }
}

export interface ValidatedReviewTarget {
  /** Canonical URL to persist; remove secrets from this value before logging. */
  readonly url: string;
  /** Host header and TLS server name that the worker must preserve. */
  readonly hostname: string;
  /** Public addresses resolved during validation. The worker must pin its connection to one of these. */
  readonly resolvedAddresses: readonly string[];
}

export interface ReviewTargetPolicyOptions {
  /** Resolver injection keeps DNS behavior explicit and makes unit testing deterministic. */
  readonly resolve?: (hostname: string) => Promise<readonly ReviewDnsAddress[]>;
}

/**
 * Validates a URL before a review worker is allowed to fetch it.
 *
 * This function does not fetch the target and is not, by itself, an SSRF boundary.
 * The worker must connect to one of resolvedAddresses without a second uncontrolled
 * DNS lookup, revalidate every redirect, and enforce network egress restrictions.
 */
export async function resolveAndValidateReviewTarget(
  rawUrl: string,
  options: ReviewTargetPolicyOptions = {},
): Promise<ValidatedReviewTarget> {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 2048) {
    throw new ReviewTargetPolicyError('URL_INVALID');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ReviewTargetPolicyError('URL_INVALID');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ReviewTargetPolicyError('URL_SCHEME_NOT_ALLOWED');
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new ReviewTargetPolicyError('URL_CREDENTIALS_NOT_ALLOWED');
  }
  if (parsed.port.length > 0) {
    throw new ReviewTargetPolicyError('URL_PORT_NOT_ALLOWED');
  }

  const hostFromUrl = parsed.hostname.toLowerCase();
  const hostname = hostFromUrl.startsWith('[') && hostFromUrl.endsWith(']')
    ? hostFromUrl.slice(1, -1)
    : hostFromUrl;
  const normalizedHostname = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;

  if (!normalizedHostname || isBlockedHostname(normalizedHostname)) {
    throw new ReviewTargetPolicyError('URL_HOST_NOT_ALLOWED');
  }

  let addresses: readonly ReviewDnsAddress[];
  const family = isIP(normalizedHostname);
  if (family > 0) {
    addresses = [{ address: normalizedHostname, family }];
  } else {
    const resolver = options.resolve ?? resolveAll;
    try {
      addresses = await resolver(normalizedHostname);
    } catch {
      throw new ReviewTargetPolicyError('URL_DNS_LOOKUP_FAILED');
    }
  }

  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new ReviewTargetPolicyError('URL_ADDRESS_NOT_PUBLIC');
  }

  parsed.hostname = family === 6 ? `[${normalizedHostname}]` : normalizedHostname;
  parsed.hash = '';

  return {
    url: parsed.toString(),
    hostname: normalizedHostname,
    resolvedAddresses: [...new Set(addresses.map(({ address }) => address))],
  };
}

async function resolveAll(hostname: string): Promise<readonly ReviewDnsAddress[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

function isBlockedHostname(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return value === 'localhost'
    || value === 'localhost.localdomain'
    || value === 'metadata.google.internal'
    || value.endsWith('.localhost')
    || value.endsWith('.local')
    || value.endsWith('.internal')
    || value.endsWith('.test')
    || value.endsWith('.invalid')
    || value.endsWith('.example');
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b, c] = octets;
  if (a === undefined || b === undefined || c === undefined) return false;

  return !(
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
  );
}

function isPublicIpv6(address: string): boolean {
  const value = parseIpv6(address);
  if (value === null) return false;

  // Accept only global unicast (2000::/3). This excludes loopback, link-local,
  // unique-local, IPv4-mapped and unspecified ranges by default.
  if ((value >> 125n) !== 1n) return false;

  // Exclude documentation, protocol-assignment, Teredo, and 6to4 ranges.
  if (hasIpv6Prefix(value, 0x20010db8n, 32)) return false; // 2001:db8::/32
  if (hasIpv6Prefix(value, 0x3fffn, 20)) return false; // 3fff::/20
  if (hasIpv6Prefix(value, 0x20010000n, 23)) return false; // 2001::/23
  if (hasIpv6Prefix(value, 0x2002000000000000n, 16)) return false; // 2002::/16

  return true;
}

function hasIpv6Prefix(address: bigint, prefix: bigint, bits: number): boolean {
  return (address >> BigInt(128 - bits)) === prefix;
}

function parseIpv6(address: string): bigint | null {
  if (address.includes('%')) return null;

  let value = address.toLowerCase();
  if (value.includes('.')) {
    const splitAt = value.lastIndexOf(':');
    if (splitAt < 0) return null;
    const ipv4 = value.slice(splitAt + 1);
    if (!isPublicIpv4(ipv4)) return null;
    const octets = ipv4.split('.').map(Number);
    if (octets.length !== 4) return null;
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    value = `${value.slice(0, splitAt)}:${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;

  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;

  return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n);
}
