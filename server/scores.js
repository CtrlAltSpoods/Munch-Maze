'use strict';
/* High-score table: one entry per player name, holding that name's best run.
   Names match ignoring case and repeated spaces, so "Jake", "jake" and "Jake  "
   share one entry; the entry shows the name as typed for the best score. */

const LIMIT = 25;
// NFKC: full-width and other look-alike forms of the same letters count as the same name
const nameKey = n => String(n || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

function clean(e) {
  return { n: String(e.n || 'Player').slice(0, 16), sc: Math.max(0, e.sc | 0), lv: Math.max(0, e.lv | 0), seed: String(e.seed || '').slice(0, 40), at: e.at || new Date().toISOString() };
}

/** Keep each name's best entry, highest scores first. */
function dedupe(list) {
  const best = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw !== 'object') continue;
    const e = clean(raw), k = nameKey(e.n);
    if (!k) continue;
    const cur = best.get(k);
    if (!cur || e.sc > cur.sc) best.set(k, e);
  }
  return [...best.values()].sort((a, b) => b.sc - a.sc).slice(0, LIMIT);
}

/** Record a finished run. Returns the new table, or null if nothing changed. */
function add(table, entry) {
  const e = clean(entry), k = nameKey(e.n);
  if (!k || e.sc <= 0) return null;
  const i = table.findIndex(x => nameKey(x.n) === k);
  if (i >= 0 && table[i].sc >= e.sc) return null;          // not a personal best
  const next = table.filter((_, j) => j !== i);
  next.push(e);
  next.sort((a, b) => b.sc - a.sc);
  const trimmed = next.slice(0, LIMIT);
  return trimmed.includes(e) || i >= 0 ? trimmed : null;   // didn't make the table
}

module.exports = { dedupe, add, nameKey, LIMIT };
