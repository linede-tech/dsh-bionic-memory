/**
 * Smoke test for the sawtooth context metabolism:
 * append-only accumulation, one 82% batch fold, archives, open loops,
 * cross-session carryover and manual resolution.
 *
 * Usage: node test/context-metabolism-smoke.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeConfig } from '../lib/config.js';
import { ContextMetabolism } from '../lib/context-metabolism.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, '.context-metabolism-data');

let failures = 0;
function check(condition, message, extra) {
  if (condition) console.log(`ok - ${message}`);
  else {
    failures += 1;
    console.error(`FAIL - ${message}${extra === undefined ? '' : ` :: ${JSON.stringify(extra)}`}`);
  }
}

const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);

function userMessage(text, id = `u-${Math.random().toString(36).slice(2)}`) {
  return { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] };
}

function assistantMessage(blocks, id = `a-${Math.random().toString(36).slice(2)}`) {
  return { id, role: 'assistant', source: { kind: 'model', provider: 'fake', model: 'fake' }, content: blocks };
}

function toolResultMessage(callId, text, id = `t-${Math.random().toString(36).slice(2)}`) {
  return { id, role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: [{ type: 'text', text }] };
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
    if (SURFACE_TYPES.has(type)) {
      const op = opts.surfaceOp;
      if (op && typeof op === 'object' && op.op === 'replace') {
        const startIdx = this.nodes.indexOf(op.startSeq);
        const endIdx = this.nodes.indexOf(op.endSeq);
        if (startIdx < 0 || endIdx < startIdx) throw new Error(`bad surface replacement ${op.startSeq}-${op.endSeq}`);
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

function addTurn(session, turn, userText, assistantText, tool = null) {
  session.append('turn/start', { turn });
  session.append('user/message', userMessage(userText));
  if (tool) {
    const callId = `call-${turn}`;
    session.append('assistant/message', {
      turn,
      step: 1,
      message: assistantMessage([{ type: 'tool-call', id: callId, name: tool.name, arguments: JSON.stringify(tool.args) }]),
    });
    session.append('tool/call', { turn, step: 1, callId, name: tool.name, arguments: JSON.stringify(tool.args) });
    session.append('tool/result', { turn, step: 1, message: toolResultMessage(callId, tool.output) });
  }
  session.append('assistant/message', {
    turn,
    step: 2,
    message: assistantMessage([{ type: 'text', text: assistantText }]),
  });
  session.append('turn/end', { turn, reason: { kind: 'completed' } });
}

function naturalTexts(session) {
  return session
    .deriveMessages()
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => `${message.role}:${message.content.map((block) => block.text || '').join('')}`);
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function main() {
  fs.rmSync(DATA, { recursive: true, force: true });

  let now = Date.UTC(2026, 10, 13, 5, 0, 0);
  const clock = () => now;
  const config = normalizeConfig({
    activation: 'preset',
    presetId: 'bionic-memory',
    fallibilityEnabled: false,
    metaEvolutionEnabled: false,
    contextMetabolismEnabled: true,
    contextWaterlineBatch: 0.82,
    contextBatchPrefixRatio: 0.45,
  });
  let pressureRatio = 0.5;
  const tokenMeter = {
    contextPressure: () => ({ pressureTokens: Math.round(pressureRatio * 100000), contextWindow: 100000 }),
    measure: () => ({ totalTokens: Math.round(pressureRatio * 100000) }),
    estimateMessage: () => 0,
  };
  const sessions = new Map();
  const memoryCalls = [];
  const scratchpad = {};
  const fakeEngine = {
    getScratchpad: () => scratchpad,
    saveScratchpad: (patch) => Object.assign(scratchpad, patch),
    ingestHistoricalTurn: async (input) => {
      memoryCalls.push(input);
      return { stored: true, episode_id: `ep-${input.turn}` };
    },
    journal: () => {},
  };
  const metabolism = new ContextMetabolism({
    engine: fakeEngine,
    config,
    dataDir: DATA,
    logger: null,
    sessions: { get: (id) => sessions.get(String(id)) || null },
    tokenMeter,
    llmRuntime: null,
    clock,
  });
  metabolism.init();

  const session = new FakeSession('s1', clock);
  sessions.set('s1', session);
  session.append('system/message', {
    turn: 0,
    step: 0,
    message: { id: 'sys', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'SYSTEM' }] },
  });
  const longToolOutput = `line ${'0123456789'.repeat(100)}\n`;
  for (let turn = 1; turn <= 20; turn += 1) {
    const userText =
      turn === 2 ? '对了，待会儿再跟你说另一件事。' : `第 ${turn} 轮：我们在聊一个很长的话题，先把这个细节记下来。`;
    const assistantText = `第 ${turn} 轮回复：我记住了这个细节；${turn === 2 ? '那件事先留着。' : '继续。'}`;
    addTurn(
      session,
      turn,
      userText,
      assistantText,
      turn === 1 ? { name: 'read_file', args: { path: 'src/large-file.ts' }, output: longToolOutput } : null,
    );
  }

  // 0–82%: completely append-only. No tool dehydration and no history edits.
  const naturalBefore = naturalTexts(session);
  const surfaceBefore = [...session.surface.nodes];
  for (const ratio of [0.55, 0.79]) {
    pressureRatio = ratio;
    const result = await metabolism.beforeStep({
      agent: { id: 's1' },
      messages: [],
      turn: 21,
      modelSelection: { provider: 'fake', model: 'fake' },
    });
    check(result?.level === 'accumulate', `${Math.round(ratio * 100)}% stays in silent accumulation`, result?.level);
    check(result?.batch === null, `${Math.round(ratio * 100)}% does not fold`);
  }
  check(JSON.stringify(naturalTexts(session)) === JSON.stringify(naturalBefore), 'natural-language turns untouched before 82%');
  check(JSON.stringify(session.surface.nodes) === JSON.stringify(surfaceBefore), 'surface untouched during accumulation');
  check(
    session.deriveMessages().some((message) => message.role === 'tool' && message.content[0].text.includes('0123456789')),
    'old tool output still verbatim before 82%',
  );

  // 82%: one batch fold of the oldest 45% (turns 1–9), then static again.
  pressureRatio = 0.85;
  const batchResult = await metabolism.beforeStep({
    agent: { id: 's1' },
    messages: [],
    turn: 21,
    modelSelection: { provider: 'fake', model: 'fake' },
  });
  check(batchResult?.level === 'batch', '82% yields batch level', batchResult?.level);
  check(Boolean(batchResult?.batch), 'batch fold happened', batchResult?.batch);
  check(batchResult?.batch?.tag === 'archived_session_block', 'batch uses archived_session_block');
  const archived = session.deriveMessages().find(
    (message) => message.role === 'user' && message.source?.kind === 'compact-checkpoint',
  );
  check(Boolean(archived), 'archived session block node inserted');
  check(archived.content[0].text.includes('<archived_session_block turns="1-9"'), 'archived block covers the oldest 45%', archived.content[0].text.slice(0, 80));
  check(archived.content[0].text.includes('情绪曲线'), 'archived block keeps emotion curve');
  check(archived.content[0].text.includes('核心结论'), 'archived block keeps conclusion');
  check(!session.deriveMessages().some((message) => message.role === 'tool'), 'old tool output folded out of the surface');
  check(
    !session
      .deriveMessages()
      .filter((message) => message.role === 'user' && message.source?.kind !== 'compact-checkpoint')
      .some((message) => message.content[0].text.includes('第 1 轮：我们')),
    'old user turns removed from the live surface',
  );
  check(naturalTexts(session).some((line) => line.includes('第 20 轮：我们')), 'recent turns remain untouched');
  await tick();
  check(memoryCalls.length > 0, 'batch turns ingested into Layer 2 in the background', memoryCalls.length);
  check(memoryCalls.every((call) => call.turn <= 9), 'only the batched prefix is backfilled', memoryCalls.map((call) => call.turn));
  const loops = metabolism.openLoops();
  check(loops.length >= 1, 'open loop pinned during the batch', loops);
  check(loops.some((loop) => loop.text.includes('另一件事')), 'the unresolved second topic is pinned');
  check(metabolism.state('s1').batch?.count === 1, 'batch counter incremented');
  check(metabolism.isBatchTurn('s1', 21) === true, 'batch round is marked for cache telemetry');

  const archive = JSON.parse(fs.readFileSync(metabolism.archiveIndexFile, 'utf8'));
  check(archive.items.some((item) => item.kind === 'archive'), 'batch archive indexed');
  const archivedItem = archive.items.find((item) => item.kind === 'archive');
  const archivedText = fs.readFileSync(archivedItem.path, 'utf8');
  check(archivedText.includes('0123456789'), 'full old tool output preserved in local archive');
  check(archivedText.includes('另一件事'), 'open loop source preserved in local archive');

  // Back below the line: static accumulation again, with no further surface edits.
  const surfaceAfterBatch = [...session.surface.nodes];
  pressureRatio = 0.6;
  const quiet = await metabolism.beforeStep({ agent: { id: 's1' }, messages: [], turn: 22, modelSelection: null });
  check(quiet?.level === 'accumulate', 'post-batch waterline returns to accumulation', quiet?.level);
  check(JSON.stringify(session.surface.nodes) === JSON.stringify(surfaceAfterBatch), 'surface unchanged after batch');

  // Same 45% target at a high reading: no duplicate batch for the same prefix.
  pressureRatio = 0.9;
  const repeat = await metabolism.beforeStep({ agent: { id: 's1' }, messages: [], turn: 23, modelSelection: null });
  check(repeat?.level === 'batch', 'high reading still labels batch level');
  check(repeat?.batch === null, 'same prefix is not folded twice');
  check(metabolism.state('s1').batch?.count === 1, 'batch counter still one');

  const contextText = metabolism.contextText({ id: 's1' });
  check(contextText.includes('<pinned_open_loops'), 'open loops injected into the ephemeral context');
  check(!contextText.includes('<physiological_feedback>'), 'old 88% yawn is no longer injected');

  // Cross-session carryover still works after a high-water session.
  metabolism.observeSessionEvent(session, { type: 'turn/end', data: { turn: 20 } });
  check(Boolean(metabolism.handover), 'high-water handover written at turn end');
  now += 2 * 60 * 1000;
  const fresh = new FakeSession('s2', clock);
  sessions.set('s2', fresh);
  const carryover = metabolism.contextText({ id: 's2' });
  check(carryover.includes('<immediate_short_term_carryover'), 'new blank session gets immediate carryover');
  check(carryover.includes('用户只是换了个新窗口继续聊'), 'carryover tells the model this is the same conversation');
  check(carryover.includes('第 20 轮'), 'carryover carries the last 3 turns', carryover.slice(0, 400));
  check(carryover.includes('余温'), 'carryover carries emotional residue');

  now += 6 * 60 * 1000;
  const stale = new FakeSession('s3', clock);
  sessions.set('s3', stale);
  check(!metabolism.contextText({ id: 's3' }).includes('<immediate_short_term_carryover'), 'carryover expires after five minutes');

  const loopId = metabolism.openLoops()[0]?.id;
  const resolved = metabolism.resolveOpenLoop(loopId);
  check(resolved.ok === true, 'open loop can be resolved manually', resolved);
  check(!metabolism.contextText({ id: 's1' }).includes('<pinned_open_loops'), 'resolved open loop disappears from context');

  const status = metabolism.statusText('s1');
  check(status.includes('锯齿波'), 'status text shaped as sawtooth');
  check(status.includes('阶梯折叠'), 'status reports batch folds');
  check(metabolism.state('s1').collapsed?.last_turn === 9, 'state reports the batched range');

  metabolism.close();
  fs.rmSync(DATA, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failed assertion(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('CONTEXT METABOLISM SMOKE ERROR', error?.stack || error);
  process.exitCode = 1;
});
