// Fixed local midday date so the notes header ("11/17") is stable in any time zone.
export const NOTES_DATE = '2026-11-17T12:00:00';

// { chest: 50, back: 50 } -> the full per-group state the app keeps in ST.groups.
export function expandGroups(mix, groupIds) {
  const groups = {};
  groupIds.forEach(id => { groups[id] = { on: false, pct: 0 }; });
  Object.entries(mix).forEach(([id, pct]) => { groups[id] = { on: true, pct }; });
  return groups;
}

export const mainItems = workout => workout.sections.find(section => section.title === 'Main work').items;
