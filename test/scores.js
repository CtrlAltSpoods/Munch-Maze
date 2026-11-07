'use strict';
/* High-score table rules: one entry per name, best score kept. */
const assert = require('assert');
const Scores = require('../server/scores.js');
let t = [];
const add = (n, sc) => { const next = Scores.add(t, { n, sc, lv: 1, seed: 's' }); if (next) t = next; return !!next; };

assert.ok(add('Jake', 500));
assert.ok(add('Sam', 300));
assert.ok(!add('jake', 200), 'a lower score for the same name changes nothing');
assert.strictEqual(t.length, 2);
assert.ok(add('  JAKE ', 900), 'a personal best replaces the old entry');
assert.deepStrictEqual(t.map(e => [e.n, e.sc]), [['  JAKE ', 900], ['Sam', 300]]);
assert.ok(!add('Jake', 900), 'equal to the best changes nothing');
assert.ok(!add('Nobody', 0), 'zero scores are not recorded');
console.log('ok  one entry per name, best score kept');

// legacy files with duplicates are merged on load
const legacy = [{ n: 'Jake', sc: 100 }, { n: 'jake', sc: 700 }, { n: 'Sam', sc: 50 }, { n: 'JAKE', sc: 300 }, null, 'junk'];
const merged = Scores.dedupe(legacy);
assert.deepStrictEqual(merged.map(e => [e.n, e.sc]), [['jake', 700], ['Sam', 50]]);
console.log('ok  duplicate entries from older saves are merged');

// a full table: a new name only gets in by beating the lowest score
t = [];
for (let i = 1; i <= Scores.LIMIT; i++) add('p' + i, i * 10);
assert.ok(!add('newbie', 5), 'too low for a full table');
assert.ok(add('newbie', 15));
assert.strictEqual(t.length, Scores.LIMIT);
assert.ok(!t.some(e => e.n === 'p1'), 'lowest entry dropped');
assert.ok(add('p2', 999), 'existing name can improve even near the bottom');
assert.strictEqual(t.filter(e => Scores.nameKey(e.n) === 'p2').length, 1);
console.log('ok  full table keeps the best ' + Scores.LIMIT + ' names');
console.log('\nAll scoreboard tests passed.');
