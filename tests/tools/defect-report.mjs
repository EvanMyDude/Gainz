// Prints how often the current generator produces known-bad workouts, as a
// markdown table. Seeded, so the numbers are reproducible: `npm run baseline`.
// This is a measurement, not a test; the selection rework is judged against it.
import { readFileSync } from 'node:fs';
import { generateWorkout } from '../../js/engine.js';
import { GROUPS } from '../../js/exercises.js';
import { expandGroups } from '../helpers.js';

const RUNS = 2000;
const golden = JSON.parse(readFileSync(new URL('../fixtures/golden.json', import.meta.url), 'utf8'));
const groupIds = GROUPS.map(group => group.id);
const opts = { warm: true, cooldown: false, cardio: false, superset: false };

function sample(mix, dur, feel = 'ok') {
  const groups = expandGroups(mix, groupIds);
  const runs = [];
  for (let seed = 1; seed <= RUNS; seed++) {
    const workout = generateWorkout({ dur, feel, groups, opts, seed }, { last: golden.last, date: golden.notesDate });
    runs.push(workout.sections.find(section => section.title === 'Main work').items);
  }
  return runs;
}
const pct = (runs, test) => (runs.length ? (runs.filter(test).length / runs.length * 100).toFixed(1) + '%' : 'n/a');
const mean = values => (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1);
const count = (items, test) => items.filter(test).length;
const pattern = item => item.pairMeta.pattern;
const has = (items, id) => items.some(item => item.id === id);
const sets = items => items.reduce((sum, item) => sum + item.sets, 0);
const distinct = runs => new Set(runs.map(items => items.map(item => item.id).sort().join())).size;
function isolationBeforeCompound(items) {
  let seenIsolation = false;
  for (const item of items) {
    if (item.t === 'i') seenIsolation = true;
    else if (seenIsolation) return true;
  }
  return false;
}

const rows = [];
const row = (config, metric, value) => rows.push(`| ${config} | ${metric} | ${value} |`);

for (const dur of ['15', '30', '60']) {
  const runs = sample({ chest: 100 }, dur);
  row(`Chest, ${dur} min`, 'lifts / sets', `${mean(runs.map(r => r.length))} / ${mean(runs.map(sets))}`);
  row(`Chest, ${dur} min`, '4+ horizontal presses', pct(runs, r => count(r, i => pattern(i) === 'horizontal_press') >= 4));
  row(`Chest, ${dur} min`, 'distinct workouts', distinct(runs));
}
for (const dur of ['15', '30', '60']) {
  const runs = sample({ legs: 100 }, dur);
  row(`Legs, ${dur} min`, 'no hinge and no leg curl', pct(runs, r => !r.some(i => ['hinge', 'knee_flexion'].includes(pattern(i)))));
  row(`Legs, ${dur} min`, 'Bulgarian split squat and walking lunge together', pct(runs, r => count(r, i => pattern(i) === 'unilateral_legs') >= 2));
  row(`Legs, ${dur} min`, '4+ high-fatigue lifts', pct(runs, r => count(r, i => i.pairMeta.fatigue === 'high') >= 4));
}
for (const dur of ['15', '30', '60']) {
  const runs = sample({ back: 100 }, dur);
  row(`Back, ${dur} min`, '3+ vertical pulls', pct(runs, r => count(r, i => pattern(i) === 'vertical_pull') >= 3));
  row(`Back, ${dur} min`, 'deadlift not first (when present)', pct(runs.filter(r => has(r, 'deadlift')), r => r[0].id !== 'deadlift'));
}
{
  const runs = sample({ chest: 50, shoulders: 30, tris: 20 }, '60');
  const config = 'Chest 50 / shoulders 30 / triceps 20, 60 min';
  row(config, 'isolation before a compound', pct(runs, isolationBeforeCompound));
  row(config, 'bench and barbell OHP together', pct(runs, r => has(r, 'bench') && has(r, 'ohp')));
  row(config, '5+ presses', pct(runs, r => count(r, i => /press/.test(pattern(i))) >= 5));
  row(config, 'no lateral raise', pct(runs, r => !r.some(i => pattern(i) === 'lateral_raise')));
}
{
  const runs = sample({ back: 50, legs: 50 }, '60');
  row('Back 50 / legs 50, 60 min', 'deadlift and RDL together', pct(runs, r => has(r, 'deadlift') && has(r, 'rdl')));
  row('Back 50 / legs 50, 60 min', 'isolation before a compound', pct(runs, isolationBeforeCompound));
}
for (const dur of ['15', '30', '60']) for (const feel of ['bad', 'ok', 'good']) {
  const runs = sample({ chest: 40, back: 40, bis: 20 }, dur, feel);
  row(`Chest 40 / back 40 / biceps 20, ${dur} min, ${feel}`, 'lifts / sets', `${mean(runs.map(r => r.length))} / ${mean(runs.map(sets))}`);
}
{
  const runs = sample({ chest: 50, back: 50 }, '30');
  let overlap = 0;
  for (let i = 1; i < runs.length; i++) {
    const previous = new Set(runs[i - 1].map(item => item.id));
    overlap += count(runs[i], item => previous.has(item.id)) / runs[i].length;
  }
  row('Chest 50 / back 50, 30 min', 'exercises shared with the previous generation', (overlap / (runs.length - 1) * 100).toFixed(0) + '%');
}

console.log(`Seeds 1 to ${RUNS} per configuration, warm-up on, supersets off.\n`);
console.log('| Configuration | Metric | Value |\n|---|---|---|');
console.log(rows.join('\n'));
