/**
 * Smoke test for the verbatim vault, the one-line-a-day catalog and the
 * self-alarm schedule. Cleans up its own temporary data.
 *
 * Usage: node test/vault-catalog-smoke.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MemoryCatalog } from '../lib/catalog.js';
import { MySchedule } from '../lib/schedule.js';
import { writeDream } from '../lib/soul-storage.js';
import { openStore } from '../lib/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, '.vault-data');

let failures = 0;
function check(condition, message, extra) {
  if (condition) console.log(`ok - ${message}`);
  else {
    failures += 1;
    console.error(`FAIL - ${message}${extra === undefined ? '' : ` :: ${JSON.stringify(extra)}`}`);
  }
}

async function main() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  const store = await openStore({ dir: DATA, dbFile: 'test.sqlite', jsonFile: 'test.json' });
  check(store.kind === 'sqlite', 'store uses SQLite for FTS5');

  store.archiveVerbatim({
    sessionId: 's1',
    timestamp: Date.UTC(2026, 10, 17, 2, 0, 0),
    speaker: 'user',
    exactText: '那天海边最后那句话，你的原话是怎么说的？',
    topicTags: ['海边', '原话'],
    episodeId: 'ep-test-1',
    turn: 2,
  });
  store.archiveVerbatim({
    sessionId: 's1',
    timestamp: Date.UTC(2026, 10, 17, 2, 0, 5),
    speaker: 'assistant',
    exactText: '原话是：等下次退潮，我们再来一次。',
    topicTags: ['海边', '原话'],
    episodeId: 'ep-test-1',
    turn: 2,
  });
  check(store.countVerbatim() === 2, 'verbatim rows inserted');
  check(store.hasVerbatim('ep-test-1') === true, 'episode has a verbatim row');

  const hits = store.searchVerbatim({ query: '原话', limit: 5 });
  check(hits.length >= 1, 'keyword search finds the exact words', hits.length);
  check(hits.some((hit) => hit.speaker === 'user'), 'search keeps speaker');

  const dayStart = Date.UTC(2026, 10, 17, 0, 0, 0);
  const dayEnd = Date.UTC(2026, 10, 17, 23, 59, 59);
  const ranged = store.searchVerbatim({ query: '海边', from: dayStart, to: dayEnd, limit: 5 });
  check(ranged.length >= 1, 'date range narrows the vault search');

  const context = store.verbatimContext({ sessionId: 's1', turn: 2, window: 1 });
  check(context.length === 2, 'context window returns the surrounding turns', context.length);
  check(store.countVerbatim() === 2, 'context does not duplicate the vault');

  const catalog = new MemoryCatalog({ dataDir: DATA, clock: () => Date.UTC(2026, 10, 19, 2, 0, 0) });
  catalog.init();
  catalog.recordDay({
    day: '2026-11-17',
    status: '高光',
    anchor: '海边 / 原话 / 第一次说起未来',
    turns: 12,
    impressions: 5,
    journal: true,
  });
  catalog.recordDay({ day: '2026-11-19', status: '正常', anchor: '修插件 / 测试', turns: 4, impressions: 2, journal: false });
  catalog.recordBackfill({ day: '2026-11-18', anchor: '原话冷库 / 目录补齐', turns: 3 });
  catalog.recordBlank({ day: '2026-11-16' });
  const lines = catalog.recent(30);
  check(lines.length >= 4, 'catalog keeps explicit backfill and blank lines', lines.length);
  check(lines.some((line) => line.startsWith('- 2026-11-18 [已聊/未眠补录]')), 'vault day without sleep is backfilled');
  check(lines.some((line) => line.startsWith('- 2026-11-16 [空白]')), 'truly empty day is written as [空白]');
  check(lines.every((line) => /^- \d{4}-\d{2}-\d{2} \[(正常|空白|高光|异常残缺|已聊\/未眠补录)\]/.test(line)), 'every line follows the catalog format');
  check(
    lines.every(
      (line) =>
        (line.includes('对话:') && (line.includes('印象:') || line.includes('睡眠:未触发'))) ||
        line.includes('(当天无交互)'),
    ),
    'every line carries its day counters',
  );
  const anchor = lines[0].match(/\] (.*?) \(对话:/)?.[1] || '';
  check(anchor.length <= 35, 'core anchor is <= 35 chars', anchor);
  const block = catalog.block(90);
  check(block.startsWith('<my_memory_catalog>') && block.endsWith('</my_memory_catalog>'), 'catalog block is wrapped for Tier 1');

  const firstDream = writeDream(DATA, {
    id: 'dream-test-a',
    started_at: Date.UTC(2026, 10, 17, 2, 0, 0),
    ended_at: Date.UTC(2026, 10, 17, 2, 10, 0),
    trigger: 'manual',
    narrative: '第一场梦。',
    afterglow: '一点余韵。',
  });
  const secondDream = writeDream(DATA, {
    id: 'dream-test-b',
    started_at: Date.UTC(2026, 10, 17, 3, 0, 0),
    ended_at: Date.UTC(2026, 10, 17, 3, 10, 0),
    trigger: 'manual',
    narrative: '第二场梦。',
    afterglow: '另一点余韵。',
  });
  const rewritten = writeDream(DATA, {
    id: 'dream-test-a',
    started_at: Date.UTC(2026, 10, 17, 2, 0, 0),
    ended_at: Date.UTC(2026, 10, 17, 2, 10, 0),
    trigger: 'manual',
    narrative: '第一场梦（重写）。',
    afterglow: '一点余韵。',
  });
  check(path.basename(firstDream) === '2026-11-17_#01.md', 'first dream uses #01');
  check(path.basename(secondDream) === '2026-11-17_#02.md', 'second dream does not overwrite #01');
  check(path.basename(rewritten) === '2026-11-17_#01.md', 'the same dream id updates its own file, not a new one');
  check(
    fs.readFileSync(secondDream, 'utf8').includes('第二场梦'),
    'the earlier dream survives the second one',
  );

  const schedule = new MySchedule({ dataDir: DATA, clock: () => Date.UTC(2026, 10, 17, 9, 0, 0) });
  schedule.init();
  const alarm = schedule.add({ delayMinutes: 30, intention: '自己写篇日记', actionType: 'proactive_message' });
  check(alarm.status === 'pending' && alarm.wake_at > Date.UTC(2026, 10, 17, 9, 0, 0), 'alarm is pending in the future');
  check(schedule.due(alarm.wake_at - 1).length === 0, 'alarm is not due early');
  check(schedule.due(alarm.wake_at).length === 1, 'alarm is due at wake time');
  schedule.mark(alarm.id, 'fired', { session_id: 's1' });
  check(schedule.due(alarm.wake_at + 1).length === 0, 'fired alarm is not due again');
  check(JSON.parse(fs.readFileSync(schedule.file, 'utf8')).entries.length === 1, 'schedule persisted to soul/my_schedule.json');

  store.close();
  fs.rmSync(DATA, { recursive: true, force: true });

  if (failures) {
    console.error(`\nFAIL: ${failures} failed assertion(s)`);
    process.exitCode = 1;
  } else {
    console.log('\nPASS: 0 failed assertion(s)');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  try {
    fs.rmSync(DATA, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
