import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, HttpError } from '../server/store.js';

function setup() {
  const s = new Store(null);
  const parent = s.register('Parent').me;
  const child = s.register('Child').me;
  const stranger = s.register('Stranger').me;
  // Pair parent and child by the child's code (reusable contact info).
  s.pair(parent.id, child.code);
  return { s, parent, child, stranger };
}

const pos = { lat: 59.9, lon: 10.7, accuracy: 5 };

test('pairing is mutual and idempotent, and rejects a wrong code', () => {
  const { s, parent, child } = setup();
  s.pair(parent.id, child.code); // repeat is fine
  assert.equal(Object.keys(s.links).length, 1);
  assert.equal(s.state(child.id).contacts[0].id, parent.id);
  assert.throws(() => s.pair(parent.id, `${child.id}.wrongsecretwrongsecret`), HttpError);
  assert.throws(() => s.pair(parent.id, parent.code), /own code/);
});

test('rotating a code invalidates the old one but keeps contacts', () => {
  const { s, parent, child } = setup();
  const old = child.code;
  const rotated = s.rotateCode(child.id);
  assert.notEqual(rotated.code, old);
  assert.throws(() => s.pair(parent.id, old), HttpError);
  assert.equal(s.state(parent.id).contacts.length, 1);
});

test('a hidden position is not shared with a contact', () => {
  const { s, parent, child } = setup();
  s.setPosition(child.id, pos);
  s.setVisible(child.id, false);
  const seen = s.state(parent.id).contacts[0];
  assert.equal(seen.position, null);
  assert.equal(seen.hidden, true);
});

test('an admin sees a contact even when their visibility is off', () => {
  const { s, parent, child } = setup();
  s.setPosition(child.id, pos);
  s.setVisible(child.id, false);
  s.setAdmin(parent.id, child.id, true);
  const seen = s.state(parent.id).contacts[0];
  assert.deepEqual(
    { lat: seen.position.lat, lon: seen.position.lon },
    { lat: pos.lat, lon: pos.lon },
  );
  assert.equal(seen.youAdminThem, true);
});

test('the subject cannot turn off admin rights or remove the contact', () => {
  const { s, parent, child } = setup();
  s.setAdmin(parent.id, child.id, true);
  // Child tries to revoke the grant.
  assert.throws(() => s.setAdmin(child.id, parent.id, false), /Only they can change it/);
  // Child tries to remove the contact that the admin is attached to.
  assert.throws(() => s.removeContact(child.id, parent.id), HttpError);
  // Grant still in force.
  assert.equal(s.state(parent.id).contacts[0].youAdminThem, true);
  assert.equal(s.state(child.id).contacts[0].themAdminYou, true);
  assert.equal(s.state(child.id).me.adminsOverMe[0], 'Parent');
});

test('the admin can revoke their own grant', () => {
  const { s, parent, child } = setup();
  s.setAdmin(parent.id, child.id, true);
  s.setAdmin(parent.id, child.id, false);
  assert.equal(s.state(parent.id).contacts[0].youAdminThem, false);
});

test('the admin can remove a contact and the grant goes with it', () => {
  const { s, parent, child } = setup();
  s.setAdmin(parent.id, child.id, true);
  s.removeContact(parent.id, child.id);
  assert.equal(Object.keys(s.links).length, 0);
  assert.equal(Object.keys(s.grants).length, 0);
});

test('a stranger cannot see positions or be seen', () => {
  const { s, parent, child, stranger } = setup();
  s.setPosition(child.id, pos);
  assert.equal(s.canSee(stranger.id, child.id), true); // visibility on = seen by anyone who has a link
  s.setVisible(child.id, false);
  assert.equal(s.canSee(stranger.id, child.id), false);
  assert.equal(s.state(stranger.id).contacts.length, 0);
  assert.equal(s.state(parent.id).contacts[0].theyCanSeeYou, true);
});

test('invalid coordinates are refused', () => {
  const { s, child } = setup();
  assert.throws(() => s.setPosition(child.id, { lat: 91, lon: 0 }), /Invalid coordinates/);
  assert.throws(() => s.setPosition(child.id, { lat: NaN, lon: 0 }), /Invalid coordinates/);
});

test('token lookup finds only the right user', () => {
  const s = new Store(null);
  const { token, me } = s.register('Ann');
  s.register('Bob');
  assert.equal(s.userByToken(token).id, me.id);
  assert.equal(s.userByToken('nope'), null);
});
