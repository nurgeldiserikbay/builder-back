import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { maskEmail } from './masters.service.js';
import { privacyPage } from '../sites/site-pages.js';

describe('Masters', () => {
  it('shows only a hint of the invited address', () => {
    assert.equal(maskEmail('timur@mail.kz'), 'ti•••@mail.kz');
    assert.equal(maskEmail('a@b.kz'), 'a•@b.kz');
  });
  it('tells booking clients that the master sees their booking', () => {
    const meta = { businessName: 'Усы', ownerContacts: [], booking: { schedule: { rules: { cancelHours: 3 } } } } as unknown as Parameters<typeof privacyPage>[0];
    assert.match(privacyPage(meta, 365), /мастер, к которому вы записались/);
    assert.doesNotMatch(privacyPage({ ...meta!, booking: undefined } as typeof meta, 365), /мастер/);
  });
});
