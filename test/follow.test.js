import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialFollow, followMe, followPerson, followAll, dragged, pressPersonArrow, contactRemoved,
  meArrowState, personArrowState, allState,
} from '../public/follow.js';

test('the map starts by following me, with no person chosen', () => {
  const s = initialFollow();
  assert.deepEqual(s, { target: 'me', person: null });
  assert.equal(meArrowState(s), 'on');
  assert.equal(personArrowState(s), 'none');
  assert.equal(allState(s), 'off');
});

test('Show on a person follows them and chooses them for the right-hand arrow', () => {
  const s = followPerson(initialFollow(), 'ingrid');
  assert.deepEqual(s, { target: 'ingrid', person: 'ingrid' });
  assert.equal(meArrowState(s), 'off');
  assert.equal(personArrowState(s), 'on');
});

test('the left arrow follows me, and keeps the chosen person for the right arrow', () => {
  const s = followMe(followPerson(initialFollow(), 'ingrid'));
  assert.equal(s.target, 'me');
  assert.equal(s.person, 'ingrid');
  assert.equal(personArrowState(s), 'off');
});

test('dragging stops following but keeps the chosen person', () => {
  const s = dragged(followPerson(initialFollow(), 'ingrid'));
  assert.equal(s.target, null);
  assert.equal(s.person, 'ingrid');
  assert.equal(meArrowState(s), 'off');
  assert.equal(personArrowState(s), 'off');
  assert.equal(dragged(s), s);
});

test('each arrow resumes its own target after a drag', () => {
  const free = dragged(followPerson(initialFollow(), 'ingrid'));
  assert.equal(followMe(free).target, 'me');
  assert.equal(pressPersonArrow(free).target, 'ingrid');
});

test('the right arrow does nothing until a person has been chosen', () => {
  const s = initialFollow();
  assert.equal(pressPersonArrow(s), s);
});

test('All keeps everyone in view, and is left by dragging or by choosing another target', () => {
  const s = followAll(initialFollow());
  assert.equal(s.target, 'all');
  assert.equal(allState(s), 'on');
  assert.equal(meArrowState(s), 'off');
  assert.equal(allState(dragged(s)), 'off');
  assert.equal(allState(followMe(s)), 'off');
  assert.equal(followAll(followPerson(initialFollow(), 'ingrid')).person, 'ingrid');
});

test('a removed contact is never followed or kept as the chosen person', () => {
  assert.deepEqual(contactRemoved(followPerson(initialFollow(), 'ingrid'), 'ingrid'), { target: 'me', person: null });
  assert.deepEqual(contactRemoved(dragged(followPerson(initialFollow(), 'ingrid')), 'ingrid'), { target: null, person: null });
  const other = followPerson(initialFollow(), 'mats');
  assert.deepEqual(contactRemoved(other, 'ingrid'), other);
});
