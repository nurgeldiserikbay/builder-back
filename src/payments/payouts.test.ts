import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeIban, splitFee } from './payouts.js';
import { openSecret, sealSecret } from '../common/secret-box.js';

describe('Specialist payouts', () => {
  it('splits the platform fee in whole tiyn, rounding in the specialist\'s favour', () => {
    assert.deepEqual(splitFee(1_200_000, 0), { feeTiyn: 0, payoutTiyn: 1_200_000 });
    assert.deepEqual(splitFee(1_200_000, 1000), { feeTiyn: 120_000, payoutTiyn: 1_080_000 });
    assert.deepEqual(splitFee(333, 1000), { feeTiyn: 33, payoutTiyn: 300 });
  });

  it('accepts only valid Kazakhstan IBANs', () => {
    assert.equal(normalizeIban('kz86 125K ZT50 0410 0100'), 'KZ86125KZT5004100100');
    assert.equal(normalizeIban('KZ87125KZT5004100100'), null); // wrong check digits
    assert.equal(normalizeIban('DE89370400440532013000'), null);
    assert.equal(normalizeIban('KZ86125'), null);
  });

  it('keeps the IBAN encrypted and refuses a tampered value', () => {
    const key = Buffer.alloc(32, 7);
    const sealed = sealSecret('KZ86125KZT5004100100', key);
    assert.ok(!sealed.includes('KZ86'));
    assert.equal(openSecret(sealed, key), 'KZ86125KZT5004100100');
    assert.equal(openSecret(sealed.slice(0, -2) + 'AA', key), null);
    assert.equal(openSecret(sealed, Buffer.alloc(32, 8)), null);
  });
});
