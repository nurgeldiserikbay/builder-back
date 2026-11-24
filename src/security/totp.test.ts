import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Decode, base32Encode, codeAt, findRecoveryCode, hashRecoveryCode, newRecoveryCodes, newSecret, otpauthUri, stepAt, verifyCode } from './totp.js';

// RFC 6238, appendix B: the SHA-1 secret is ASCII «12345678901234567890», 8 digits.
const rfcSecret = base32Encode(Buffer.from('12345678901234567890'));

test('codes match the RFC 6238 test vectors', () => {
  assert.equal(codeAt(rfcSecret, Math.floor(59 / 30), 8), '94287082');
  assert.equal(codeAt(rfcSecret, Math.floor(1111111109 / 30), 8), '07081804');
  assert.equal(codeAt(rfcSecret, Math.floor(1234567890 / 30), 8), '89005924');
  assert.equal(codeAt(rfcSecret, Math.floor(20000000000 / 30), 8), '65353130');
});

test('base32 round-trips and a new secret is 32 characters', () => {
  const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 7]);
  assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
  assert.match(newSecret(), /^[A-Z2-7]{32}$/);
});

test('a code is accepted one step either side, never twice', () => {
  const secret = newSecret();
  const now = new Date('2026-11-24T12:00:10Z');
  const step = stepAt(now);
  assert.equal(verifyCode(secret, codeAt(secret, step), now, null), step);
  assert.equal(verifyCode(secret, codeAt(secret, step - 1), now, null), step - 1);
  assert.equal(verifyCode(secret, codeAt(secret, step + 1), now, null), step + 1);
  assert.equal(verifyCode(secret, codeAt(secret, step - 2), now, null), null);
  assert.equal(verifyCode(secret, codeAt(secret, step), now, step), null, 'the same step again is refused');
  assert.equal(verifyCode(secret, '12345', now, null), null);
  assert.equal(verifyCode(secret, ` ${codeAt(secret, step).slice(0, 3)} ${codeAt(secret, step).slice(3)} `, now, null), step, 'spaces are ignored');
});

test('recovery codes are found by hash, written in any case and with or without the dash', () => {
  const codes = newRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.ok(codes.every((code) => /^[A-Z2-7]{4}-[A-Z2-7]{4}$/.test(code)));
  const hashes = codes.map(hashRecoveryCode);
  assert.equal(findRecoveryCode(codes[3]!.toLowerCase().replace('-', ''), hashes), 3);
  assert.equal(findRecoveryCode('AAAA-AAAA', hashes), -1);
  assert.equal(findRecoveryCode('not a code', hashes), -1);
});

test('the otpauth link carries the issuer, account and parameters apps need', () => {
  const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'ann@example.com');
  assert.equal(uri, 'otpauth://totp/BuildPath%3Aann%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=BuildPath&algorithm=SHA1&digits=6&period=30');
});
