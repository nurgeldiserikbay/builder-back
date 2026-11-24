import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREFS, channelsFor, parsePrefs, prefsOf } from './notification-prefs.js';

test('missing or old settings take the defaults', () => {
  assert.deepEqual(prefsOf({}), DEFAULT_PREFS);
  assert.deepEqual(prefsOf(null), DEFAULT_PREFS);
  assert.deepEqual(prefsOf({ stages: { email: true }, other: 1 }).stages, { telegram: true, email: true });
});

test('only known categories and channels are accepted', () => {
  assert.equal(parsePrefs({ money: { telegram: false, email: true } }).money.telegram, false);
  assert.throws(() => parsePrefs({ spam: { email: true } }), /UNKNOWN_FIELD/);
  assert.throws(() => parsePrefs({ money: { sms: true } }), /INVALID_CHANNELS/);
  assert.throws(() => parsePrefs({ money: { email: 'yes' } }), /INVALID_CHANNELS/);
});

test('security notices always go to both channels', () => {
  const off = parsePrefs({ stages: { telegram: false, email: false }, team: { telegram: false, email: false }, money: { telegram: false, email: false }, site: { telegram: false, email: false } });
  assert.deepEqual(channelsFor(off, 'security'), { telegram: true, email: true });
  assert.deepEqual(channelsFor(off, 'money'), { telegram: false, email: false });
});
