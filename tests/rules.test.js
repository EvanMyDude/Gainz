import test from 'node:test';
import assert from 'node:assert/strict';
import { lintWorkout, orderViolations } from '../js/rules.js';
import { GROUPS, LIB } from '../js/exercises.js';

// Each rule is exercised with a hand-built workout, independent of the generator.
const byId = id => LIB.find(e => e.id === id);
const groupOf = e => e.sub || e.group;
// lifts: [[exerciseId, sets], ...] in workout order.
function workoutOf(lifts, { feel = 'ok', budget, pct = {} } = {}) {
  const items = lifts.map(([id, sets]) => ({ id, name: byId(id).name, sets }));
  const groups = [...new Set(lifts.map(([id]) => groupOf(byId(id))))];
  const total = items.reduce((sum, item) => sum + item.sets, 0);
  return {
    feel, budget: budget ?? total,
    sections: [{ title: 'Main work', items }],
    split: groups.map(id => ({ id, name: GROUPS.find(g => g.id === id).name, pct: pct[id] ?? Math.round(100 / groups.length) })),
  };
}
const rules = (lifts, options, context) => lintWorkout(workoutOf(lifts, options), context).map(problem => problem.rule);

test('a sound workout passes every rule', () => {
  const push = [['bench', 4], ['inclinedb', 3], ['ohp', 3], ['cablefly', 3], ['lateral', 3], ['ropepush', 3], ['ohrope', 2]];
  assert.deepEqual(rules(push, { pct: { chest: 50, shoulders: 30, tris: 20 } }), []);
  const legs = [['squat', 4], ['rdl', 3], ['reverselunge', 3], ['legcurl', 3]];
  assert.deepEqual(rules(legs), []);
});

test('flags hidden, duplicated and near-duplicate exercises', () => {
  assert.deepEqual(rules([['bench', 3], ['cablefly', 3]], {}, { hidden: ['bench'] }), ['hidden']);
  assert.ok(rules([['bench', 3], ['bench', 3], ['cablefly', 2]]).includes('duplicate'));
  assert.ok(rules([['squat', 3], ['smithsquat', 3], ['rdl', 3]]).includes('exclusive'));
});

test('flags a selected group with no exercise', () => {
  const workout = workoutOf([['bench', 3], ['cablefly', 3]]);
  workout.split.push({ id: 'back', name: 'Back', pct: 50 });
  assert.ok(lintWorkout(workout).some(problem => problem.rule === 'served'));
});

test('flags a larger share that received fewer sets', () => {
  const lifts = [['bench', 2], ['latpull', 3], ['csrow', 3]];
  assert.ok(rules(lifts, { pct: { chest: 70, back: 30 } }).includes('shares'));
  assert.ok(!rules(lifts, { pct: { chest: 30, back: 70 } }).includes('shares'));
});

test('flags set counts outside the budget or outside 2 to 4 per exercise', () => {
  assert.ok(rules([['bench', 3], ['cablefly', 3]], { budget: 10 }).includes('budget'));
  assert.ok(!rules([['bench', 3], ['cablefly', 3]], { budget: 7 }).includes('budget'));
  assert.ok(rules([['bench', 1], ['cablefly', 3]]).includes('sets'));
  assert.ok(rules([['bench', 5], ['cablefly', 3]]).includes('sets'));
});

test('flags a muscle group that misses an essential movement', () => {
  assert.ok(rules([['squat', 4], ['legpress', 3]]).includes('coverage'));               // no hip or hamstring lift
  assert.ok(rules([['latpull', 3], ['neutralpulldown', 3]]).includes('coverage'));      // no horizontal pull
  assert.ok(rules([['ohp', 3], ['facepull', 3]]).includes('coverage'));                 // no lateral raise
  assert.ok(rules([['bench', 3], ['inclinedb', 3]]).includes('coverage'));              // no fly
  assert.ok(rules([['ropepush', 3], ['barpushdown', 3]]).includes('coverage'));         // no overhead extension
  assert.deepEqual(rules([['squat', 4]]), []);                                          // one lift: nothing to cover
});

test('does not demand a movement the library cannot supply', () => {
  const laterals = LIB.filter(e => e.pattern === 'lateral_raise').map(e => e.id);
  assert.ok(!rules([['ohp', 3], ['facepull', 3]], {}, { hidden: laterals }).includes('coverage'));
});

test('flags a third exercise of one pattern while other patterns are unused', () => {
  assert.ok(rules([['bench', 3], ['flatdb', 3], ['machinepress', 3], ['cablefly', 3]]).includes('pattern-cap'));
  // Calves only has one pattern, so repeating it is the only option.
  assert.ok(!rules([['calfraise', 3], ['seatedcalf', 3], ['slcalf', 3]]).includes('pattern-cap'));
});

test('flags stacked hinges, stacked presses and too many taxing lifts', () => {
  assert.ok(rules([['deadlift', 3], ['latpull', 3], ['csrow', 3], ['squat', 3], ['rdl', 3]]).includes('hinge'));
  assert.ok(rules([['bench', 3], ['inclinedb', 3], ['ohp', 3], ['dbohp', 3], ['cablefly', 2], ['lateral', 2]]).includes('press-stack'));
  assert.ok(!rules([['bench', 3], ['ohp', 3], ['dbohp', 3], ['cablefly', 2], ['lateral', 2]]).includes('press-stack'));
  assert.ok(rules([['squat', 3], ['rdl', 3], ['bulgarian', 3], ['legcurl', 3]]).includes('fatigue'));          // 3 of 4
  assert.ok(rules([['squat', 3], ['rdl', 3], ['legcurl', 3]], { feel: 'bad' }).includes('fatigue'));           // deload allows 1
});

test('flags work that pre-fatigues a later compound, and nothing else', () => {
  const order = ids => orderViolations(ids.map(byId));
  assert.equal(order(['cablefly', 'bench']).length, 1);        // isolation before the same group's compound
  assert.equal(order(['ropepush', 'bench']).length, 1);        // triceps before a press
  assert.equal(order(['ropepush', 'ohp']).length, 1);
  assert.equal(order(['ezcurl', 'latpull']).length, 1);        // biceps before a pull
  assert.equal(order(['hlegraise', 'csrow']).length, 1);       // hanging grip work before a pull
  assert.equal(order(['plank', 'squat']).length, 1);           // core before an axial lift
  assert.equal(order(['legcurl', 'bench']).length, 0);         // unrelated chains may come in any order
  assert.equal(order(['ezcurl', 'bench']).length, 0);
  assert.equal(order(['bench', 'cablefly', 'ropepush', 'plank']).length, 0);
  assert.ok(rules([['cablefly', 3], ['bench', 3]]).includes('order'));
});
