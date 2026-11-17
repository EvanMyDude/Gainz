// One-time capture of golden output from the pre-refactor generator, used to
// prove that extracting the engine changed no behavior.
//
//   git show 393e458:index.html > /some/empty/dir/index.html
//   node tests/tools/capture-golden.mjs /some/empty/dir/index.html
//
// The old page is driven in headless Chromium with Math.random replaced by the
// engine's seeded RNG, so the new engine must reproduce each workout exactly
// when given the same seed. Needs Playwright; not part of `npm test`.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mulberry32 } from '../../js/engine.js';
import { NOTES_DATE, comparable, digest } from '../helpers.js';

const SOURCE = '393e458:index.html';
const oldPage = process.argv[2];
if (!oldPage) {
  console.error('usage: node tests/tools/capture-golden.mjs <path-to-old-index.html>');
  process.exit(1);
}

const DURATIONS = ['15', '30', '60'];
const FEELS = ['bad', 'ok', 'good'];
const MIXES = [
  { name: 'chest', mix: { chest: 100 } },
  { name: 'legs', mix: { legs: 100 } },
  { name: 'back', mix: { back: 100 } },
  { name: 'calves', mix: { calves: 100 } },   // pool smaller than the slot count
  { name: 'core', mix: { core: 100 } },
  { name: 'push', mix: { chest: 50, shoulders: 30, tris: 20 } },
  { name: 'back-legs', mix: { back: 50, legs: 50 } },
  { name: 'four-primary', mix: { chest: 25, back: 25, legs: 25, shoulders: 25 } },
  { name: 'chest-back-bis', mix: { back: 40, bis: 20, chest: 40 } },
  { name: 'legs-shoulders-core-calves', mix: { legs: 35, shoulders: 25, core: 20, calves: 20 } },
  { name: 'six-group', mix: { chest: 20, back: 20, legs: 20, shoulders: 20, bis: 10, tris: 10 }, minDur: 30 },
];
const OPTION_SETS = [
  { warm: true, cooldown: false, cardio: false, superset: false },
  { warm: true, cooldown: true, cardio: true, superset: true },
  { warm: false, cooldown: true, cardio: false, superset: true },
];
// Stored in full (workout and notes text) so a failure is readable.
const FULL = new Set([
  '30|ok|push', '60|good|four-primary', '15|bad|legs',
  '60|ok|back-legs', '30|good|six-group', '15|ok|calves',
]);

const cases = [];
for (const dur of DURATIONS) for (const feel of FEELS) for (const { name, mix, minDur } of MIXES) {
  if (minDur && +dur < minDur) continue;
  const index = cases.length;
  cases.push({ name, dur, feel, mix, opts: OPTION_SETS[index % OPTION_SETS.length], seed: index + 1 });
}

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(pathToFileURL(resolve(oldPage)).href);

const last = await page.evaluate(() => JSON.parse(JSON.stringify(DB.last)));
const out = [];
for (const c of cases) {
  const { workout, notes } = await page.evaluate(({ c, rngSource, notesDate }) => {
    const seeded = (0, eval)('(' + rngSource + ')');
    GROUPS.forEach(g => { ST.groups[g.id] = { on: false, pct: 0 }; });
    Object.entries(c.mix).forEach(([id, pct]) => { ST.groups[id] = { on: true, pct }; });
    ST.dur = c.dur; ST.feel = c.feel;
    const boxes = { warm: 'optWarm', cooldown: 'optCooldown', cardio: 'optCardio', superset: 'optSuperset' };
    Object.entries(boxes).forEach(([key, id]) => { document.getElementById(id).checked = c.opts[key]; });
    const realRandom = Math.random;
    Math.random = seeded(c.seed);
    try { currentWorkout = null; generate(); } finally { Math.random = realRandom; }
    if (!currentWorkout) throw new Error('generate() rejected ' + JSON.stringify(c));
    const workout = JSON.parse(JSON.stringify(currentWorkout));
    currentWorkout.date = notesDate;
    return { workout, notes: notesText() };
  }, { c, rngSource: mulberry32.toString(), notesDate: NOTES_DATE });

  const { name, ...request } = c;
  const entry = { name, ...request, hash: digest(comparable(workout)), notesHash: digest(notes) };
  if (FULL.has(`${c.dur}|${c.feel}|${name}`)) { entry.workout = comparable(workout); entry.notes = notes; }
  out.push(entry);
}
await browser.close();

const file = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/golden.json');
const body = '{\n"source":' + JSON.stringify(SOURCE) + ',\n"notesDate":' + JSON.stringify(NOTES_DATE) +
  ',\n"last":' + JSON.stringify(last) + ',\n"cases":[\n' + out.map(e => JSON.stringify(e)).join(',\n') + '\n]\n}\n';
writeFileSync(file, body);
console.log(`captured ${out.length} cases (${out.filter(e => e.workout).length} in full) -> ${file}`);
