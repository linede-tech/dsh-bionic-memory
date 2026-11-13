/**
 * Smoke test for the Controlled Distortion Filter (memory fallibility):
 * chimera, tip-of-the-tongue, source/dream confusion, schema overwrite,
 * immunity guard, snap-back correction and dream-engine anchors.
 *
 * Usage: node test/fallibility-smoke.mjs
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

function fakeSessions(ids) {
  return {
    list: () => ids.map((id) => ({ id, header: { agentPreset: 'bionic-memory' } })),
    get: (id) =>
      ids.includes(id)
        ? {
            id,
            header: { agentPreset: 'bionic-memory' },
            deriveMessages: () => [],
          }
        : undefined,
  };
}

function sequence(values) {
  const queue = [...values];
  return () => (queue.length ? queue.shift() : 0.5);
}

async function withEngine(name, run) {
  const dir = path.join(ROOT, `.fallibility-${name}-data`);
  fs.rmSync(dir, { recursive: true, force: true });
  let now = Date.UTC(2026, 10, 12, 6, 0, 0);
  const clock = () => now;
  const config = normalizeConfig({
    llmEnabled: false,
    fallibilityEnabled: true,
    collapseThreshold: 99,
    contextCharBudget: 8000,
  });
  const store = await openStore({ dir });
  const engine = new BionicMemoryEngine({
    store,
    config,
    clock,
    dataDir: dir,
    llm: null,
    sessions: fakeSessions(['s1']),
    random: () => 0.5,
  });
  engine.init();
  try {
    await run({
      engine,
      store,
      config,
      advance: (ms) => {
        now += ms;
      },
    });
  } finally {
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function ingest(engine, texts) {
  let turn = 0;
  for (const text of texts) {
    turn += 1;
    await engine.ingestTurn({
      session_id: 's1',
      turn,
      user_text: text,
      assistant_text: '嗯，我记住了。',
    });
  }
}

function ageTo(engine, advance, target, maxHours = 240) {
  for (let index = 0; index < maxHours; index += 1) {
    const episodes = engine.store.listEpisodes();
    if (!episodes.length) return;
    if (episodes.every((episode) => engine.retention(episode) <= target)) return;
    advance(3600000);
  }
}

async function chimeraAndCorrection() {
  console.log('\n# chimera + snap-back correction + dream anchors');
  await withEngine('chimera', async ({ engine, store, advance }) => {
    await ingest(engine, [
      '那天下午我去了海边书店，买了一本旧诗集，风很大。',
      '那天下午我在海边书店门口喝咖啡，看到一只橘猫。',
    ]);
    ageTo(engine, advance, 0.4);
    engine.random = sequence([0, 0, 0]);
    const xml = engine.renderContext({ session_id: 's1' });
    const distortion = engine.activeDistortions.get('s1');
    check(distortion?.type === 'chimera', 'chimera operator triggered', distortion?.type);
    check(xml.includes('<distorted_or_chimera_memory type="chimera"'), 'chimera wrapper injected');
    check(xml.includes('<chimera_memory>'), 'chimera memory tag injected');
    const chimeraStart = xml.indexOf('<chimera_memory>');
    const chimeraEnd = xml.indexOf('</chimera_memory>');
    const chimeraText = chimeraStart >= 0 && chimeraEnd > chimeraStart
      ? xml.slice(chimeraStart, chimeraEnd)
      : '';
    check(
      chimeraText.includes('海边书店') && chimeraText.includes('橘猫'),
      'chimera splices A cause with B detail',
      chimeraText,
    );
    check(xml.includes('<shadow_truth_for_correction'), 'shadow truth block present');
    check(
      xml.includes('visibility="do-not-use-until-the-user-corrects-you"'),
      'shadow truth is marked hidden until correction',
    );
    for (const id of distortion?.episode_ids || []) {
      check(xml.includes(id), `shadow truth records original id ${id}`);
    }

    // Simulate a fast user correction arriving before the debounced turn-end
    // flush: the correction must still be detected even though awaiting_user
    // has not been set yet.
    const before = new Map(
      (distortion?.episode_ids || []).map((id) => [id, store.getEpisode(id)?.k ?? 0]),
    );
    const corrected = engine.noteUserMessage(
      's1',
      '你记错了，海边书店和橘猫不是同一天的事，是两段记忆。',
    );
    check(corrected?.corrected === true, 'correction listener works before the turn-end flush');
    for (const id of distortion?.episode_ids || []) {
      const episode = store.getEpisode(id);
      check((episode?.k ?? 0) === (before.get(id) ?? 0) + 2, `correction added k+2 to ${id}`, episode?.k);
      check(engine.retention(episode) > 0.9, `correction reset clarity for ${id}`, engine.retention(episode));
    }
    await engine.ingestTurn({
      session_id: 's1',
      turn: 3,
      user_text: '嗯，后来呢？',
      assistant_text: '我想想。',
    });
    const anchors = engine.getFallibilityAnchors(3);
    check(anchors.length === 1, 'one fun fallibility anchor created');
    check(anchors[0]?.text?.includes('[曾把'), 'anchor uses the self-teasing prefix', anchors[0]?.text);
    check(
      store.listJournal(0, 200).some((entry) => entry.kind === 'snapback'),
      'snapback event journaled',
    );

    const correctionXml = engine.renderContext({ session_id: 's1' });
    check(correctionXml.includes('<memory_fallibility_correction active="true">'), 'correction block injected');
    check(correctionXml.includes('<fallibility_anchor>'), 'anchor exposed in the correction block');
    check(correctionXml.includes('<shadow_truth_for_correction>'), 'shadow truth visible after correction');

    const prompt = engine.buildOfflineBatchPrompt({
      now: engine.now(),
      todayEpisodes: [],
      turns: [],
      clusters: [],
      faded: [],
      snippets: [],
      samples: [],
    });
    check(prompt.includes(anchors[0].text), 'dream NREM prompt includes the fallibility anchor');
    const narrative = engine.fallbackDream(
      [],
      { label: '平静', valence: 0, arousal: 0.25 },
      anchors,
    );
    check(narrative.includes('拍脑袋') || narrative.includes('记不清'), 'local dream weaves the memory slip');
  });
}

async function tipOfTongue() {
  console.log('\n# tip-of-the-tongue masking');
  await withEngine('tip', async ({ engine, advance }) => {
    await ingest(engine, ['我们去了「雾港咖啡店」，那天的拿铁特别香。']);
    ageTo(engine, advance, 0.34);
    engine.random = sequence([0, 0, 0.3]);
    const xml = engine.renderContext({ session_id: 's1' });
    const distortion = engine.activeDistortions.get('s1');
    check(distortion?.type === 'tip-of-tongue', 'tip-of-the-tongue operator triggered', distortion?.type);
    check(xml.includes('<masked_memory>'), 'masked memory tag injected');
    check(xml.includes('[███(名字卡在嘴边死活想不起来，只记得大概特征)]'), 'exact masking placeholder used');
    check(xml.includes('雾港咖啡店'), 'shadow truth retains the original proper noun');
    check(engine.looksLikeCorrection('是雾港咖啡店', distortion), 'reminding the masked name is a correction');
  });
}

async function sourceAndDreamConfusion() {
  console.log('\n# source/dream confusion');
  await withEngine('source', async ({ engine, advance }) => {
    await ingest(engine, ['你说过喜欢傍晚在河边散步。']);
    ageTo(engine, advance, 0.4);

    // Dream engine side, before the context recall refreshes t_last: a real
    // daily fragment can leak into the afterglow.
    engine.random = sequence([0, 0]);
    const afterglow = engine.condenseDream('我梦见一条发光的河。', [], engine.getScratchpad().mood);
    check(afterglow.includes('醒来时还恍惚'), 'dream afterglow can blur a real daily fragment', afterglow);

    engine.random = sequence([0, 0, 0.6, 0, 0.9]);
    const xml = engine.renderContext({ session_id: 's1' });
    const distortion = engine.activeDistortions.get('s1');
    check(distortion?.type === 'source-confusion', 'source-confusion operator triggered', distortion?.type);
    check(xml.includes('<confused_memory>'), 'confused memory tag injected');
    check(
      xml.includes('好像是你说的') || xml.includes('梦里'),
      'speaker or dream attribution is blurred',
    );
  });
}

async function schemaOverwrite() {
  console.log('\n# schema overwrite');
  await withEngine('schema', async ({ engine, store, advance }) => {
    await ingest(engine, ['那次周末我们去了河边，但其实是去参加朋友的生日，没有散步。']);
    const episode = store.listEpisodes()[0];
    const pattern = '周末去河边散步';
    store.insertSchema({
      id: 'schema_overwrite_test',
      created_at: engine.now() - 30 * 86400000,
      last_triggered: engine.now() - 7 * 86400000,
      occurrence_count: 5,
      stability_score: 0.85,
      pattern_summary: pattern,
      source_text: '',
      source_type: 'user_stated',
      vector: episode.vector,
      keywords: episode.keywords,
      exception_anchors: [],
      status: 'active',
      avg_interval_hours: 168,
    });
    check(Boolean(episode), 'daily exception memory exists');
    ageTo(engine, advance, 0.4);
    engine.random = sequence([0, 0, 0.9]);
    const xml = engine.renderContext({ session_id: 's1' });
    const distortion = engine.activeDistortions.get('s1');
    check(distortion?.type === 'schema-overwrite', 'schema-overwrite operator triggered', distortion?.type);
    check(xml.includes('<overwritten_memory>'), 'overwritten memory tag injected');
    check(xml.includes(pattern), 'habit schema fills the missing detail');
    check(xml.includes('<habit_schema id="schema_overwrite_test">'), 'shadow truth records the habit schema');
  });
}

async function immunityGuard() {
  console.log('\n# immunity guard');
  await withEngine('immunity', async ({ engine, store, advance }) => {
    await ingest(engine, ['修复 Cordis 插件的 inject 依赖，升级到 0.1.9，测试配置和日志。']);
    ageTo(engine, advance, 0.4);
    await engine.ingestTurn({
      session_id: 's1',
      turn: 2,
      user_text: '今天下午和朋友去海边书店喝咖啡。',
      assistant_text: '听起来很舒服。',
    });
    engine.insertSkill('当处理插件依赖时，先补上 inject 声明再测试。', 0.9, 'test');
    engine.random = sequence([0, 0, 0]);
    const xml = engine.renderContext({ session_id: 's1' });
    check(!xml.includes('<distorted_or_chimera_memory'), 'no distortion for core task or clear recent memory');
    check(!engine.activeDistortions.has('s1'), 'no active distortion created');
    check(xml.includes('[本能经验]'), 'Layer 4 skill remains injected untouched');
    check(xml.includes('修复 Cordis 插件的 inject 依赖'), 'core task memory remains available in clear/normal form');
  });
}

async function probabilityAndMasking() {
  console.log('\n# probability gate and masking helper');
  await withEngine('probability-quiet', async ({ engine, advance }) => {
    await ingest(engine, ['今天下午和朋友去公园散步，看到一只橘猫。']);
    ageTo(engine, advance, 0.4);
    engine.random = () => 0.99;
    const quiet = engine.renderContext({ session_id: 's1' });
    check(!quiet.includes('<distorted_or_chimera_memory'), 'high random roll skips distortion');
  });

  await withEngine('probability-noisy', async ({ engine, advance }) => {
    await ingest(engine, ['今天下午和朋友去公园散步，看到一只橘猫。']);
    ageTo(engine, advance, 0.4);
    engine.random = () => 0;
    const noisy = engine.renderContext({ session_id: 's1' });
    check(noisy.includes('<distorted_or_chimera_memory'), 'trigger roll injects a distortion');
    const masked = engine.maskProperNouns('我们去了「海边书店」。');
    check(masked?.text?.includes('[███'), 'mask helper replaces a quoted proper noun');
  });

  const defaults = normalizeConfig({});
  check(defaults.fallibilityEnabled === true, 'fallibility is enabled by default');
  check(defaults.fallibilityChanceMin === 0.15, 'distortion chance floor is 15%');
  check(defaults.fallibilityChanceMax === 0.25, 'distortion chance ceiling is 25%');
}

async function main() {
  await chimeraAndCorrection();
  await tipOfTongue();
  await sourceAndDreamConfusion();
  await schemaOverwrite();
  await immunityGuard();
  await probabilityAndMasking();
  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failed assertion(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('FALLIBILITY SMOKE ERROR', error?.stack || error);
  process.exitCode = 1;
});
