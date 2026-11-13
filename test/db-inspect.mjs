/**
 * Read-only inspection of the live memory database.
 * Usage: node test/db-inspect.mjs <path-to-memory.db>
 */
import { DatabaseSync } from 'node:sqlite';

const file = process.argv[2];
if (!file) {
  console.error('usage: node test/db-inspect.mjs <memory.db>');
  process.exit(2);
}

const db = new DatabaseSync(file, { readOnly: true });
const one = (sql) => db.prepare(sql).get();
const all = (sql) => db.prepare(sql).all();

console.log(
  'tables:',
  all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map((row) => row.name)
    .join(', '),
);
console.log(
  'episodes:', one('SELECT COUNT(*) AS c FROM episodes').c,
  '| schemas:', one('SELECT COUNT(*) AS c FROM schemas').c,
  '| skills:', one('SELECT COUNT(*) AS c FROM skills').c,
  '| dreams:', one('SELECT COUNT(*) AS c FROM dreams').c,
  '| journal:', one('SELECT COUNT(*) AS c FROM journal').c,
  '| edges:', one('SELECT COUNT(*) AS c FROM edges').c,
);
console.log('latest episode:', JSON.stringify(all('SELECT id, session_id, e, n, level_2_impression, level_0_raw IS NOT NULL AS has_raw FROM episodes ORDER BY t_created DESC LIMIT 1')[0] ?? null));
console.log('latest dream:', JSON.stringify(all('SELECT id, trigger, temperature, remembered_fraction, substr(afterglow, 1, 60) AS afterglow FROM dreams ORDER BY started_at DESC LIMIT 1')[0] ?? null));
const scratchpad = all('SELECT json FROM scratchpad WHERE id = 1')[0];
if (scratchpad) {
  const parsed = JSON.parse(scratchpad.json);
  console.log('scratchpad:', JSON.stringify({ mood: parsed.mood, dream_at: parsed.dream_at, dream_afterglow: parsed.dream_afterglow }));
}
console.log(
  'journal kinds:',
  all('SELECT kind, COUNT(*) AS c FROM journal GROUP BY kind ORDER BY kind')
    .map((row) => `${row.kind}:${row.c}`)
    .join(', '),
);
console.log(
  'edges:',
  JSON.stringify(all('SELECT from_kind, from_id, to_kind, to_id, relation FROM edges LIMIT 5')),
);
db.close();
