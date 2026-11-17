import { createHash } from 'node:crypto';

// Fixed local midday date so the notes header ("11/17") is stable in any time zone.
export const NOTES_DATE = '2026-11-17T12:00:00';

// { chest: 50, back: 50 } -> the full per-group state the app keeps in ST.groups.
export function expandGroups(mix, groupIds) {
  const groups = {};
  groupIds.forEach(id => { groups[id] = { on: false, pct: 0 }; });
  Object.entries(mix).forEach(([id, pct]) => { groups[id] = { on: true, pct }; });
  return groups;
}

export function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function digest(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

// The parts of a workout the generator decides. `date` comes from the clock and
// `seed` did not exist before the engine was extracted.
export function comparable(workout) {
  const { date, seed, ...rest } = JSON.parse(JSON.stringify(workout));
  return rest;
}
