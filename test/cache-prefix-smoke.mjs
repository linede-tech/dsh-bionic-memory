/**
 * Smoke test for the four-tier prefix architecture and cache telemetry:
 * static Tier 0 rules, daily Tier 1 frozen block, append-only history,
 * ephemeral tail, tier hashes, cache hit/saved telemetry, batch exemption,
 * and the 3-round low-hit meta alert.
 *
 * Usage: node test/cache-prefix-smoke.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeConfig } from '../lib/config.js';
import { BionicMemoryEngine } from '../lib/engine.js';
import { openStore } from '../lib/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, '.cache-prefix-data');
const BASE_PROMPT = fs.readFileSync(path.join(ROOT, 'prompt-template.md'), 'utf8');

let failures = 0;
function check(condition, message, extra) {
  if (condition) console.log(`ok - ${message}`);
  else {
    failures += 1;
    console.error(`FAIL - ${message}${extra === undefined ? '' : ` :: ${JSON.stringify(extra)}`}`);
  }
}

function userMessage(text, id = `u-${Math.random().toString(36).slice(2)}`) {
  return { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] };
}

function assistantMessage(text, id = `a-${Math.random().toString(36).slice(2)}`) {
  return {
    id,
    role: 'assistant',
    source: { kind: 'model', provider: 'fake', model: 'fake' },
    content: [{ type: 'text', text }],
  };
}

class FakeSession {
  constructor(id = 's1', clock = () => Date.now()) {
    this.id = id;
    this.clock = clock;
    this.header = { agentPreset: 'bionic-memory', createdAt: clock() };
    this.events = [];
    this.nodes = [];
    this.nextSeq = 0;
    this.replaceGeneration = 0;
  }

  get surface() {
    return { nodes: [...this.nodes], replaceGeneration: this.replaceGeneration, contentGeneration: this.replaceGeneration };
  }

  append(type, data, opts = {}) {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    const event = {
      type,
      seq,
      time: this.clock(),
      data,
      ...(opts.surfaceOp ? { surfaceOp: opts.surfaceOp } : {}),
      ...(opts.sourceEventSeqs ? { sourceEventSeqs: opts.sourceEventSeqs } : {}),
    };
    this.events.push(event);
    if (['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'].includes(type)) {
      const op = opts.surfaceOp;
      if (op && typeof op === 'object' && op.op === 'replace') {
        const startIdx = this.nodes.indexOf(op.startSeq);
        const endIdx = this.nodes.indexOf(op.endSeq);
        if (startIdx < 0 || endIdx < startIdx) throw new Error('bad replacement');
        this.nodes.splice(startIdx, endIdx - startIdx + 1, seq);
        this.replaceGeneration += 1;
      } else {
        this.nodes.push(seq);
      }
    }
    return event;
  }

  eventAt(seq) {
    return this.events.find((event) => event.seq === seq);
  }

  ownEvents() {
    return [...this.events];
  }

  snapshotEvents() {
    return [...this.events];
  }

  deriveEventMessage(event) {
    if (!event) return null;
    if (event.type === 'user/message') return event.data;
    if (['system/message', 'developer/message', 'assistant/message', 'tool/result'].includes(event.type)) {
      return event.data?.message || null;
    }
    return null;
  }

  deriveMessages() {
    return this.nodes.map((seq) => this.deriveEventMessage(this.eventAt(seq))).filter(Boolean);
  }

  requestContext() {
    return { provider: 'fake', model: 'fake', contextWindow: 100000 };
  }

  requestHeader() {
    return { config: { provider: 'fake', model: 'fake' } };
  }
}

function addTurn(session, turn, userText, assistantText) {
  session.append('turn/start', { turn });
  session.append('user/message', userMessage(userText));
  session.append('assistant/message', { turn, step: 1, message: assistantMessage(assistantText) });
  session.append('turn/end', { turn, reason: { kind: 'completed' } });
}

async function main() {
  fs.rmSync(DATA, { recursive: true, force: true });
  let now = Date.UTC(2026, 10, 13, 9, 0, 0);
  const clock = () => now;
  let ratio = 0.2;
  const tokenMeter = {
    contextPressure: () => ({ pressureTokens: Math.round(ratio * 100000), contextWindow: 100000 }),
    measure: () => ({ totalTokens: Math.round(ratio * 100000) }),
    estimateMessage: () => 0,
  };
  const session = new FakeSession('s1', clock);
  const sessions = new Map([['s1', session]]);
  for (let turn = 1; turn <= 20; turn += 1) {
    addTurn(session, turn, `第 ${turn} 轮：聊一件具体的事。`, `第 ${turn} 轮回复：我记得。`);
  }
  const store = await openStore({ dir: DATA });
  const config = normalizeConfig({
    activation: 'preset',
    presetId: 'bionic-memory',
    fallibilityEnabled: false,
    metaEvolutionEnabled: true,
    contextMetabolismEnabled: true,
    contextWaterlineBatch: 0.82,
    contextBatchPrefixRatio: 0.45,
  });
  const engine = new BionicMemoryEngine({
    store,
    config,
    clock,
    dataDir: DATA,
    sessions: { get: (id) => sessions.get(String(id)) || null },
    tokenMeter,
    packageDir: ROOT,
    basePrompt: BASE_PROMPT,
    pluginReload: async () => ({ ok: true }),
  });
  engine.init();
  await engine.ingestTurn({
    session_id: 's1',
    turn: 1,
    user_text: '我们聊过一件很具体的事。',
    assistant_text: '我记得，那是一件具体的事。',
  });

  // Tier 1 daily frozen block: deterministic, persisted, byte-identical.
  const dailyOne = engine.dailyFrozenBlock();
  check(dailyOne.includes('<daily_frozen_memory>'), 'daily frozen block compiled');
  check(!dailyOne.includes('2026-11-13'), 'daily frozen block has no daily timestamp inside it');
  check(engine.dailyFrozenBlock() === dailyOne, 'daily frozen block is byte-identical across reads');
  const dailyFile = path.join(DATA, 'daily-frozen-memory.json');
  check(fs.existsSync(dailyFile), 'daily frozen block persisted');
  engine.insertSkill('先复述用户需求，再给结论', 0.82);
  engine.compileDailyFrozenMemory({ reason: 'test' });
  const dailyTwo = engine.dailyFrozenBlock();
  check(dailyTwo.includes('先复述用户需求'), 'daily frozen block includes active procedural skill');
  check(engine.dailyFrozenBlock() === dailyTwo, 'recompiled daily block is stable');
  check(engine.dailyFrozenBlock() !== dailyOne, 'recompile changes the Tier 1 prefix once');
  const tiers = engine.tierHashes();
  check(/^[0-9a-f]{64}$/.test(tiers.tier0), 'Tier 0 hash available');
  check(/^[0-9a-f]{64}$/.test(tiers.tier1), 'Tier 1 hash available');
  check(tiers.tier1 === engine.tierHashes().tier1, 'Tier 1 hash is stable between reads');

  // Tier 0/1 sections must be static; the daily items are not repeated in Tier 3.
  const ephemeral = engine.renderEphemeral({ session_id: 's1', query: '第 20 轮' });
  check(ephemeral.includes('<ephemeral_subconscious_flashback>'), 'ephemeral tail block rendered');
  check(ephemeral.includes('当前时间'), 'ephemeral block contains dynamic time');
  check(ephemeral.includes('<recalled_memories>'), 'ephemeral block contains recalled memories');
  check(!ephemeral.includes('<daily_frozen_memory>'), 'daily frozen block is not duplicated in the tail');
  check(!ephemeral.includes('先复述用户需求'), 'daily skill is not duplicated in the tail');
  const preview = engine.renderContext({ session_id: 's1', omitDaily: true });
  check(!preview.includes('<procedural_skills>'), 'ephemeral context omits procedural skills');
  check(!preview.includes('<habits_and_schemas>'), 'ephemeral context omits habits');

  // The sawtooth batch at 82% marks the turn for cache telemetry.
  ratio = 0.85;
  const batchResult = await engine.contextMetabolism.beforeStep({
    agent: { id: 's1' },
    messages: [],
    turn: 21,
    modelSelection: { provider: 'fake', model: 'fake' },
  });
  check(batchResult?.level === 'batch', 'engine context metabolism reaches batch level');
  check(engine.contextMetabolism.isBatchTurn('s1', 21) === true, 'engine marks the batch turn');

  // Cache telemetry: three low non-batch rounds trigger the meta alert.
  const lowUsage = { inputTokens: 1000, cacheReadTokens: 100 };
  const first = engine.observeUsage({ session_id: 's1', turn: 18, usage: lowUsage });
  const second = engine.observeUsage({ session_id: 's1', turn: 19, usage: lowUsage });
  const third = engine.observeUsage({ session_id: 's1', turn: 20, usage: lowUsage });
  check(first?.ratio === 0.1, 'cache hit ratio computed from cacheReadTokens', first?.ratio);
  check(second?.low_streak === 2, 'low-hit streak accumulates', second?.low_streak);
  check(Boolean(third?.alert), 'third low non-batch round triggers meta alert', third?.alert);
  const cache = engine.state().meta_evolution.cache;
  check(cache.low_streak === 3, 'cache state exposes low streak', cache.low_streak);
  check(Boolean(cache.alert), 'cache state exposes alert');
  check(engine.metaEvolver.statusText().includes('缓存告警'), 'meta status reports cache alert');
  check(engine.metaEvolver.contextLines().some((line) => line.includes('<cache_alert')), 'meta context includes cache alert');
  const telemetry = JSON.parse(fs.readFileSync(engine.metaEvolver.telemetryFile, 'utf8'));
  check(telemetry.cache.low_streak === 3, 'telemetry.json persists low streak');
  check(telemetry.cache.saved_tokens === 300, 'telemetry.json persists saved cache tokens', telemetry.cache.saved_tokens);
  check(telemetry.days[Object.keys(telemetry.days)[0]]?.cache_hits === 300, 'daily cache hits persisted');

  // Batch rounds are exempt from the low-hit alert streak.
  const beforeBatchLow = engine.metaEvolver.telemetry.cache.low_streak;
  engine.observeUsage({
    session_id: 's1',
    turn: 21,
    usage: { inputTokens: 1000, cacheReadTokens: 0 },
  });
  check(engine.metaEvolver.telemetry.cache.low_streak === beforeBatchLow, 'batch round does not extend low-hit streak');
  check(engine.metaEvolver.telemetry.cache.batch_rounds >= 1, 'batch rounds counted separately');

  // Tier 1 recompile followed by three low rounds changes the alert hint to Tier 1 pollution.
  engine.observeUsage({ session_id: 's1', turn: 22, usage: { inputTokens: 1000, cacheReadTokens: 900 } });
  engine.compileDailyFrozenMemory({ reason: 'test-tier' });
  engine.observeUsage({ session_id: 's1', turn: 23, usage: { inputTokens: 1000, cacheReadTokens: 0 } });
  engine.observeUsage({ session_id: 's1', turn: 24, usage: { inputTokens: 1000, cacheReadTokens: 0 } });
  engine.observeUsage({ session_id: 's1', turn: 25, usage: { inputTokens: 1000, cacheReadTokens: 0 } });
  const alert = engine.metaEvolver.evolution.cache_alert;
  check(Boolean(alert?.active), 'tier change after three low rounds keeps alert active');
  check(String(alert?.hint || '').includes('Tier 1'), 'alert investigates Tier 1 pollution', alert?.hint);

  // A healthy round resolves the alert.
  const healthy = engine.observeUsage({ session_id: 's1', turn: 26, usage: { inputTokens: 1000, cacheReadTokens: 900 } });
  check(healthy?.alert === null, 'healthy round clears the active alert');
  check(engine.metaEvolver.evolution.cache_alert?.active === false, 'alert marked resolved');

  // The daily block and the cache are visible in engine state.
  const state = engine.state('s1');
  check(Boolean(state.daily_frozen?.day), 'engine state exposes daily frozen day');
  check(Boolean(state.daily_frozen?.tier_hashes?.tier1), 'engine state exposes Tier 1 hash');
  check(Boolean(state.meta_evolution?.cache), 'engine state exposes cache monitor');

  engine.close();
  fs.rmSync(DATA, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failed assertion(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('CACHE PREFIX SMOKE ERROR', error?.stack || error);
  process.exitCode = 1;
});
