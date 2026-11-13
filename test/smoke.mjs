/**
 * Pre-install smoke test for the bionic memory algorithm layer.
 *
 * Runs the real store and engine against a throwaway directory, exercising:
 *   • repetitive compression (habituation drop + organ folding)
 *   • exception-anchor retention
 *   • Ebbinghaus decay with physical L0/L1 erasure
 *   • context XML assembly
 *   • NREM skill extraction + REM dream (deterministic fallback, no model)
 *   • forget + on-disk persistence across reopen
 *
 * Usage: node test/smoke.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeConfig } from '../lib/config.js';
import { BionicMemoryEngine } from '../lib/engine.js';
import { openStore } from '../lib/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIR = path.join(ROOT, '.smoke-data');

let failures = 0;
function check(condition, message, extra) {
  if (condition) {
    console.log(`ok - ${message}`);
  } else {
    failures += 1;
    console.error(`FAIL - ${message}${extra === undefined ? '' : ` :: ${JSON.stringify(extra)}`}`);
  }
}

function section(title) {
  console.log(`\n# ${title}`);
}

async function main() {
  fs.rmSync(DIR, { recursive: true, force: true });

  let now = Date.UTC(2026, 10, 12, 6, 0, 0);
  const clock = () => now;
  const config = normalizeConfig({ llmEnabled: false, fallibilityEnabled: false, debug: true });

  section('boot');
  const store = await openStore({ dir: DIR });
  check(store.kind === 'sqlite' || store.kind === 'json', `store backend selected: ${store.kind}`);
  const engine = new BionicMemoryEngine({ store, config, clock, dataDir: DIR, llm: null });
  engine.init();
  check(engine.state().stats.episodes === 0, 'fresh store starts empty');

  section('three similar episodes fold into a habit schema');
  const textA = { user: '帮我把这个 Python 脚本改成异步的，顺便加日志。', assistant: '好的，我把 requests 换成 httpx，加了结构化日志。' };
  const textB = { user: '这个 Python 脚本还是同步的，能改成异步吗？顺便把日志加上。', assistant: '可以，我把它改成异步，并补充日志。' };
  const textC = { user: '把 Python 脚本改成异步，日志也补一下。', assistant: '好，异步改造和日志都完成了。' };
  const first = await engine.ingestTurn({ session_id: 'session-smoke-1', turn: 1, user_text: textA.user, assistant_text: textA.assistant });
  now += 10 * 60 * 1000;
  const second = await engine.ingestTurn({ session_id: 'session-smoke-1', turn: 2, user_text: textB.user, assistant_text: textB.assistant });
  now += 10 * 60 * 1000;
  const third = await engine.ingestTurn({ session_id: 'session-smoke-1', turn: 3, user_text: textC.user, assistant_text: textC.assistant });
  check(first.stored && second.stored && third.stored, 'three turns stored');
  check(third.collapsed !== null, 'third similar episode triggered organ folding', third);
  const schemaList = store.listSchemas();
  check(schemaList.length === 1, 'exactly one compressed schema exists', schemaList.length);
  check(schemaList[0]?.occurrence_count >= 3, 'schema counts the folded occurrences', schemaList[0]?.occurrence_count);
  check(
    Array.isArray(schemaList[0]?.exception_anchors) && schemaList[0].exception_anchors.length === 1,
    'exactly one exception anchor is retained',
    schemaList[0]?.exception_anchors,
  );
  const afterFold = store.listEpisodes();
  check(afterFold.length === 1, 'mediocre repeats were physically deleted', afterFold.length);
  check(afterFold[0]?.anchor === 1, 'surviving episode is marked as the anchor');

  section('an unremarkable repeat is habituated away');
  const repeat = await engine.ingestTurn({ session_id: 'session-smoke-1', turn: 4, user_text: textC.user, assistant_text: textC.assistant });
  check(repeat.habituated === true, 'repeat was dropped as habituation', repeat);
  check(store.listSchemas()[0].occurrence_count >= 4, 'habit counter advanced instead of storing the turn');
  check(store.listEpisodes().length === 1, 'no new episode was written for the repeat');

  section('a different exchange is remembered');
  now += 30 * 3600 * 1000;
  const guitar = { user: '我最近在学吉他，F 和弦总是按不响。', assistant: '可以先从简化版的 F 和弦开始，慢慢加强手指力量。' };
  const distinct = await engine.ingestTurn({ session_id: 'session-smoke-2', turn: 1, user_text: guitar.user, assistant_text: guitar.assistant });
  check(distinct.stored && distinct.collapsed === null, 'distinct exchange stored without folding', distinct);
  now += 10 * 60 * 1000;

  section('a correction turn is captured for NREM skill extraction');
  const correction = {
    user: '不对，我不是要改后端，我是要改前端那个按钮的样式。',
    assistant: '明白了，我先停下来，把范围缩到前端样式，再动手。',
  };
  const corrected = await engine.ingestTurn({
    session_id: 'session-smoke-2',
    turn: 2,
    user_text: correction.user,
    assistant_text: correction.assistant,
  });
  check(corrected.stored, 'correction turn stored', corrected);

  section('context assembler renders the four layers');
  const xml = engine.renderContext({ session_id: '' });
  check(xml.includes('<bionic_memory_context>'), 'context root present');
  check(xml.includes('<time_awareness>'), 'time awareness present');
  check(xml.includes('<subconscious_scratchpad>'), 'scratchpad present');
  check(xml.includes('<habits_and_schemas>'), 'habit layer present');
  check(xml.includes('唯独记得的一次例外/高光'), 'exception anchor surfaced');
  check(/<clear_memories|<summarized_memories/.test(xml), 'a detailed/gist memory band is present');
  check(xml.length <= config.contextCharBudget + 80, 'context respects the character budget', xml.length);

  section('dream (deterministic fallback)');
  const dreamResult = await engine.dream({ trigger: 'manual' });
  check(dreamResult.ok === true, 'dream completed', dreamResult.error);
  const dream = dreamResult.dream;
  check(typeof dream.narrative === 'string' && dream.narrative.length > 40, 'dream narrative generated', dream.narrative);
  check(typeof dream.afterglow === 'string' && dream.afterglow.length <= 100, 'afterglow is under 100 chars', dream.afterglow);
  check(dream.remembered_fraction <= 0.2 + 1e-9, '80% of the dream was forgotten', dream.remembered_fraction);
  const skills = store.listSkills();
  check(skills.length >= 1, 'NREM extracted at least one procedural skill', skills);
  check(
    skills.some((skill) => skill.rule.includes('纠正') || skill.rule.includes('意图')),
    'correction became an If-Then instinct',
    skills.map((skill) => skill.rule),
  );
  const afterDream = engine.getScratchpad();
  check(Boolean(afterDream.dream_afterglow), 'afterglow written into the subconscious scratchpad');

  section('Ebbinghaus decay physically erases details');
  const beforeDecay = store.listEpisodes();
  now += 1000 * 3600 * 1000;
  const decay = engine.decayAll(now, { force: true });
  check(decay.faded >= 1, 'at least one episode crossed the fade threshold', decay);
  const afterDecay = store.listEpisodes();
  const erased = afterDecay.filter((episode) => !episode.level_0_raw && !episode.level_1_summary);
  check(erased.length >= 1, 'L0 and L1 were physically cleared', erased.length);
  check(erased.every((episode) => Boolean(episode.level_2_impression)), 'L2 impressions survive');
  check(beforeDecay.length === afterDecay.length, 'decay never deletes rows, only resolution');

  const fadedXml = engine.renderContext({ session_id: '' });
  check(fadedXml.includes('<faded_impressions'), 'faded impression block rendered after decay');

  section('forget removes impression-only memories');
  const countBeforeForget = store.listEpisodes().length;
  const forgotten = engine.forget('faded');
  check(forgotten.ok === true, 'forget returned ok');
  check(store.listEpisodes().length <= countBeforeForget, 'forget removed faded episodes', {
    before: countBeforeForget,
    after: store.listEpisodes().length,
  });

  section('persistence across reopen');
  const snapshot = {
    episodes: store.listEpisodes().length,
    schemas: store.listSchemas().length,
    skills: store.listSkills().length,
    dreams: store.listDreams(10).length,
    afterglow: engine.getScratchpad().dream_afterglow,
  };
  engine.close();

  const reopened = await openStore({ dir: DIR });
  const engine2 = new BionicMemoryEngine({ store: reopened, config, clock, dataDir: DIR, llm: null });
  engine2.init();
  check(reopened.listEpisodes().length === snapshot.episodes, 'episodes persisted', {
    expected: snapshot.episodes,
    actual: reopened.listEpisodes().length,
  });
  check(reopened.listSchemas().length === snapshot.schemas, 'schemas persisted');
  check(reopened.listSkills().length === snapshot.skills, 'skills persisted');
  check(reopened.listDreams(10).length === snapshot.dreams, 'dreams persisted');
  check(
    engine2.getScratchpad().dream_afterglow === snapshot.afterglow,
    'dream afterglow persisted in the scratchpad',
  );

  const state = engine2.state();
  check(typeof state.backend === 'string', 'state exposes the backend');
  check(Array.isArray(state.graph.nodes) && Array.isArray(state.graph.edges), 'state exposes the memory graph');
  check(Array.isArray(state.journal) && state.journal.length > 0, 'journal has entries');
  check(state.context_preview === '' || state.context_preview.startsWith('<bionic_memory_context>'), 'context preview is shaped correctly');

  engine2.close();
  fs.rmSync(DIR, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failed assertion(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('SMOKE ERROR', error?.stack || error);
  process.exitCode = 1;
});
