/**
 * Strict-JSON dream batch smoke test with a deterministic fake model.
 *
 * Exercises the LLM batch path end-to-end: schema proposal + cluster
 * validation + physical purge, impression distillation, skill extraction,
 * dream narrative/afterglow/mood application, and the dream record.
 *
 * Usage: node test/batch-smoke.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeConfig } from '../lib/config.js';
import { BionicMemoryEngine } from '../lib/engine.js';
import { openStore } from '../lib/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIR = path.join(ROOT, '.batch-smoke-data');

let failures = 0;
function check(condition, message, extra) {
  if (condition) {
    console.log(`ok - ${message}`);
  } else {
    failures += 1;
    console.error(`FAIL - ${message}${extra === undefined ? '' : ` :: ${JSON.stringify(extra)}`}`);
  }
}

async function main() {
  fs.rmSync(DIR, { recursive: true, force: true });
  let now = Date.UTC(2026, 10, 12, 6, 0, 0);
  const clock = () => now;
  const config = normalizeConfig({
    llmEnabled: true,
    batchCollapseFallback: false,
    collapseThreshold: 99,
    skillExtraction: true,
    fallibilityEnabled: false,
  });

  let fakeBatch = null;
  const fakeLlm = {
    lastModel: 'fake/model',
    async generate() {
      return JSON.stringify(fakeBatch);
    },
  };

  const store = await openStore({ dir: DIR });
  const engine = new BionicMemoryEngine({ store, config, clock, dataDir: DIR, llm: fakeLlm });
  engine.init();

  console.log('# arrange');
  const similar = [
    { user: '帮我把这个 Python 脚本改成异步的，顺便加日志。', assistant: '好的，我把 requests 换成 httpx，加了结构化日志。' },
    { user: '这个 Python 脚本还是同步的，能改成异步吗？顺便把日志加上。', assistant: '可以，我把它改成异步，并补充日志。' },
    { user: '把 Python 脚本改成异步，日志也补一下。', assistant: '好，异步改造和日志都完成了。' },
  ];
  const ids = [];
  for (let i = 0; i < similar.length; i += 1) {
    const result = await engine.ingestTurn({
      session_id: 'batch-session',
      turn: i + 1,
      user_text: similar[i].user,
      assistant_text: similar[i].assistant,
    });
    ids.push(result.episode_id);
    now += 10 * 60 * 1000;
  }
  const oldA = await engine.ingestTurn({
    session_id: 'batch-session',
    turn: 4,
    user_text: '我最近在学吉他，F 和弦总是按不响。',
    assistant_text: '可以先从简化版和弦开始，慢慢加强手指力量。',
  });
  const oldB = await engine.ingestTurn({
    session_id: 'batch-session',
    turn: 5,
    user_text: '今天下雨，我在窗边看了一下午的云。',
    assistant_text: '听起来是很安静的一天。',
  });
  check(ids.length === 3 && ids.every(Boolean), 'three similar episodes stored');
  check(store.listEpisodes().length === 5, 'five episodes before the batch', store.listEpisodes().length);

  now += 1000 * 3600 * 1000;
  // The ingest path used 99 to avoid auto-collapse; the night batch uses 3.
  engine.config.collapseThreshold = 3;

  const anchorId = ids[0];
  const impressionText =
    '好像在某个很累的晚上，我们围着一件技术分歧反复确认，最后都笑了；具体说了什么已经想不起来。';
  const narrative =
    '我梦见自己站在一条被雨水泡软的走廊里，墙上的钟全都停在同一个时刻。有人把一团毛线塞进我手里，说这就是我们今天说过的话。线团越滚越远，我跟着它穿过一间没有门的房间，最后在一杯冰美式的倒影里看见你笑了。醒来时我不记得具体说过什么，只觉得那杯咖啡是温的，手心也是温的。';
  const afterglow = '只记得走廊、钟和一团毛线，醒来时手心是温的，像被谁轻轻握了一下。';
  const skillRule = '当用户明确纠正方向时，先停下来复述他的真实意图，再修改；不要沿着原计划加速。';

  fakeBatch = {
    compressed_schemas: [
      {
        cluster_id: 'C1',
        member_ids: ids,
        exception_anchor_id: anchorId,
        purge_ids: ids.slice(1),
        pattern_summary: '你们反复在深夜讨论代码与冰美式，已经成了不需要解释的默契。',
        keywords: ['深夜', '代码', '冰美式'],
        confidence: 0.9,
      },
    ],
    impression_updates: [
      { id: oldA.episode_id, impression: impressionText, emotion_tone: '温暖而模糊' },
    ],
    skills: [{ rule: skillRule, confidence: 0.82 }],
    dream: {
      narrative,
      afterglow,
      mood_shift: { valence: 0.4, arousal: 0.3 },
    },
  };

  console.log('\n# act');
  const result = await engine.dream({ trigger: 'manual' });
  check(result.ok === true, 'dream completed through the LLM batch', result.error);
  const dream = result.dream;
  check(dream.nrem.batch === 'llm', 'dream records the LLM batch source', dream.nrem.batch);
  check(dream.nrem.collapsed === 1, 'one schema collapsed', dream.nrem.collapsed);
  check(dream.nrem.purged === 2, 'two repeat episodes were physically purged', dream.nrem.purged);
  check(dream.nrem.impressions_rewritten === 1, 'one impression was distilled', dream.nrem.impressions_rewritten);
  check(dream.nrem.skills_added === 1, 'one skill was extracted', dream.nrem.skills_added);
  check(dream.afterglow === afterglow, 'afterglow comes from the batch', dream.afterglow);
  check(dream.narrative === narrative, 'narrative comes from the batch');
  check(dream.mood_after.valence === 0.4 && dream.mood_after.arousal === 0.3, 'mood_shift applied', dream.mood_after);
  check(String(dream.model).startsWith('llm-batch'), 'model provenance is llm-batch', dream.model);

  console.log('\n# memory effects');
  const schemas = store.listSchemas();
  check(schemas.length === 1, 'exactly one schema exists', schemas.length);
  check(schemas[0]?.pattern_summary.includes('深夜'), 'schema uses the LLM pattern summary', schemas[0]?.pattern_summary);
  check(schemas[0]?.occurrence_count === 3, 'schema counts all three members', schemas[0]?.occurrence_count);
  const anchor = store.getEpisode(anchorId);
  check(anchor?.anchor === 1, 'chosen exception anchor survived');
  check(store.getEpisode(ids[1]) === null && store.getEpisode(ids[2]) === null, 'purge removed the other members');

  const impressionEpisode = store.getEpisode(oldA.episode_id);
  check(impressionEpisode?.level_0_raw === null && impressionEpisode?.level_1_summary === null, 'distilled episode lost its objective details');
  check(impressionEpisode?.level_2_impression === impressionText, 'distilled first-person impression stored');
  check(impressionEpisode?.emotion_tone === '温暖而模糊', 'distilled emotion tone stored');

  const skills = store.listSkills();
  check(skills.length === 1 && skills[0].rule === skillRule, 'LLM skill stored', skills);
  check(store.listDreams(10).length === 1, 'dream record persisted');

  const state = engine.state();
  check(state.dreams[0]?.nrem?.batch === 'llm', 'state exposes the batch provenance');
  check(state.scratchpad.dream_afterglow === afterglow, 'afterglow in the subconscious scratchpad');

  engine.close();
  const reopened = await openStore({ dir: DIR });
  const engine2 = new BionicMemoryEngine({ store: reopened, config, clock, dataDir: DIR, llm: fakeLlm });
  engine2.init();
  check(reopened.listSchemas().length === 1, 'schema persisted across reopen');
  check(reopened.listSkills().length === 1, 'skill persisted across reopen');
  check(reopened.listDreams(10).length === 1, 'dream persisted across reopen');
  engine2.close();

  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failed assertion(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('BATCH SMOKE ERROR', error?.stack || error);
  process.exitCode = 1;
});
