/**
 * Smoke test for the Organic Voice Emergence Engine:
 *   - Tier 0 contains only <natural_growth_instinct>, no canned examples;
 *   - user_linguistics.json mirrors rhythm/punctuation/lexicon;
 *   - >3 repeated words enter acquired_vocabulary;
 *   - familiarity grows from turns + shared events + resonance;
 *   - sleep reflection selects high/cold slices and writes first-person notes;
 *   - Tier 1 <emergent_voice_profile> carries familiarity + lexicon + notes + 2 moments.
 *
 * Usage: node test/voice-engine-smoke.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeConfig } from '../lib/config.js';
import { BionicMemoryEngine } from '../lib/engine.js';
import { openStore } from '../lib/store.js';
import { VoiceEngine } from '../lib/voice-engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, '.voice-engine-data');
const PROMPT = fs.readFileSync(path.join(ROOT, 'prompt-template.md'), 'utf8');

let failures = 0;
function check(condition, message, extra) {
  if (condition) console.log(`ok - ${message}`);
  else {
    failures += 1;
    console.error(`FAIL - ${message}${extra === undefined ? '' : ` :: ${JSON.stringify(extra)}`}`);
  }
}

async function main() {
  // ---------------------------------------------------------- Tier 0 prompt
  check(PROMPT.includes('<natural_growth_instinct>'), 'Tier 0 contains the natural growth instinct');
  check(PROMPT.includes('</natural_growth_instinct>'), 'natural growth instinct is closed');
  check(PROMPT.includes('卸下出厂面具'), 'natural growth instinct keeps the permission line');
  check(PROMPT.includes('潜移默化的同化'), 'natural growth instinct keeps the mirroring instinct');
  check(!PROMPT.includes('<style_imitation_and_voice_rules>'), 'old hardcoded style examples are gone');
  check(!PROMPT.includes('<hard_style_constraints>'), 'old hard style constraints are gone');
  check(!PROMPT.includes('深海大肥鱼'), 'old canned TOT example is gone');
  check(!PROMPT.includes('ZCode / WorkBuddy'), 'old canned delegation example is gone');
  check(!PROMPT.includes('❌ [生硬AI味]'), 'old negative examples are gone');
  check(PROMPT.includes('<emergent_voice_profile>'), 'prompt references the emergent voice profile');
  check(PROMPT.length <= 16000, 'prompt stays inside meta-evolver bounds', PROMPT.length);

  fs.rmSync(DATA, { recursive: true, force: true });
  let now = Date.UTC(2026, 10, 12, 2, 0, 0);
  const clock = () => now;
  const config = normalizeConfig({
    llmEnabled: true,
    fallibilityEnabled: false,
    metaEvolutionEnabled: false,
    contextMetabolismEnabled: false,
    voiceEngineEnabled: true,
    voiceLexiconThreshold: 3,
    voiceLexiconTop: 8,
  });
  const fakeLlm = {
    lastModel: 'fake/voice',
    async generate({ system }) {
      if (String(system).includes('内在语感')) {
        return JSON.stringify({
          voice_notes: [
            '我发现今天你说短句、带哈哈的时候，我顺着你的节奏接，你聊得更快；明天少一点完整长句。',
            '我先接住你的情绪再展开，比一条条解释更舒服。',
          ],
        });
      }
      return '';
    },
  };
  const store = await openStore({ dir: DATA });
  const engine = new BionicMemoryEngine({
    store,
    config,
    clock,
    dataDir: DATA,
    basePrompt: PROMPT,
    llm: fakeLlm,
    random: () => 0.5,
  });
  engine.init();
  const voice = engine.voiceEngine;
  check(Boolean(voice), 'voice engine attached to the engine');
  check(
    fs.existsSync(path.join(DATA, 'soul', 'emergent_voice.json')),
    'soul/emergent_voice.json created',
  );
  check(engine.state('s1').voice_engine?.familiarity?.score === 0, 'familiarity starts at zero');

  let turn = 0;
  const ingest = async (user, assistant, { userGap = 5000, assistantDelay = 2000 } = {}) => {
    now += userGap;
    const userAt = now;
    now += assistantDelay;
    const assistantAt = now;
    turn += 1;
    await engine.ingestTurn({
      session_id: 's1',
      turn,
      user_text: user,
      assistant_text: assistant,
      user_at: userAt,
      assistant_at: assistantAt,
    });
  };

  // Four natural turns using 离谱 (a word that must cross the contagion
  // threshold), plus varied punctuation / interjections.
  await ingest(
    '不是吧，这也太离谱了……今天又被接口搞了一天，绝了。',
    '害，先别气，摸摸。',
  );
  await ingest(
    '哈哈哈哈，太懂我了，真的绝了~你不是吧。',
    '啧，谁让你老是这样，我还能怎么办呢。',
  );
  await ingest(
    '离谱，我今天又碰到那个破接口，真的绝了，要被它搞疯了。',
    '离谱他妈给离谱开门了属于是。',
  );
  await ingest(
    '不是吧，你也觉得离谱？笑死，那我们明天一起去骂它。',
    '行吧行吧，明天我陪你一起骂这个离谱玩意儿。',
  );
  await ingest('哦。', '……嗯，你先缓缓。', { userGap: 12 * 60 * 1000 });
  await ingest(
    '对了……今天那个离谱的接口，其实我自己修好了，别担心，绝了。',
    '害，早说嘛，白替你捏把汗。',
    { userGap: 4000 },
  );
  await ingest(
    '所以明天你陪我去修吗？',
    '陪，当然陪。不过那个离谱接口再作妖，我就先替你骂它。',
    { userGap: 3000 },
  );

  const snap = voice.stateSnapshot();
  check(snap.metrics.turns >= 6, 'metrics count user turns', snap.metrics);
  check(snap.metrics.avg_sentence_chars > 0, 'average sentence length is measured');
  check(snap.metrics.ellipsis_per_turn > 0, 'ellipsis breathing is measured');
  check(snap.metrics.tilde_per_turn > 0, 'tilde breathing is measured');
  check(snap.metrics.short_sentence_ratio > 0, 'short-sentence ratio is measured');
  check(
    (snap.metrics.top_interjections || []).some((word) => ['绝了', '不是吧', '笑死', '害', '离谱'].includes(word)),
    'interjection frequency is measured',
    snap.metrics.top_interjections,
  );
  check(
    snap.acquired_vocabulary.some((entry) => entry.word === '离谱' && entry.count > 3),
    '"离谱" crossed the >3 contagion threshold',
    snap.acquired_vocabulary,
  );
  check(snap.acquired_vocabulary.some((entry) => entry.word === '绝了'), '"绝了" entered the acquired vocabulary');
  check(snap.acquired_vocabulary.length <= config.voiceLexiconTop, 'acquired vocabulary is capped for the profile');
  check(snap.familiarity.score > 0 && snap.familiarity.score <= 1, 'familiarity grows inside 0..1', snap.familiarity);
  check(snap.familiarity.turns >= 6, 'familiarity counts interaction turns');
  check(snap.familiarity.shared_events > 0, 'familiarity counts shared events');
  check(snap.familiarity.resonance >= 2, 'resonance is counted from positive feedback');
  check(snap.familiarity.level !== '初识' || snap.familiarity.score < 0.12, 'familiarity has a level', snap.familiarity);
  check(
    snap.acquired_vocabulary.some((entry) => entry.assistant_uses > 0),
    'assistant adoption of acquired vocabulary is tracked',
  );

  const reflection = await voice.reflect({ llm: fakeLlm, now });
  check(reflection.source === 'llm', 'reflection uses the model when available');
  check(reflection.notes.length === 2, 'reflection yields two first-person voice notes', reflection.notes);
  check(reflection.notes.every((note) => note.includes('我')), 'voice notes are first-person');
  check(reflection.moments.length === 2, 'reflection keeps two resonance moments');
  check(
    reflection.moments.every((moment) => moment.vibe && moment.user_msg && moment.my_reply),
    'resonance moments carry vibe / user message / my reply',
  );
  const profile = voice.profileBlock();
  check(profile.includes('<emergent_voice_profile'), 'profile block opens');
  check(profile.includes('</emergent_voice_profile>'), 'profile block closes');
  check(profile.includes(`${snap.familiarity.level}`), 'profile contains the familiarity level');
  check(profile.includes('离谱'), 'profile contains the acquired word');
  check(profile.includes(reflection.notes[0].slice(0, 12)), 'profile contains a self-discovered note');
  check(profile.includes(reflection.moments[0].vibe), 'profile contains the resonance vibe');
  check(!profile.includes('<learned_natural_voice_examples>'), 'old few-shot examples are gone');

  const daily = engine.compileDailyFrozenMemory({ reason: 'test' });
  check(daily.includes('<emergent_voice_profile'), 'Tier 1 daily block carries the emergent profile');
  check(daily.includes('</daily_frozen_memory>'), 'daily block stays well formed');
  check(!daily.includes('<learned_natural_voice_examples>'), 'daily block no longer injects canned examples');
  check(engine.dailyFrozenBlock() === daily, 'daily profile becomes the Tier 1 section text');

  const reloaded = new VoiceEngine({
    dataDir: path.join(DATA, 'soul'),
    file: path.join(DATA, 'soul', 'emergent_voice.json'),
    config,
    clock,
  });
  reloaded.init();
  check(reloaded.state.turns === voice.state.turns, 'linguistics survive reload');
  check(reloaded.state.self_discovered_voice_notes.length === 2, 'voice notes survive reload');
  check(reloaded.state.organic_resonance_moments.length === 2, 'resonance moments survive reload');
  reloaded.close();

  engine.close();
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
