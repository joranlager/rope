// What the map is following. Pure, so it is unit tested.
//
//   target: 'me' | 'all' | <contact id> | null   (null = free: the user dragged the map away)
//   person: the contact chosen with "Show", or null. The bottom-right arrow follows this person.
//
// Three controls set the target:
//   bottom-left arrow  -> follow me
//   bottom-right arrow -> follow the chosen person
//   "All" in the menu  -> follow me, zoomed out so everyone is in view
// Dragging the map by hand frees it. Each control then resumes its own target. Zooming by hand
// leaves "All" (the app then follows me at that zoom).

export const initialFollow = () => ({ target: 'me', person: null });

export const followMe = (s) => ({ ...s, target: 'me' });

/** "Show" on a person: follow them, and make them the person the right-hand arrow follows. */
export const followPerson = (s, id) => ({ ...s, target: id, person: id });

export const followAll = (s) => ({ ...s, target: 'all' });

/** The user dragged the map: stop following. */
export const dragged = (s) => (s.target === null ? s : { ...s, target: null });

/** The right-hand arrow: follow the chosen person again (nothing if none was chosen). */
export const pressPersonArrow = (s) => (s.person ? followPerson(s, s.person) : s);

/** A contact went away: never keep following someone who is gone. */
export function contactRemoved(s, id) {
  return { target: s.target === id ? 'me' : s.target, person: s.person === id ? null : s.person };
}

// For the arrows' look: "on" = following that target (filled arrow), "off" = outlined.
export const meArrowState = (s) => (s.target === 'me' ? 'on' : 'off');
export const personArrowState = (s) => (!s.person ? 'none' : s.target === s.person ? 'on' : 'off');
export const allState = (s) => (s.target === 'all' ? 'on' : 'off');
