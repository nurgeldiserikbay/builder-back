import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkContacts, checkRequest, contactChanges, instructionFor, targetFor } from './quick-edit.js';

const booking = ['goal', 'process', 'offer', 'schedule', 'techplan', 'content', 'design', 'build'] as const;

describe('quick edit', () => {
  it('sends look requests to the design stage and everything else to texts', () => {
    assert.equal(targetFor('Сделайте фон потемнее и шрифт крупнее', [...booking], null), 'design');
    assert.equal(targetFor('Поменяйте телефон на +7 701 000 00 00', [...booking], null), 'content');
    assert.equal(targetFor('Make it dark', [...booking], null), 'design');
    // «телефон» contains «фон», «стиль» starts a word but «настил» does not.
    assert.equal(targetFor('Новый телефон и настил в описании', [...booking], null), 'content');
    assert.equal(targetFor('Цвет кнопок — зелёный', [...booking], null), 'design');
  });
  it('lets the owner choose, but only stages whose only dependent is the build', () => {
    assert.equal(targetFor('Новая цена', [...booking], 'design'), 'design');
    assert.equal(targetFor('Новая цена', [...booking], 'offer'), null);
    assert.equal(targetFor('Новая цена', ['goal', 'build'], null), null);
  });
  it('checks the request and tells the AI to keep the rest', () => {
    assert.deepEqual(checkRequest('ок'), { ok: false, code: 'QUICK_EDIT_REQUEST_INVALID' });
    assert.deepEqual(checkRequest('  Новый телефон  '), { ok: true, request: 'Новый телефон' });
    assert.match(instructionFor('Новый телефон'), /остальное оставь как есть/);
  });
});

describe('quick edit of contacts', () => {
  it('accepts a new phone and an empty field as removal, refuses junk', () => {
    const checked = checkContacts({ phone: ' +7 (777) 000-11-22 ', messenger: '', email: null, address: 'Алматы, Абая 10' });
    assert.ok(checked.ok);
    assert.deepEqual(checked.contacts, { phone: '+7 (777) 000-11-22', messenger: null, email: null, address: 'Алматы, Абая 10' });
    assert.deepEqual(checkContacts({ phone: 'позвоните' }), { ok: false, code: 'QUICK_EDIT_CONTACT_INVALID:phone' });
    assert.deepEqual(checkContacts({ email: 'aigul@' }), { ok: false, code: 'QUICK_EDIT_CONTACT_INVALID:email' });
    assert.deepEqual(checkContacts({ site: 'x' }), { ok: false, code: 'UNKNOWN_FIELD' });
  });
  it('lists only the fields that change', () => {
    assert.deepEqual(contactChanges({ phone: '+7 701 111 22 33', email: 'a@b.kz' }, { phone: '+7 777 000 11 22', messenger: null, email: 'a@b.kz', address: null }),
      [{ field: 'phone', before: '+7 701 111 22 33', after: '+7 777 000 11 22' }]);
  });
});
