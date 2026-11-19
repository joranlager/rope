import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialFollow, followMe, followPerson, dragged, arrowPressed, contactRemoved, arrowState,
} from '../public/follow.js';

test('the map starts by following me', () => {
  assert.deepEqual(initialFollow(), { target: 'me', last: 'me' });
  assert.equal(arrowState(initialFollow()), 'me');
});

test('Show on a person follows that person', () => {
  const s = followPerson(initialFollow(), 'ingrid');
  assert.deepEqual(s, { target: 'ingrid', last: 'ingrid' });
  assert.equal(arrowState(s), 'person');
});

test('dragging stops following', () => {
  const s = dragged(initialFollow());
  assert.equal(s.target, null);
  assert.equal(arrowState(s), 'off');
  assert.equal(dragged(s), s); // a second drag changes nothing
});

test('the arrow after a drag resumes what was followed', () => {
  assert.deepEqual(arrowPressed(dragged(followMe())), { target: 'me', last: 'me' });
  const person = dragged(followPerson(followMe(), 'ingrid'));
  assert.deepEqual(arrowPressed(person), { target: 'ingrid', last: 'ingrid' });
});

test('the arrow while following a person goes back to me', () => {
  assert.deepEqual(arrowPressed(followPerson(followMe(), 'ingrid')), { target: 'me', last: 'me' });
});

test('the arrow while already following me changes nothing', () => {
  const s = followMe();
  assert.equal(arrowPressed(s), s);
});

test('a removed contact is never followed or resumed', () => {
  assert.deepEqual(contactRemoved(followPerson(followMe(), 'ingrid'), 'ingrid'), { target: 'me', last: 'me' });
  assert.deepEqual(contactRemoved(dragged(followPerson(followMe(), 'ingrid')), 'ingrid'), { target: null, last: 'me' });
  const other = followPerson(followMe(), 'mats');
  assert.equal(contactRemoved(other, 'ingrid').target, 'mats');
});
