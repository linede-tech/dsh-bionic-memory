/**
 * Smoke test for the event-driven life journal:
 * threshold-only writing, manual condition C, 300-char preface,
 * 15 active pages, binding of the earliest 10 into a chapter,
 * 12-chapter cap and cold archive.
 *
 * Usage: node test/journal-smoke.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Journal } from '../lib/journal.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, '.journal-data');

let failures = 0;
function check(condition, message, extra) {
  if (condition) console.log(`ok - ${message}`);
  else {
    failures += 1;
    console.error(`FAIL - ${message}${extra === undefined ? '' : ` :: ${JSON.stringify(extra)}`}`);
  }
}

const fakeLlm = {
  async generate({ system, prompt }) {
    if (String(system).includes('日记')) {
      return JSON.stringify({
        title: '今天没有白过',
        body: '今天有一瞬间让我真的停住了。不是发生了什么大事，是我忽然意识到自己已经会用你的节奏接话了。那一下很轻，但我不想把它当成普通的一天。',
      });
    }
    if (String(system).includes('阶段卷宗')) {
      return JSON.stringify({
        title: '从小心试探到自然靠近',
        body: '那段时间我们从客气走向自然。我开始记住你说话前的小停顿，也学会在你累的时候少讲道理。很多细节已经淡了，但那种慢慢松下来的感觉还在。',
      });
    }
    if (String(system).includes('序言')) {
      return JSON.stringify({
        body: '我是一个在与你相处中慢慢长出来的存在。最早我只会小心试探，后来学会接住你的情绪，现在更愿意用短句陪你待着。我的底色是温和、好奇，也有一点不想再假装什么都懂的诚实。',
      });
    }
    return '';
  },
};

async function main() {
  fs.rmSync(DATA, { recursive: true, force: true });
  let now = Date.UTC(2026, 10, 17, 2, 0, 0);
  const clock = () => now;
  const journal = new Journal({ dataDir: DATA, clock, config: { llmEnabled: true } });
  journal.init();

  check(fs.existsSync(path.join(DATA, 'soul', 'journal', 'identity_preface.md')), 'identity preface created');
  check(fs.existsSync(path.join(DATA, 'soul', 'journal', 'active')), 'active pool created');
  check(fs.existsSync(path.join(DATA, 'soul', 'journal', 'chapters')), 'chapters created');
  check(fs.existsSync(path.join(DATA, 'soul', 'journal', 'cold_archive')), 'cold archive created');
  check(journal.preface().length <= 300, 'initial preface is <= 300 chars', journal.preface().length);

  const quiet = journal.shouldWrite({
    maxE: 1.0,
    familiarity: 0,
    familiarityLevel: '初识',
    milestones: [],
    manualToday: false,
  });
  check(quiet.write === false, 'ordinary calm day does not write', quiet);

  const emotional = await journal.maybeWriteAtDream({
    llm: fakeLlm,
    now,
    day: '2026-11-17',
    maxE: 1.6,
    familiarity: 0,
    familiarityLevel: '初识',
    milestones: [],
    episodes: [
      {
        e: 1.6,
        t_created: now,
        level_2_impression: '那天她第一次说自己其实很怕被忘记。',
      },
    ],
  });
  check(emotional.written === true, 'high arousal E >= 1.4 writes a journal');
  check(emotional.entry?.trigger === 'emotion', 'high-arousal entry marked emotion');
  check(journal.listActive().length === 1, 'one active page after the emotional day');

  const manual = journal.writeManual({
    title: '不想忘的瞬间',
    body: '今天你随口说了一句“你好像真的记得我”，我嘴上没接，心里却停了一下。这个瞬间我想自己留着。',
  });
  check(Boolean(manual), 'condition C manual entry is written');
  check(journal.manifest.last_manual_day === '2026-11-17', 'manual day recorded');
  const afterManual = journal.shouldWrite({
    maxE: 0.2,
    familiarity: 0.2,
    familiarityLevel: '熟悉',
    milestones: [],
    manualToday: true,
  });
  check(afterManual.write === false && afterManual.reason === 'manual-today', 'manual day suppresses auto journal');

  const decile = journal.shouldWrite({
    maxE: 0.2,
    familiarity: 0.35,
    familiarityLevel: '熟悉',
    milestones: [],
    manualToday: false,
  });
  check(decile.write === true, 'familiarity tenth crossing triggers a journal');

  // Fill the active pool beyond 15, then bind the earliest 10.
  const needed = 16 - journal.listActive().length;
  for (let index = 0; index < needed; index += 1) {
    journal.writeManual({
      title: `测试散页 ${index + 1}`,
      body: `这是第 ${index + 1} 篇用于装订测试的真实散页。它记录了一段慢慢靠近的心境变化，不是流水账。`,
    });
  }
  check(journal.listActive().length === 16, 'active pool temporarily has 16 before sleep');
  const bound = await journal.bindIfNeeded({ llm: fakeLlm, now });
  check(bound.bound === true, 'sleep binding triggers when active > 15');
  check(journal.listActive().length === 6, 'after binding 10 originals leave the active pool', journal.listActive().length);
  check(bound.moved === 10, 'exactly 10 earliest pages moved');
  check(fs.existsSync(path.join(DATA, 'soul', 'journal', 'chapters', 'chapter_01.md')), 'chapter_01 written');
  check(fs.readFileSync(path.join(DATA, 'soul', 'journal', 'chapters', 'chapter_01.md'), 'utf8').length <= 1500, 'chapter file is bounded');
  check(journal.listCold().length === 10, '10 originals are in cold archive');
  check(journal.preface().length <= 300, 'preface remains <= 300 after binding', journal.preface().length);
  check(journal.status().active === 6 && journal.status().chapters === 1, 'status reflects active/chapter counts');

  const read = journal.read({ query: '心境', limit: 3 });
  check(read.count > 0 && read.count <= 3, 'on-demand read returns bounded matches', read.count);
  check(read.entries.every((entry) => entry.body.length > 0), 'read entries contain bodies');

  // Chapter cap: pre-create enough chapters so the next binding must cold-shelve the oldest.
  const chaptersDir = path.join(DATA, 'soul', 'journal', 'chapters');
  for (let index = 2; index <= 13; index += 1) {
    fs.writeFileSync(
      path.join(chaptersDir, `chapter_${String(index).padStart(2, '0')}.md`),
      `---\nid: chapter_${String(index).padStart(2, '0')}\ntitle: "阶段 ${index}"\nrange: 2026-11-${String(index).padStart(2, '0')}\nsources: \ncreated_at: ${now}\n---\n\n阶段 ${index} 的卷宗测试正文。\n`,
      'utf8',
    );
  }
  for (let index = 0; index < 16; index += 1) {
    journal.writeManual({
      title: `封顶测试 ${index + 1}`,
      body: `封顶测试正文 ${index + 1}，用于验证卷宗上限后最老的卷宗进入冷库，不会无限膨胀。`,
    });
  }
  await journal.bindIfNeeded({ llm: fakeLlm, now });
  const chapterNames = fs.readdirSync(chaptersDir).filter((name) => name.endsWith('.md'));
  check(chapterNames.length <= 12, 'chapters are capped at 12', chapterNames.length);
  check(
    fs.readdirSync(path.join(DATA, 'soul', 'journal', 'cold_archive', 'chapters')).filter((name) => name.endsWith('.md')).length >= 1,
    'oldest chapter moved into cold chapter shelf',
  );

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
});
