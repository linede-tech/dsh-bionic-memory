/**
 * Read-only pairwise episode similarity for the live memory DB.
 * Usage: node test/similarity.mjs <memory.db>
 */
import { DatabaseSync } from 'node:sqlite';
import { cosine, jaccard } from '../lib/text.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node test/similarity.mjs <memory.db>');
  process.exit(2);
}

const db = new DatabaseSync(file, { readOnly: true });
const rows = db
  .prepare('SELECT id, e, n, vector, keywords, substr(level_2_impression, 1, 70) AS impression FROM episodes ORDER BY t_created DESC')
  .all();
const episodes = rows.map((row) => ({
  id: row.id,
  e: row.e,
  n: row.n,
  vector: JSON.parse(row.vector || '[]'),
  keywords: JSON.parse(row.keywords || '[]'),
  impression: row.impression,
}));

for (let i = 0; i < episodes.length; i += 1) {
  for (let j = i + 1; j < episodes.length; j += 1) {
    const a = episodes[i];
    const b = episodes[j];
    const similarity = cosine(a.vector, b.vector) * 0.7 + jaccard(new Set(a.keywords), new Set(b.keywords)) * 0.3;
    console.log(`${a.id} <-> ${b.id} : ${similarity.toFixed(3)}`);
    console.log(`  A: ${a.impression}`);
    console.log(`  B: ${b.impression}`);
  }
}
db.close();
