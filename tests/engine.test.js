import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DURATIONS, MINUTES_PER_SET, generateWorkout, notesText, planBudget } from '../js/engine.js';
import { MAX_SETS, MIN_SETS, lintWorkout } from '../js/rules.js';
import { GROUPS, LIB } from '../js/exercises.js';
import { NOTES_DATE, expandGroups, mainItems } from './helpers.js';

const groupIds = GROUPS.map(group => group.id);
const NO_OPTS = { warm: false, cooldown: false, cardio: false, superset: false };
function generate(mix, extra = {}, ctx = {}) {
  const request = { dur: '60', feel: 'ok', groups: expandGroups(mix, groupIds), opts: NO_OPTS, seed: 1, ...extra };
  return generateWorkout(request, { last: {}, date: NOTES_DATE, ...ctx });
}
const patterns = items => items.map(item => item.pairMeta.pattern);
const inGroup = (items, group) => items.filter(item => item.group === group);

/* ---------- Property tests over the configuration matrix ---------- */
const SEEDS = 500;
const FEELS = ['bad', 'ok', 'good'];
const MIXES = [
  ...groupIds.map(id => ({ name: id, mix: { [id]: 100 } })),
  { name: 'push', mix: { chest: 50, shoulders: 30, tris: 20 } },
  { name: 'pull', mix: { back: 60, bis: 25, core: 15 } },
  { name: 'arms', mix: { bis: 50, tris: 50 } },
  { name: 'back-legs', mix: { back: 50, legs: 50 } },
  { name: 'shoulders-chest', mix: { shoulders: 70, chest: 30 } },
  { name: 'legs-calves-core', mix: { legs: 60, calves: 20, core: 20 } },
  { name: 'four-primary', mix: { chest: 25, back: 25, legs: 25, shoulders: 25 } },
  { name: 'upper', mix: { chest: 30, back: 30, shoulders: 20, bis: 10, tris: 10 } },
  { name: 'six-group', mix: { chest: 20, back: 20, legs: 20, shoulders: 20, bis: 10, tris: 10 } },
  { name: 'everything', mix: { chest: 20, back: 20, legs: 20, shoulders: 15, bis: 5, tris: 5, core: 10, calves: 5 } },
];
const CONFIGS = [];
for (const dur of Object.keys(DURATIONS)) for (const feel of FEELS) for (const { name, mix } of MIXES) {
  if (Object.keys(mix).length <= DURATIONS[dur].maxGroups) CONFIGS.push({ name, mix, dur, feel });
}
const label = (c, seed) => `${c.name} ${c.dur}min ${c.feel} seed ${seed}`;
// A request the time or the library cannot satisfy. Worked out here from first
// principles rather than by asking the engine, so the check is independent.
function infeasible(c) {
  const budget = planBudget(c.dur, c.feel);
  const tooManyGroups = Object.keys(c.mix).length * MIN_SETS > budget + 1;
  const calvesAlone = c.name === 'calves' && LIB.filter(e => e.sub === 'calves').length * MAX_SETS < budget - 1;
  return tooManyGroups || calvesAlone;
}

test('every feasible request yields a workout with no rule violations and nothing left unstated', () => {
  let checked = 0;
  for (const c of CONFIGS) {
    const allowed = infeasible(c) ? ['budget'] : [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const workout = generate(c.mix, { dur: c.dur, feel: c.feel, seed });
      const noted = workout.notes.map(note => note.rule);
      assert.deepEqual(noted.filter(rule => !allowed.includes(rule)), [], `${label(c, seed)}: ${JSON.stringify(workout.notes)}`);
      // Anything the linter still finds must have been stated on the workout.
      for (const problem of lintWorkout(workout)) assert.ok(noted.includes(problem.rule), `${label(c, seed)}: ${problem.text}`);
      checked++;
    }
  }
  assert.ok(checked > 50000);
});

test('feasible sessions land within one set of the budget, with 2 to 4 sets per exercise', () => {
  for (const c of CONFIGS.filter(c => !infeasible(c))) {
    for (let seed = 1; seed <= 50; seed++) {
      const workout = generate(c.mix, { dur: c.dur, feel: c.feel, seed });
      const items = mainItems(workout);
      const total = items.reduce((sum, item) => sum + item.sets, 0);
      assert.ok(Math.abs(total - planBudget(c.dur, c.feel)) <= 1, `${label(c, seed)}: ${total} sets`);
      assert.equal(workout.sets, total);
      assert.equal(workout.minutes, Math.round(total * MINUTES_PER_SET));
      items.forEach(item => assert.ok(item.sets >= MIN_SETS && item.sets <= MAX_SETS, `${label(c, seed)}: ${item.name} x${item.sets}`));
    }
  }
});

// The headline defects of the old generator, checked directly rather than through the linter.
test('muscle groups cover their essential movements', () => {
  const squatType = ['squat', 'unilateral_legs'], hipOrHamstring = ['hinge', 'hip_thrust', 'knee_flexion'];
  for (const c of CONFIGS) for (let seed = 1; seed <= 100; seed++) {
    const items = mainItems(generate(c.mix, { dur: c.dur, feel: c.feel, seed }));
    const legs = patterns(inGroup(items, 'legs')), back = patterns(inGroup(items, 'back')), shoulders = patterns(inGroup(items, 'shoulders'));
    if (legs.length >= 2) assert.ok(legs.some(p => squatType.includes(p)) && legs.some(p => hipOrHamstring.includes(p)), `${label(c, seed)}: legs ${legs}`);
    if (back.length >= 2) assert.ok(back.includes('vertical_pull') && back.includes('horizontal_pull'), `${label(c, seed)}: back ${back}`);
    if (shoulders.length >= 2) assert.ok(shoulders.includes('lateral_raise'), `${label(c, seed)}: shoulders ${shoulders}`);
  }
});

test('never pairs a deadlift with a Romanian deadlift', () => {
  for (const dur of Object.keys(DURATIONS)) for (let seed = 1; seed <= SEEDS; seed++) {
    const ids = mainItems(generate({ back: 50, legs: 50 }, { dur, seed })).map(item => item.id);
    assert.ok(ids.filter(id => ['deadlift', 'rdl', 'dbrdl'].includes(id)).length <= 1, `${dur} seed ${seed}: ${ids}`);
  }
});

test('compounds lead: no isolation precedes a compound, and triceps never precede a press', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const items = mainItems(generate({ chest: 50, shoulders: 30, tris: 20 }, { seed }));
    const lastCompound = items.map(item => item.t).lastIndexOf('c');
    const firstIsolation = items.map(item => item.t).indexOf('i');
    assert.ok(firstIsolation === -1 || firstIsolation > lastCompound, `seed ${seed}: ${items.map(item => item.id)}`);
    assert.ok(items.filter(item => /press/.test(item.pairMeta.pattern)).length <= 4, `seed ${seed}: too many presses`);
  }
});

test('a single-group hour is no longer one fixed workout', () => {
  const seen = new Set();
  for (let seed = 1; seed <= SEEDS; seed++) seen.add(mainItems(generate({ chest: 100 }, { seed })).map(item => item.id).sort().join());
  assert.ok(seen.size >= 50, `${seen.size} distinct chest workouts`);
});

test('a larger share never gets fewer sets, and every selected group is trained', () => {
  for (const c of CONFIGS) for (let seed = 1; seed <= 50; seed++) {
    const { split } = generate(c.mix, { dur: c.dur, feel: c.feel, seed });
    split.forEach(part => assert.ok(part.count >= 1 && part.sets >= MIN_SETS, `${label(c, seed)}: ${part.id}`));
    split.forEach(a => split.forEach(b => {
      if (a.pct > b.pct) assert.ok(a.sets >= b.sets, `${label(c, seed)}: ${a.id} ${a.sets} < ${b.id} ${b.sets}`);
    }));
  }
});

/* ---------- Stated shortfalls ---------- */
test('a request the library cannot fill says so instead of silently underfilling', () => {
  const workout = generate({ calves: 100 });
  assert.equal(workout.budget, 27);
  assert.equal(workout.sets, 16);
  assert.deepEqual(workout.notes.map(note => note.rule), ['budget']);
  assert.match(workout.notes[0].text, /Only 16 of 27 sets/);
});

test('too many groups for the time still trains each one and says the session runs long', () => {
  const workout = generate({ chest: 40, back: 30, bis: 15, tris: 15 }, { dur: '15', feel: 'bad' });
  assert.equal(mainItems(workout).length, 4);
  assert.equal(workout.sets, 8);
  assert.match(workout.notes[0].text, /run long/);
});

/* ---------- Determinism and purity ---------- */
test('same request and seed give the same workout; a different seed can differ', () => {
  const mix = { chest: 25, back: 25, legs: 25, shoulders: 25 };
  assert.deepEqual(generate(mix, { seed: 7 }), generate(mix, { seed: 7 }));
  const ids = seed => mainItems(generate(mix, { seed })).map(item => item.id).join();
  assert.ok([8, 9, 10, 11].some(seed => ids(seed) !== ids(7)));
});

test('carries the request seed and context date on the workout', () => {
  const workout = generate({ chest: 100 }, { seed: 42 });
  assert.equal(workout.seed, 42);
  assert.equal(workout.date, NOTES_DATE);
});

test('never touches Math.random or mutates its inputs', () => {
  const realRandom = Math.random;
  Math.random = () => { throw new Error('engine called Math.random'); };
  try {
    for (const c of CONFIGS) {
      const groups = expandGroups(c.mix, groupIds), last = { bench: { w: 155, reps: '5-8' } }, hidden = ['squat'];
      const before = JSON.stringify({ groups, last, hidden });
      generateWorkout({ dur: c.dur, feel: c.feel, groups, opts: { warm: true, cooldown: true, cardio: true, superset: true }, seed: 3 },
        { last, hidden, date: NOTES_DATE });
      assert.equal(JSON.stringify({ groups, last, hidden }), before, label(c, 3));
    }
  } finally {
    Math.random = realRandom;
  }
});

/* ---------- Supersets ---------- */
test('supersets pair neighbours with equal sets, stay within the limit and keep the order valid', () => {
  let paired = 0;
  for (const c of CONFIGS.filter(c => c.feel !== 'bad')) for (let seed = 1; seed <= 40; seed++) {
    const workout = generate(c.mix, { dur: c.dur, feel: c.feel, seed, opts: { ...NO_OPTS, superset: true } });
    const items = mainItems(workout);
    assert.ok(workout.supersets.length <= DURATIONS[c.dur].supersets, label(c, seed));
    assert.deepEqual(workout.notes.filter(note => note.rule === 'order'), [], label(c, seed));
    items.forEach((item, index) => {
      if (item.supersetOrder !== 1) return;
      const mate = items[index + 1];
      assert.ok(mate && mate.supersetId === item.supersetId && mate.supersetOrder === 2, label(c, seed));
      assert.equal(item.sets, mate.sets, label(c, seed));
      paired++;
    });
  }
  assert.ok(paired > 500, `${paired} supersets formed`);
});

test('supersets are skipped on a deload day', () => {
  const workout = generate({ chest: 50, back: 50 }, { feel: 'bad', opts: { ...NO_OPTS, superset: true } });
  assert.equal(workout.supersets.length, 0);
});

test('superset bonuses follow the pattern family, so an incline press still pairs like a press', () => {
  const lib = ['inclinedb', 'lawnmower'].map(id => LIB.find(e => e.id === id));
  const workout = generate({ chest: 50, back: 50 }, { opts: { ...NO_OPTS, superset: true } }, { lib });
  assert.equal(workout.supersets.length, 1);
  // back|chest 60 + horizontal press/pull family 12 + shared dumbbells 10
  assert.equal(workout.supersets[0].score, 82);
});

/* ---------- Hidden exercises and assistance loads ---------- */
test('hidden exercises are never selected', () => {
  const hidden = ['bench', 'squat', 'pullup', 'lateral'];
  const mix = { chest: 25, back: 25, legs: 25, shoulders: 25 };
  for (let seed = 1; seed <= 300; seed++) {
    const ids = mainItems(generate(mix, { seed }, { hidden })).map(item => item.id);
    hidden.forEach(id => assert.ok(!ids.includes(id), `${id} selected with seed ${seed}`));
  }
});

test('a group with every exercise hidden is skipped with a note and does not break generation', () => {
  const calves = LIB.filter(e => e.sub === 'calves').map(e => e.id);
  const alone = generate({ calves: 100 }, {}, { hidden: calves });
  assert.equal(mainItems(alone).length, 0);
  const mixed = generate({ legs: 50, calves: 50 }, {}, { hidden: calves });
  assert.ok(mainItems(mixed).length > 0);
  mainItems(mixed).forEach(item => assert.equal(item.group, 'legs'));
  assert.equal(mixed.split.find(part => part.id === 'calves').count, 0);
  assert.ok(mixed.notes.some(note => note.rule === 'served' && /Calves was skipped/.test(note.text)));
});

test('hiding a whole movement pattern is tolerated without a spurious note', () => {
  const laterals = LIB.filter(e => e.pattern === 'lateral_raise').map(e => e.id);
  for (let seed = 1; seed <= 100; seed++) {
    const workout = generate({ shoulders: 100 }, { dur: '30', seed }, { hidden: laterals });
    assert.deepEqual(workout.notes, [], `seed ${seed}`);
    assert.ok(!patterns(mainItems(workout)).includes('lateral_raise'));
  }
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

test('loads follow the last recorded weight and the feel setting', () => {
  const bench = LIB.find(e => e.id === 'bench');
  const load = feel => mainItems(generate({ chest: 100 }, { feel }, { lib: [bench], last: { bench: { w: 150, reps: '6-8' } } }))[0];
  assert.equal(load('ok').w, 150);
  assert.equal(load('good').w, 155);
  assert.equal(load('bad').w, 130);
  assert.equal(load('ok').reps, '6-8');
});

/* ---------- Apple Notes format ---------- */
test('the Apple Notes text format is unchanged', () => {
  // Workouts and the text the original app produced for them.
  const snapshots = JSON.parse(readFileSync(new URL('./fixtures/notes-snapshots.json', import.meta.url), 'utf8'));
  assert.equal(snapshots.length, 6);
  for (const snapshot of snapshots) assert.equal(notesText(snapshot.workout), snapshot.notes, snapshot.name);
});

test('a generated workout formats without gaps', () => {
  const text = notesText(generate({ chest: 40, back: 40, bis: 20 }, { opts: { warm: true, cooldown: true, cardio: true, superset: true } }));
  assert.match(text, /^11\/17\nWARM-UP\n/);
  assert.match(text, /\nMAIN WORK\n/);
  assert.ok(!/undefined|NaN|null/.test(text), text);
});
