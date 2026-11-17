import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateWorkout, notesText } from '../js/engine.js';
import { GROUPS, LIB } from '../js/exercises.js';
import { comparable, digest, expandGroups } from './helpers.js';

// Captured from the pre-refactor generator by tests/tools/capture-golden.mjs.
// The golden cases run against the library as it was when they were captured,
// so they keep proving that engine edits do not change behavior for that data.
const readJson = name => JSON.parse(readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8'));
const golden = readJson('golden.json');
const legacyLib = readJson('legacy-lib.json');
const groupIds = GROUPS.map(group => group.id);

function run(c) {
  const request = { dur: c.dur, feel: c.feel, groups: expandGroups(c.mix, groupIds), opts: c.opts, seed: c.seed };
  return generateWorkout(request, { last: golden.last, date: golden.notesDate, lib: legacyLib });
}
const label = c => `${c.name} ${c.dur}min ${c.feel} seed ${c.seed}`;

test('reproduces every workout the pre-refactor generator produced', () => {
  for (const c of golden.cases) {
    assert.equal(digest(comparable(run(c))), c.hash, label(c));
  }
});

test('reproduces the Apple Notes text for every golden case', () => {
  for (const c of golden.cases) {
    assert.equal(digest(notesText(run(c))), c.notesHash, label(c));
  }
});

test('matches the fully stored cases field by field', () => {
  const full = golden.cases.filter(c => c.workout);
  assert.ok(full.length >= 6);
  for (const c of full) {
    const workout = run(c);
    assert.deepEqual(comparable(workout), c.workout, label(c));
    assert.equal(notesText(workout), c.notes, label(c));
  }
});

test('same request and seed give the same workout; a different seed can differ', () => {
  const c = golden.cases.find(x => x.name === 'four-primary' && x.dur === '60');
  assert.deepEqual(run(c), run(c));
  const differs = [1, 2, 3, 4, 5].some(offset =>
    digest(comparable(run({ ...c, seed: c.seed + offset }))) !== c.hash);
  assert.ok(differs);
});

test('carries the request seed and context date on the workout', () => {
  const c = golden.cases[0];
  const workout = run(c);
  assert.equal(workout.seed, c.seed);
  assert.equal(workout.date, golden.notesDate);
});

test('never touches Math.random or mutates its inputs', () => {
  const realRandom = Math.random;
  Math.random = () => { throw new Error('engine called Math.random'); };
  try {
    for (const c of golden.cases) {
      const groups = expandGroups(c.mix, groupIds);
      const before = JSON.stringify({ groups, last: golden.last });
      generateWorkout({ dur: c.dur, feel: c.feel, groups, opts: c.opts, seed: c.seed },
        { last: golden.last, date: golden.notesDate, lib: legacyLib });
      assert.equal(JSON.stringify({ groups, last: golden.last }), before, label(c));
    }
  } finally {
    Math.random = realRandom;
  }
});

/* ---------- Current library ---------- */
const DATE = golden.notesDate;
const NO_OPTS = { warm: false, cooldown: false, cardio: false, superset: false };
const mainItems = workout => workout.sections.find(section => section.title === 'Main work').items;
function generate(mix, extra = {}, ctx = {}) {
  const request = { dur: '60', feel: 'ok', groups: expandGroups(mix, groupIds), opts: NO_OPTS, seed: 1, ...extra };
  return generateWorkout(request, { last: {}, date: DATE, ...ctx });
}

test('hidden exercises are never selected', () => {
  const hidden = ['bench', 'squat', 'pullup', 'lateral'];
  const mix = { chest: 25, back: 25, legs: 25, shoulders: 25 };
  for (let seed = 1; seed <= 300; seed++) {
    const ids = mainItems(generate(mix, { seed }, { hidden })).map(item => item.id);
    hidden.forEach(id => assert.ok(!ids.includes(id), `${id} selected with seed ${seed}`));
  }
});

test('a group with every exercise hidden takes no slot and does not break generation', () => {
  const calves = LIB.filter(e => e.sub === 'calves').map(e => e.id);
  const alone = generate({ calves: 100 }, {}, { hidden: calves });
  assert.equal(mainItems(alone).length, 0);
  const mixed = generate({ legs: 50, calves: 50 }, {}, { hidden: calves });
  assert.ok(mainItems(mixed).length > 0);
  mainItems(mixed).forEach(item => assert.equal(item.group, 'legs'));
  assert.equal(mixed.split.find(part => part.id === 'calves').count, 0);
});

test('assistance loads are carried unchanged by the feel setting and flagged on the item', () => {
  const dip = LIB.find(e => e.id === 'assisteddip');
  for (const feel of ['bad', 'ok', 'good']) {
    const [item] = mainItems(generate({ chest: 100 }, { feel }, { lib: [dip] }));
    assert.equal(item.id, 'assisteddip');
    assert.equal(item.w, dip.w, feel);
    assert.equal(item.loadType, 'assistance');
  }
  const bench = LIB.find(e => e.id === 'bench');
  const [plain] = mainItems(generate({ chest: 100 }, {}, { lib: [bench] }));
  assert.ok(!('loadType' in plain));
});

test('superset bonuses follow the pattern family, so an incline press still pairs like a press', () => {
  const lib = ['inclinedb', 'lawnmower'].map(id => LIB.find(e => e.id === id));
  const workout = generate({ chest: 50, back: 50 }, { opts: { ...NO_OPTS, superset: true } }, { lib });
  assert.equal(workout.supersets.length, 1);
  // back|chest 60 + horizontal press/pull family 12 + shared dumbbells 10
  assert.equal(workout.supersets[0].score, 82);
});
