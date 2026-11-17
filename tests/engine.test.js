import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DURATIONS, MINUTES_PER_SET, generateWorkout, notesText, planBudget, swapExercise } from '../js/engine.js';
import { MAX_SETS, MIN_SETS, lintWorkout } from '../js/rules.js';
import { EQUIPMENT, GROUPS, LIB } from '../js/exercises.js';
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

// The load an exercise is given when `stored` was its last recorded weight.
function loadFor(id, stored, feel) {
  const exercise = LIB.find(e => e.id === id);
  const group = exercise.sub || exercise.group;
  const [item] = mainItems(generate({ [group]: 100 }, { feel }, { lib: [exercise], last: { [id]: { w: stored, reps: '6-8' } } }));
  return item;
}
const stepOf = e => e.step || EQUIPMENT[e.equipment].step;

test('loads follow the last recorded weight and reps', () => {
  assert.equal(loadFor('bench', 150, 'ok').w, 150);
  assert.equal(loadFor('bench', 150, 'ok').reps, '6-8');
});

test('feel nudges the load, then snaps it to a weight the equipment has', () => {
  const cases = [
    // id, stored, ok, good, bad
    ['bench', 155, 155, 160, 135],          // barbell, 5 lb steps
    ['ropepush', 48, 48, 48, 48],           // cable stack, 12 lb steps: a 4% or 12% nudge is under one step
    ['latpull', 120, 120, 120, 108],
    ['inclinedb', 45, 45, 45, 40],          // dumbbells, 5 lb steps
    ['seatedcalf', 45, 45, 45, 40],         // plate-loaded machine
    ['cablelat', 12, 12, 12, 12],           // per-side cable load
    ['machinelateral', 36, 36, 36, 36],
  ];
  for (const [id, stored, ok, good, bad] of cases) {
    assert.equal(loadFor(id, stored, 'ok').w, ok, `${id} ok`);
    assert.equal(loadFor(id, stored, 'good').w, good, `${id} good`);
    assert.equal(loadFor(id, stored, 'bad').w, bad, `${id} bad`);
  }
});

test('an off-step weight is shown as stored and never moves the wrong way', () => {
  assert.equal(loadFor('cablefly', 35, 'ok').w, 35);     // the library default is not on a 12 lb step
  assert.equal(loadFor('cablefly', 35, 'good').w, 36);   // snaps up onto the stack
  assert.equal(loadFor('cablefly', 35, 'bad').w, 35);    // nearest step is 36, which a deload must not use
  assert.equal(loadFor('bench', 152, 'ok').w, 152);
});

test('across the library: OK keeps the stored load, Good never lowers it, Bad never raises it', () => {
  for (const exercise of LIB.filter(e => !e.bw && e.loadType !== 'assistance')) {
    const step = stepOf(exercise);
    for (const multiple of [1, 2, 3, 5, 8, 13]) {
      const stored = step * multiple;
      const ok = loadFor(exercise.id, stored, 'ok').w, good = loadFor(exercise.id, stored, 'good').w, bad = loadFor(exercise.id, stored, 'bad').w;
      assert.equal(ok, stored, exercise.id);
      assert.ok(good >= stored && good % step === 0, `${exercise.id} good ${stored} -> ${good}`);
      assert.ok(bad <= stored && bad % step === 0 && bad > 0, `${exercise.id} bad ${stored} -> ${bad}`);
    }
  }
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

/* ---------- Locking and swapping ---------- */
const ALL_OPTS = { warm: true, cooldown: true, cardio: true, superset: false };
const requestFor = (c, extra = {}) => ({ dur: c.dur, feel: c.feel, groups: expandGroups(c.mix, groupIds), opts: NO_OPTS, seed: 1, ...extra });
const CTX = { last: {}, date: NOTES_DATE };
const FEASIBLE = CONFIGS.filter(c => !infeasible(c));
const otherSections = workout => workout.sections.filter(section => section.title !== 'Main work');

test('how sets are shared between muscle groups does not depend on the seed', () => {
  for (const c of FEASIBLE) {
    const split = seed => generateWorkout(requestFor(c, { seed }), CTX).split.map(part => `${part.id}:${part.count}x${part.sets}`).join();
    for (let seed = 2; seed <= 12; seed++) assert.equal(split(seed), split(1), label(c, seed));
  }
});

test('items remember the slot they fill', () => {
  const items = mainItems(generate({ chest: 50, back: 50 }));
  for (const group of ['chest', 'back']) {
    assert.deepEqual(inGroup(items, group).map(item => item.slot).sort(), inGroup(items, group).map((item, index) => index));
  }
});

test('locked exercises survive regeneration with their sets, weights and lock, and the rest stays valid', () => {
  let varied = 0;
  for (const c of FEASIBLE) {
    const first = generateWorkout(requestFor(c), CTX);
    // Lock every other lift, with an edited weight on each.
    const keep = mainItems(first).filter((item, index) => index % 2 === 0)
      .map(item => ({ ...item, locked: true, w: item.w === null ? null : 999 }));
    const lineups = new Set();
    for (let seed = 2; seed <= 16; seed++) {
      const next = generateWorkout(requestFor(c, { seed, keep }), CTX);
      const items = mainItems(next);
      for (const kept of keep) {
        const found = items.find(item => item.id === kept.id);
        assert.ok(found, `${label(c, seed)}: ${kept.id} was dropped`);
        assert.equal(found.sets, kept.sets, `${label(c, seed)}: ${kept.id} sets`);
        assert.equal(found.w, kept.w, `${label(c, seed)}: ${kept.id} weight`);
        assert.equal(found.locked, true);
      }
      assert.deepEqual(next.notes, [], `${label(c, seed)}: ${JSON.stringify(next.notes)}`);
      assert.deepEqual(lintWorkout(next), [], label(c, seed));
      assert.equal(next.sets, first.sets, label(c, seed));
      assert.equal(items.length, mainItems(first).length, label(c, seed));
      lineups.add(items.map(item => item.id).sort().join());
    }
    if (lineups.size > 1) varied++;
  }
  assert.ok(varied > FEASIBLE.length / 2, `${varied} of ${FEASIBLE.length} configurations varied around their locks`);
});

test('kept exercises that are unknown, ruled out or from a deselected group are ignored', () => {
  const first = generate({ chest: 50, back: 50 });
  const [a, b, c] = mainItems(first);
  const keep = [a, b, c, { id: 'nosuchlift', slot: 0, sets: 3 }, { ...mainItems(generate({ legs: 100 }))[0] }];
  const next = generateWorkout({ dur: '60', feel: 'ok', groups: expandGroups({ chest: 50, back: 50 }, groupIds), opts: NO_OPTS, seed: 5, keep, avoid: [a.id] },
    { ...CTX, hidden: [b.id] });
  const ids = mainItems(next).map(item => item.id);
  assert.ok(!ids.includes(a.id));          // ruled out for this run
  assert.ok(ids.includes(b.id));           // hiding governs new picks; the caller chose to keep this one
  assert.ok(ids.includes(c.id));
  assert.ok(mainItems(next).every(item => ['chest', 'back'].includes(item.group)));
  assert.deepEqual(next.notes, []);
});

test('a swap leaves alone a lift that was hidden after the workout was built', () => {
  const request = { dur: '60', feel: 'ok', groups: expandGroups({ chest: 50, back: 50 }, groupIds), opts: NO_OPTS, seed: 4 };
  const workout = generateWorkout(request, CTX);
  const [hiddenLater, target] = mainItems(workout);
  const next = swapExercise(workout, target.id, { ...request, seed: 5 }, { ...CTX, hidden: [hiddenLater.id] });
  assert.ok(next);
  const ids = mainItems(next).map(item => item.id);
  assert.ok(ids.includes(hiddenLater.id) && !ids.includes(target.id));
  assert.deepEqual(next.notes, []);
  // and a hidden lift can itself be swapped out
  const gone = swapExercise(workout, hiddenLater.id, { ...request, seed: 6 }, { ...CTX, hidden: [hiddenLater.id] });
  assert.ok(gone && !mainItems(gone).some(item => item.id === hiddenLater.id));
});

test('swapping replaces exactly one exercise and leaves the rest of the workout alone', () => {
  let swaps = 0, unavailable = 0;
  const forced = {};   // swaps where the only replacements left bend a rule, by rule
  for (const c of FEASIBLE) for (const superset of [false, true]) {
    if (superset && c.feel === 'bad') continue;
    const request = requestFor(c, { seed: 3, opts: { ...ALL_OPTS, superset } });
    const workout = generateWorkout(request, CTX);
    mainItems(workout).forEach(item => { if (item.w !== null) item.w = 777; });   // weights the user edited
    for (const target of mainItems(workout)) {
      const next = swapExercise(workout, target.id, { ...request, seed: 99 }, CTX);
      if (!next) { unavailable++; continue; }
      swaps++;
      const where = `${label(c, 3)} swapping ${target.id}`;
      const before = mainItems(workout), after = mainItems(next);
      const arrived = after.filter(item => !before.some(old => old.id === item.id));
      assert.equal(after.length, before.length, where);
      assert.equal(arrived.length, 1, where);
      assert.ok(!after.some(item => item.id === target.id), where);
      assert.equal(arrived[0].group, target.group, where);
      assert.equal(arrived[0].sets, target.sets, where);
      for (const old of before.filter(item => item.id !== target.id)) {
        const kept = after.find(item => item.id === old.id);
        assert.equal(kept.sets, old.sets, `${where}: ${old.id} sets`);
        assert.equal(kept.w, old.w, `${where}: ${old.id} weight`);
      }
      assert.deepEqual(otherSections(next), otherSections(workout), where);
      assert.equal(next.date, workout.date);
      assert.equal(next.sets, workout.sets, where);
      // The lifts swapped away are not alternatives the linter may ask for. When
      // the only replacement left bends a rule, the workout says so.
      const problems = lintWorkout(next, { hidden: next.swapped }).map(problem => problem.rule);
      assert.deepEqual(next.notes.map(note => note.rule).sort(), problems.sort(), where);
      problems.forEach(rule => { forced[rule] = (forced[rule] || 0) + 1; });
      assert.ok(next.swapped.includes(target.id), where);
    }
  }
  assert.ok(swaps > 1000, `${swaps} swaps checked`);
  // Only the high-fatigue cap can be forced, and only in long single-group sessions.
  assert.deepEqual(Object.keys(forced), ['fatigue'], JSON.stringify(forced));
  assert.ok(forced.fatigue < swaps / 100, `${forced.fatigue} of ${swaps} swaps were forced`);
  console.log(`      swaps checked: ${swaps}, no alternative: ${unavailable}, forced past the fatigue cap: ${forced.fatigue}`);
  assert.ok(unavailable < swaps / 10, `${unavailable} slots had no alternative`);
});

test('a swap fills the same purpose', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const request = { dur: '60', feel: 'ok', groups: expandGroups({ chest: 50, shoulders: 30, tris: 20 }, groupIds), opts: NO_OPTS, seed };
    const workout = generateWorkout(request, CTX);
    const lead = mainItems(workout).find(item => item.group === 'chest' && item.slot === 0);
    const next = swapExercise(workout, lead.id, { ...request, seed: seed + 1000 }, CTX);
    const replacement = mainItems(next).find(item => item.group === 'chest' && item.slot === 0);
    assert.ok(['horizontal_press', 'incline_press'].includes(replacement.pairMeta.pattern), `seed ${seed}: ${replacement.id}`);
    assert.notEqual(replacement.id, lead.id);
  }
});

test('repeated swaps of one slot walk through the alternatives before repeating', () => {
  const request = { dur: '30', feel: 'ok', groups: expandGroups({ bis: 100 }, groupIds), opts: NO_OPTS, seed: 1 };
  let workout = generateWorkout(request, CTX);
  const curls = LIB.filter(e => e.sub === 'bis').length;
  const slot = mainItems(workout)[0].slot;
  const current = () => mainItems(workout).find(item => item.slot === slot).id;
  const seen = [current()];
  // Every curl not already in the workout can take the slot once before any repeats.
  const fresh = curls - mainItems(workout).length;
  for (let i = 0; i < fresh; i++) {
    workout = swapExercise(workout, current(), { ...request, seed: 50 + i }, CTX);
    assert.ok(workout, `swap ${i + 1} found nothing`);
    assert.ok(!seen.includes(current()), `swap ${i + 1} repeated ${current()}`);
    seen.push(current());
  }
  // With the alternatives used up, the cycle starts again rather than failing.
  const again = swapExercise(workout, current(), { ...request, seed: 99 }, CTX);
  assert.ok(again);
  assert.notEqual(mainItems(again).find(item => item.slot === slot).id, current());
});

test('a slot with no alternative cannot be swapped', () => {
  const bench = LIB.find(e => e.id === 'bench');
  const request = { dur: '15', feel: 'ok', groups: expandGroups({ chest: 100 }, groupIds), opts: NO_OPTS, seed: 1 };
  const workout = generateWorkout(request, { ...CTX, lib: [bench] });
  assert.equal(swapExercise(workout, 'bench', { ...request, seed: 2 }, { ...CTX, lib: [bench] }), null);
  assert.equal(swapExercise(workout, 'notinworkout', request, CTX), null);
});
