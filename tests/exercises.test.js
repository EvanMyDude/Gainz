import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as data from '../js/exercises.js';

const { LIB, PATTERNS, EQUIPMENT, PRIMARY_GROUPS, TARGET_GROUPS } = data;
// The library as it stood before the data pass; its ids are in people's stored history.
const legacy = JSON.parse(readFileSync(new URL('./fixtures/legacy-lib.json', import.meta.url), 'utf8'));
const byId = id => LIB.find(exercise => exercise.id === id);

test('every exercise has a unique, simple id', () => {
  const ids = LIB.map(exercise => exercise.id);
  assert.equal(new Set(ids).size, ids.length);
  ids.forEach(id => assert.match(id, /^[a-z0-9]+$/));
});

test('metadata lives on the exercise record and uses known vocabulary', () => {
  assert.equal(data.PAIR_META, undefined);
  for (const e of LIB) {
    assert.ok(Object.hasOwn(PATTERNS, e.pattern), `${e.id}: unknown pattern ${e.pattern}`);
    assert.ok(Object.hasOwn(EQUIPMENT, e.equipment), `${e.id}: unknown equipment ${e.equipment}`);
    assert.ok(['low', 'moderate', 'high'].includes(e.fatigue), `${e.id}: bad fatigue ${e.fatigue}`);
  }
});

test('every record is well formed', () => {
  const primary = PRIMARY_GROUPS.map(group => group.id);
  const targeted = TARGET_GROUPS.map(group => group.id);
  for (const e of LIB) {
    assert.ok(e.name && typeof e.name === 'string', `${e.id}: name`);
    assert.ok(primary.includes(e.group), `${e.id}: group ${e.group}`);
    if (e.sub !== undefined) assert.ok(targeted.includes(e.sub), `${e.id}: sub ${e.sub}`);
    assert.ok(['c', 'i'].includes(e.t), `${e.id}: type ${e.t}`);
    assert.ok(e.reps && typeof e.reps === 'string', `${e.id}: reps`);
    if (!e.bw) assert.ok(typeof e.w === 'number' && e.w >= 0, `${e.id}: load`);
    if (e.loadType !== undefined) assert.equal(e.loadType, 'assistance', `${e.id}: loadType`);
    if (e.loadStyle !== undefined) {
      assert.ok(['pair', 'perSide'].includes(e.loadStyle), `${e.id}: loadStyle`);
      assert.equal(e.unit, 'ea', `${e.id}: loadStyle needs unit ea`);
    }
  }
});

test('pattern families are themselves patterns, and every pattern is used', () => {
  const used = new Set(LIB.map(e => e.pattern));
  for (const [id, pattern] of Object.entries(PATTERNS)) {
    assert.ok(Object.hasOwn(PATTERNS, pattern.family), `${id}: unknown family ${pattern.family}`);
    assert.ok(used.has(id), `${id}: no exercise uses this pattern`);
  }
});

test('exclusive keys are shared by at least two exercises', () => {
  const counts = {};
  LIB.forEach(e => { if (e.exclusive) counts[e.exclusive] = (counts[e.exclusive] || 0) + 1; });
  for (const [key, count] of Object.entries(counts)) assert.ok(count >= 2, `${key} has ${count} member`);
});

test('no exercise from the previous library was removed or moved to another group', () => {
  for (const old of legacy) {
    const now = byId(old.id);
    assert.ok(now, `${old.id} is missing`);
    assert.equal(now.group, old.group, `${old.id}: group`);
    assert.equal(now.sub, old.sub, `${old.id}: sub`);
  }
});

test('mislabeled exercises are corrected', () => {
  for (const id of ['machinepress', 'goblet', 'pushup', 'uprightrow']) assert.equal(byId(id).t, 'c', id);
  assert.equal(byId('inclinedb').pattern, 'incline_press');
  assert.equal(PATTERNS.incline_press.family, 'horizontal_press');
  assert.equal(byId('straightarm').pattern, 'lat_isolation');
  assert.equal(byId('ohrope').pattern, 'triceps_overhead');
  assert.equal(byId('skull').pattern, 'triceps_overhead');
  assert.equal(byId('kickback').equipment, 'cable');
});

test('lifts from the logged history are in the library under their history ids', () => {
  const expected = {
    assisteddip: 'chest', assistedpullup: 'back', reversepecdeck: 'shoulders', smithsquat: 'legs',
    seatedcalf: 'legs', backextension: 'back', inclinedbfly: 'chest', cablefrontraise: 'shoulders',
    smithohp: 'shoulders', highcablepinchdown: 'back', smithuprightrow: 'shoulders',
  };
  for (const [id, group] of Object.entries(expected)) {
    assert.ok(byId(id), `${id} is missing`);
    assert.equal(byId(id).group, group, id);
  }
  assert.equal(byId('seatedcalf').sub, 'calves');
  assert.equal(byId('assisteddip').loadType, 'assistance');
  assert.equal(byId('assistedpullup').loadType, 'assistance');
});

test('new exercises start with a usable load, and the library grew as planned', () => {
  const legacyIds = new Set(legacy.map(e => e.id));
  const added = LIB.filter(e => !legacyIds.has(e.id));
  assert.equal(added.length, 37);
  added.forEach(e => { if (!e.bw) assert.ok(e.w > 0, `${e.id}: starting load`); });
  // Compounds in the single-muscle groups would dominate the current selector.
  LIB.filter(e => e.sub).forEach(e => assert.equal(e.t, 'i', `${e.id}: targeted-group compound`));
});

test('every piece of equipment declares its load step, and overrides are sensible', () => {
  for (const [id, equipment] of Object.entries(EQUIPMENT)) {
    assert.ok(Number.isFinite(equipment.step) && equipment.step >= 0, `${id}: step`);
  }
  assert.equal(EQUIPMENT.cable.step, 12);
  assert.equal(EQUIPMENT.machine.step, 12);
  assert.equal(EQUIPMENT.dumbbell.step, 5);
  LIB.filter(e => e.step !== undefined).forEach(e => assert.ok(e.step > 0, `${e.id}: step override`));
  // Plate-loaded machines do not move in stack steps.
  assert.equal(byId('seatedcalf').step, 5);
  assert.equal(byId('hacksquat').step, 5);
  // Logged at 48 per side, a stack weight.
  assert.equal(byId('slcalf').equipment, 'machine');
});

test('starting loads of the exercises added after the original library sit on a real step', () => {
  const legacyIds = new Set(legacy.map(e => e.id));
  for (const e of LIB.filter(e => !legacyIds.has(e.id) && !e.bw)) {
    const step = e.step || EQUIPMENT[e.equipment].step;
    assert.equal(e.w % step, 0, `${e.id}: ${e.w} is not a multiple of ${step}`);
  }
});
