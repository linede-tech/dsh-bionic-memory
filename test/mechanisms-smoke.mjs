/**
 * Smoke test for the six advanced bionic mechanisms:
 *   source attribution, cognitive dissonance, skill cap/merge/degrade,
 *   cross-session awareness, reconsolidation and the dream recall cache.
 *
 * Usage: node test/mechanisms-smoke.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeConfig } from '../lib/config.js';
import { BionicMemoryEngine } from '../lib/engine.js';
import { openStore } from '../lib/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let failures = 0;
function check(condition, message, extra) {
  if (condition) {
    console.log(`ok - ${message}`);
  } else {
    failures += 1;
    console.error(`FAIL - ${message}${extra === undefined ? '' : ` :: ${JSON.stringify(extra)}`}`);
  }
}

function uniqueDir(name) {
  return path.join(ROOT, `.mechanisms-${name}-data`);
}

function fakeSessions(ids, messageRef, presets = {}) {
  const presetFor = (id) => presets[id] || 'bionic-memory';
  return {
    list: () => ids.map((id) => ({ id, header: { agentPreset: presetFor(id) } })),
    get: (id) =>
      ids.includes(id)
        ? {
            id,
            header: { agentPreset: presetFor(id) },
            deriveMessages: () =>
              messageRef.value
                ? [{ role: 'user', content: [{ type: 'text', text: messageRef.value }] }]
                : [],
          }
        : undefined,
  };
}

async function withEngine(dirName, options, run) {
  const dir = uniqueDir(dirName);
  fs.rmSync(dir, { recursive: true, force: true });
  let now = Date.UTC(2026, 10, 12, 6, 0, 0);
  const clock = () => now;
  const config = normalizeConfig({
    llmEnabled: false,
    collapseThreshold: 3,
    maxSkills: 20,
    skillIdleDays: 30,
    sessionHintMax: 3,
    fallibilityEnabled: false,
    ...options.config,
  });
  const store = await openStore({ dir });
  const engine = new BionicMemoryEngine({
    store,
    config,
    clock,
    dataDir: dir,
    llm: null,
    sessions: options.sessions,
  });
  engine.init();
  const api = {
    engine,
    store,
    config,
    advance: (ms) => {
      now += ms;
    },
    setNow: (value) => {
      now = value;
    },
    now: () => now,
  };
  try {
    await run(api);
  } finally {
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function sourceAndDream() {
  console.log('\n# source attribution + dream cache');
  await withEngine(
    'source',
    { sessions: fakeSessions(['s1']) },
    async ({ engine, store }) => {
      const stated = await engine.ingestTurn({
        session_id: 's1',
        turn: 1,
        user_text: '我的猫叫波波，她喜欢趴在键盘上。',
        assistant_text: '记住了，波波会趴在键盘上。',
      });
      const inferred = await engine.ingestTurn({
        session_id: 's1',
        turn: 2,
        user_text: '我想你大概觉得我更喜欢猫。',
        assistant_text: '这可能只是我的推测。',
        source_type: 'agent_inferred',
      });
      check(store.getEpisode(stated.episode_id)?.source_type === 'user_stated', 'user turn stored as user_stated');
      check(store.getEpisode(inferred.episode_id)?.source_type === 'agent_inferred', 'explicit inference stored as agent_inferred');

      const beforeConfirm = engine.renderContext({ session_id: 's1' });
      check(beforeConfirm.includes('[用户亲述]'), 'context labels user-stated memory');
      check(beforeConfirm.includes('[我的推测·未证实]'), 'context labels inferred memory');

      const confirmed = engine.confirmMemory(inferred.episode_id);
      check(confirmed.ok === true, 'confirm action accepted');
      check(store.getEpisode(inferred.episode_id)?.source_type === 'user_stated', 'confirmation upgraded the inferred memory');

      const dream = await engine.dream({ trigger: 'manual' });
      check(dream.ok === true, 'dream completed');
      const cache = engine.lastDreamCache();
      check(cache?.source_type === 'dream_generated', 'dream cache is labeled dream_generated', cache?.source_type);
      const after = engine.renderContext({ session_id: 's1' });
      const fingerprint = String(cache?.narrative || '').slice(0, 24);
      check(fingerprint.length > 0 && !after.includes(fingerprint), 'full dream narrative is not injected');
      check(after.includes('梦境生成，不可当作事实'), 'afterglow is labeled as dream-generated');

      const rejected = engine.confirmMemory(dream.dream.id);
      check(rejected.ok === false, 'a dream cannot be confirmed as fact', rejected);
    },
  );
}

async function dissonance() {
  console.log('\n# cognitive dissonance against a stable habit');
  await withEngine(
    'dissonance',
    { sessions: fakeSessions(['s1']) },
    async ({ engine, store }) => {
      const habitTexts = [
        { user: '我习惯深夜写代码的时候喝一杯冰美式。', assistant: '好，冰美式配深夜代码。' },
        { user: '深夜写代码的时候，我习惯喝一杯冰美式。', assistant: '嗯，冰美式是深夜代码的标配。' },
        { user: '我深夜写代码的时候习惯喝冰美式。', assistant: '记住了，冰美式配深夜代码。' },
      ];
      for (let i = 0; i < habitTexts.length; i += 1) {
        await engine.ingestTurn({
          session_id: 's1',
          turn: i + 1,
          user_text: habitTexts[i].user,
          assistant_text: habitTexts[i].assistant,
        });
      }
      const schema = store.listSchemas()[0];
      check(Boolean(schema), 'habit schema formed', store.listSchemas());
      if (!schema) return;
      store.updateSchema(schema.id, { stability_score: 0.85 });
      engine.config.collapseThreshold = 99;

      const contradiction = await engine.ingestTurn({
        session_id: 's1',
        turn: 4,
        user_text: '我以后不再深夜写代码了，也不想喝冰美式了，想早点睡。',
        assistant_text: '好，那我们把夜间任务改到白天。',
      });
      const updated = store.listSchemas().find((item) => item.id === schema.id);
      check(contradiction.stored === true, 'contradiction was stored as a new episode');
      check(contradiction.surprise === 2, 'contradiction forced surprise N=2.0', contradiction.surprise);
      check(updated?.status === 'historical', 'stable habit downgraded to historical', updated?.status);
      const hooks = engine.getScratchpad().curiosity_hooks;
      check(hooks.some((hook) => hook.source === `dissonance:${schema.id}`), 'care hook created for the contradiction');
      const edges = store.listEdges(100);
      check(edges.some((edge) => edge.relation === 'contradicted_by'), 'contradicted_by edge recorded');
    },
  );
}

async function skills() {
  console.log('\n# instinct cap, merge and idle degradation');
  await withEngine('skills', { sessions: fakeSessions(['s1']) }, async ({ engine, store, advance }) => {
    const topics = [
      '部署', '测试', '重构', '设计', '文档', '性能', '安全', '并发', '缓存', '日志',
      '监控', '回滚', '迁移', '索引', '序列化', '网络', '权限', '限流', '重试', '灰度',
      '构建', '打包', '发布', '回放', '审计',
    ];
    for (let i = 0; i < topics.length; i += 1) {
      engine.insertSkill(
        `当处理${topics[i]}相关任务时，先确认边界与失败模式，再开始动手。`,
        0.6 + (i % 10) * 0.01,
        'test',
        { allowDuplicate: true },
      );
    }
    const xml = engine.renderContext({ session_id: 's1' });
    const injected = (xml.match(/\[本能经验\]/g) || []).length;
    check(injected <= 20, 'context injects at most 20 instincts', injected);

    const activeBefore = store.listSkills().filter((skill) => skill.active).length;
    const demoted = engine.enforceSkillCap();
    const activeAfter = store.listSkills().filter((skill) => skill.active).length;
    check(activeBefore > 20, 'more than 20 instincts were present', activeBefore);
    check(demoted.length === activeBefore - 20, 'last-place elimination removed the overflow', demoted.length);
    check(activeAfter === 20, 'active instincts capped at 20', activeAfter);

    engine.insertSkill('当处理部署任务时，先确认边界与失败模式，再开始动手。', 0.8, 'test', { allowDuplicate: true });
    engine.insertSkill('当处理部署任务时，先确认边界和失败模式，然后开始动手。', 0.7, 'test', { allowDuplicate: true });
    const merged = engine.mergeSkills();
    check(merged >= 1, 'near-duplicate instincts merged', merged);

    advance(31 * 86400000);
    const archived = engine.degradeIdleSkills();
    check(archived.length > 0, 'idle instincts degrade after the idle window', archived.length);
    const stillActive = store.listSkills().filter((skill) => skill.active);
    check(stillActive.length === 0, 'all idle instincts left the injected set', stillActive.length);
    const state = engine.state();
    check(Array.isArray(state.archived_skills) && state.archived_skills.length > 0, 'state exposes archived instincts');
    check(state.stats.skills_archived === state.archived_skills.length, 'archived instinct stat agrees with the list');
  });
}

async function crossSessionAndReconsolidation() {
  console.log('\n# cross-session awareness + reconsolidation');
  const messageRef = { value: '' };
  await withEngine(
    'cross',
    { sessions: fakeSessions(['s1', 's2', 's3'], messageRef, { s3: 'standard' }) },
    async ({ engine, store, advance }) => {
      await engine.ingestTurn({
        session_id: 's2',
        turn: 1,
        user_text: '我正在另一个窗口整理 Blender 场景的灯光。',
        assistant_text: '好，先把主光调柔和。',
      });
      await engine.ingestTurn({
        session_id: 's3',
        turn: 1,
        user_text: '标准模式窗口正在整理无关的项目排期。',
        assistant_text: '好。',
      });
      await engine.ingestTurn({
        session_id: 's1',
        turn: 1,
        user_text: '我在这边写记忆插件的测试。',
        assistant_text: '先把边界用例补齐。',
      });
      const xml = engine.renderContext({ session_id: 's1' });
      const blockStart = xml.indexOf('<parallel_sessions');
      const blockEnd = xml.indexOf('</parallel_sessions>');
      const parallelBlock = blockStart >= 0 && blockEnd > blockStart ? xml.slice(blockStart, blockEnd) : '';
      check(parallelBlock.includes('Blender 场景的灯光'), 'other session summary is visible');
      check(!parallelBlock.includes('我在这边写记忆插件的测试'), 'current session is not repeated as another window');
      check(!parallelBlock.includes('无关的项目排期'), 'standard-mode windows are excluded from the parallel hint');

      const old = await engine.ingestTurn({
        session_id: 's1',
        turn: 2,
        user_text: '那次我们讨论了海边的灯塔，风很大，但我很开心。',
        assistant_text: '听起来是很亮的一天。',
      });
      advance(2 * 3600000);
      messageRef.value = '灯塔';
      engine.renderContext({ session_id: 's1' });
      messageRef.value = '';
      const before = store.getEpisode(old.episode_id);
      advance(60 * 1000);
      await engine.ingestTurn({
        session_id: 's1',
        turn: 3,
        user_text: '今天有点低落，灯塔的事让我想起一些遗憾。',
        assistant_text: '我陪你待一会儿。',
      });
      const after = store.getEpisode(old.episode_id);
      check(Boolean(before), 'old episode exists');
      check(String(after?.emotion_tone || '').includes('再巩固为'), 'retrieved memory was reconsolidated with the turn tone', {
        before: before?.emotion_tone,
        after: after?.emotion_tone,
      });
      check((after?.t_last || 0) > (before?.t_last || 0), 'reconsolidation refreshed t_last');
    },
  );
}

async function main() {
  const defaults = normalizeConfig({});
  check(defaults.activation === 'preset', 'memory activation defaults to preset');
  check(defaults.observeAllSessions === false, 'observation defaults to preset-only');
  await sourceAndDream();
  await dissonance();
  await skills();
  await crossSessionAndReconsolidation();
  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failed assertion(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('MECHANISMS SMOKE ERROR', error?.stack || error);
  process.exitCode = 1;
});
