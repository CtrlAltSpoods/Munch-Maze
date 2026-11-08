'use strict';
/* Database rules: best score per player, accounts keyed by Discord id, unique names, sessions. */
const assert = require('assert');
const DB = require('../server/db.js');
const db = DB.open(':memory:');

// scores: one entry per player, best kept; guests by name, accounts by uid
assert.ok(db.addScore({ n: 'Jake', sc: 500, lv: 3 }));
assert.ok(!db.addScore({ n: 'jake ', sc: 200, lv: 1 }), 'guest names match ignoring case and spaces');
assert.ok(db.addScore({ n: 'JAKE', sc: 900, lv: 5 }), 'a guest personal best replaces the old one');
assert.ok(!db.addScore({ n: 'Nobody', sc: 0, lv: 1 }), 'zero scores are not recorded');
assert.deepStrictEqual(db.topScores().map(s => [s.n, s.sc, s.reg]), [['JAKE', 900, false]]);
console.log('ok  scores: best run per guest name');

// accounts come only from Discord; the first login creates one with a free name
const a = db.loginDiscord('111111111111111111', 'Sam');
assert.ok(a.created && a.uid > 0 && a.name === 'Sam');
const again = db.loginDiscord('111111111111111111', 'Different');
assert.ok(!again.created && again.uid === a.uid && again.name === 'Sam', 'the same Discord id logs into the same account');
const b = db.loginDiscord('222222222222222222', 'sam');
assert.ok(b.created && b.uid !== a.uid && b.name === 'sam2', 'a second person wanting a taken name gets a free variant');
assert.strictEqual(db.nameOwner('SAM'), a.uid, 'names are owned ignoring case');
assert.strictEqual(db.nameOwner('nobody'), 0);
console.log('ok  accounts: one per Discord id, names unique');

// renaming keeps scores linked to the account
assert.ok(db.addScore({ uid: a.uid, n: 'Sam', sc: 300, lv: 2 }));
assert.ok(!db.addScore({ uid: a.uid, n: 'Sam', sc: 100, lv: 1 }));
assert.deepStrictEqual(db.rename(b.uid, 'SAM'), { ok: false, error: 'taken' }, 'cannot take another account’s name');
assert.ok(db.rename(a.uid, 'Samwise').ok);
assert.strictEqual(db.nameOwner('sam'), 0, 'the old name is free again');
assert.strictEqual(db.nameOwner('samwise'), a.uid);
assert.ok(db.rename(a.uid, 'samwise').ok, 'changing just the capitals of your own name is fine');
const top = db.topScores();
assert.deepStrictEqual(top.map(s => [s.n, s.sc, s.reg]), [['JAKE', 900, false], ['samwise', 300, true]], 'account scores show the current name');
assert.ok(db.addScore({ uid: a.uid, n: 'samwise', sc: 950, lv: 6 }));
assert.strictEqual(db.topScores().filter(s => s.reg).length, 1, 'still one entry per account after renaming');
console.log('ok  renaming keeps scores on the account and frees the old name');

// sessions: token in the browser, only its hash here
const tok = db.newSession(a.uid);
assert.ok(/^[A-Za-z0-9_-]{43}$/.test(tok));
assert.strictEqual(db.sessionUser(tok).uid, a.uid);
assert.strictEqual(db.sessionUser(tok + 'x'), null);
assert.strictEqual(db.sessionUser(''), null);
db.endSession(tok);
assert.strictEqual(db.sessionUser(tok), null, 'logged out');
console.log('ok  sessions: create, look up, end');

// importing an old scores.json (only into an empty table)
const fresh = DB.open(':memory:');
assert.strictEqual(fresh.importLegacy([{ n: 'Old', sc: 40, lv: 1 }, { n: 'old', sc: 70, lv: 2 }, null]), 1);
assert.deepStrictEqual(fresh.topScores().map(s => [s.n, s.sc]), [['old', 70]]);
assert.strictEqual(fresh.importLegacy([{ n: 'Again', sc: 5 }]), 0, 'only imports once');
console.log('ok  old scores.json is imported once');

// time-limited boards, profiles, achievements, progress
const p = DB.open(':memory:');
const u = p.loginDiscord('333333333333333333', 'Pro');
assert.ok(p.addScore({ uid: u.uid, n: 'Pro', sc: 700, lv: 4, boards: ['week:2026-W45', 'day:2026-11-08'] }));
p.addScore({ n: 'Guest', sc: 800, lv: 5, boards: ['week:2026-W45'] });
assert.ok(!p.addScore({ uid: u.uid, n: 'Pro', sc: 600, lv: 3, boards: ['week:2026-W46'] }), 'not an all-time best...');
assert.deepStrictEqual(p.topScores(10, 'week:2026-W46').map(s => [s.n, s.sc]), [['Pro', 600]], '...but it still counts for a new week');
assert.deepStrictEqual(p.topScores(10, 'week:2026-W45').map(s => [s.n, s.sc, s.reg]), [['Guest', 800, false], ['Pro', 700, true]]);
assert.deepStrictEqual(p.topScores(10, 'day:2026-11-08').map(s => s.n), ['Pro']);
assert.strictEqual(p.topScore(), 800);
p.recordGame(u.uid, { sc: 700, lv: 4, model: 'shark' }); p.recordGame(u.uid, { sc: 100, lv: 1, model: 'shark' }); p.recordGame(u.uid, { sc: 50, lv: 1, model: 'bear' });
assert.ok(p.award(u.uid, 'first')); assert.ok(!p.award(u.uid, 'first'), 'an achievement is earned once'); assert.ok(!p.award(0, 'first'), 'guests earn nothing');
p.setProgress(u.uid, 6, 7); p.setProgress(u.uid, 3, 4);
const pr = p.profile(u.uid);
assert.deepStrictEqual([pr.games, pr.best, pr.bestLevel, pr.cleared, pr.fav, pr.achievements.map(a => a.id)], [3, 700, 7, 6, 'shark', ['first']]);
p.reserveName('Admin'); assert.strictEqual(p.nameOwner('admin'), -1, 'reserved names are owned by nobody'); p.unreserveName('ADMIN'); assert.strictEqual(p.nameOwner('admin'), 0);
p.resetScores('week'); assert.strictEqual(p.topScores(10, 'week:2026-W45').length, 0); assert.strictEqual(p.topScores(10, 'day:2026-11-08').length, 1);
console.log('ok  weekly/daily boards, profiles, achievements, progress, reserved names');

console.log('\nAll database tests passed.');
