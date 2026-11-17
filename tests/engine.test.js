import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateWorkout, notesText } from '../js/engine.js';
import { GROUPS } from '../js/exercises.js';
import { comparable, digest, expandGroups } from './helpers.js';

// Captured from the pre-refactor generator by tests/tools/capture-golden.mjs.
const golden = JSON.parse(readFileSync(new URL('./fixtures/golden.json', import.meta.url), 'utf8'));
const groupIds = GROUPS.map(group => group.id);

function run(c) {
  const request = { dur: c.dur, feel: c.feel, groups: expandGroups(c.mix, groupIds), opts: c.opts, seed: c.seed };
  return generateWorkout(request, { last: golden.last, date: golden.notesDate });
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
        { last: golden.last, date: golden.notesDate });
      assert.equal(JSON.stringify({ groups, last: golden.last }), before, label(c));
    }
  } finally {
    Math.random = realRandom;
  }
});
