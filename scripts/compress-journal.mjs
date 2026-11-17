#!/usr/bin/env node
/**
 * Compress legacy journal rows into `[ref: vault_id] <25-char summary>`.
 *
 * The old writer stored full turn text in journal.detail. The full text now
 * lives only in verbatim_vault; this script links each legacy row to the
 * nearest vault row and keeps only a short summary line.
 *
 * Usage:
 *   node scripts/compress-journal.mjs            # dry run
 *   node scripts/compress-journal.mjs --apply    # write changes
 *   node scripts/compress-journal.mjs --db <path> --apply
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dbIndex = args.indexOf('--db');
const dbPath =
  dbIndex >= 0 && args[dbIndex + 1]
    ? path.resolve(args[dbIndex + 1])
    : path.join(os.homedir(), '.dsh', 'bionic-soul', 'cortex', 'memory_cortex.sqlite');

if (!fs.existsSync(dbPath)) {
  console.error(`journal DB not found: ${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
const columns = db.prepare('PRAGMA table_info(journal)').all().map((row) => row.name);
if (!columns.includes('detail')) {
  console.error('journal table has no detail column');
  process.exit(1);
}

const rows = db.prepare('SELECT seq, at, session_id, kind, summary, detail FROM journal ORDER BY seq ASC').all();
const vault = db.prepare('SELECT rowid AS id, timestamp FROM verbatim_vault WHERE session_id = ? AND timestamp BETWEEN ? AND ? ORDER BY ABS(timestamp - ?) ASC LIMIT 1');
const update = db.prepare('UPDATE journal SET summary = ?, detail = ? WHERE seq = ?');
const WINDOW = 5 * 60 * 1000;

let changed = 0;
const preview = [];
for (const row of rows) {
  const detail = String(row.detail || '');
  if (!detail || detail.startsWith('[ref:')) continue;
  const match = vault.get(String(row.session_id || ''), Number(row.at) - WINDOW, Number(row.at) + WINDOW, Number(row.at));
  const summary = String(row.summary || detail).replace(/\s+/g, ' ').trim().slice(0, 25);
  const next = `[ref: ${match ? match.id : 'none'}] ${summary}`;
  preview.push({ seq: row.seq, before: detail.length, after: next.length, next });
  if (apply) update.run(summary, next, row.seq);
  changed += 1;
}

console.log(`db: ${dbPath}`);
console.log(`journal rows: ${rows.length}; legacy rows needing compression: ${changed}`);
for (const line of preview.slice(0, 8)) {
  console.log(`  #${line.seq}: ${line.before} chars -> ${line.after} chars :: ${line.next}`);
}
if (!apply) {
  console.log('\nDry run only. Re-run with --apply to write the compressed rows.');
} else {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  console.log(`\nCompressed ${changed} row(s). Full texts remain only in verbatim_vault.`);
}
db.close();
