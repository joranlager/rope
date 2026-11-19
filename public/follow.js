// Which thing the map is following. Pure, so it is unit tested.
//
//   target: 'me' | <contact id> | null   (null = free: the user has dragged the map away)
//   last:   what to resume when the arrow is tapped after a drag
//
// The app opens following the user's own position. "Show" on a person follows that
// person. Dragging the map stops following. The arrow button resumes it.

export const initialFollow = () => ({ target: 'me', last: 'me' });

export const followMe = () => ({ target: 'me', last: 'me' });

export const followPerson = (_s, id) => ({ target: id, last: id });

/** The user dragged the map: stop following, but remember what to resume. */
export const dragged = (s) => (s.target === null ? s : { target: null, last: s.target });

/**
 * The arrow button:
 *   after a drag        -> resume what was being followed
 *   following a person  -> go back to following me
 *   already following me -> unchanged (the caller can re-centre)
 */
export function arrowPressed(s) {
  if (s.target === null) return { target: s.last, last: s.last };
  if (s.target !== 'me') return followMe();
  return s;
}

/** A contact went away: never keep following someone who is gone. */
export function contactRemoved(s, id) {
  return {
    target: s.target === id ? 'me' : s.target,
    last: s.last === id ? 'me' : s.last,
  };
}

/** For the arrow's look: filled when following me, outlined otherwise. */
export const arrowState = (s) => (s.target === 'me' ? 'me' : s.target === null ? 'off' : 'person');
