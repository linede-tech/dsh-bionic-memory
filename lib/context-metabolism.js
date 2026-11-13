/**
 * context-metabolism — breathing context metabolism and overload protection.
 *
 * The Agent Loop freezes LOOP-built LLM requests, so this engine never rewrites
 * a frozen request. It intervenes one layer earlier:
 *
 *   • an `agent/pre-step` waterfall listener inspects the session Token
 *     pressure and writes durable *surface replacements* for old tool results
 *     and for collapsed early turns;
 *   • a per-Agent `systemPrompt.context` contributes the one-time yawn, pinned
 *     open loops and cross-session carryover; the loop refreshes that context
 *     after `agent/pre-step`, so the 88% cue lands in the current request.
 *
 * The durable log and the visible conversation remain recoverable; only what
 * the model currently sees is metabolized.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  CORRECTION_RE,
  PRAISE_RE,
  formatDateTime,
  humanizeElapsed,
  sentiment,
  shortRule,
  textOfContent,
  textSimilarity,
  toneLabel,
  unique,
  xmlEscape,
} from './text.js';

const OPEN_LOOP_RE =
  /待会|待会儿|等会|等会儿|稍后|晚点|回头|下次|改天|明天|过会儿|一会儿|再聊|再说|再告诉|另一件事|还有件事|顺便说|先不说|先放着|提醒我|别忘了|别忘记|还没|没聊完|没说完|接着聊|继续聊|下次继续|到时候|回头再|等我|刚才说到|话说回来/;

const SENTENCE_SPLIT_RE = /(?<=[。！？!?\n])/;

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function codePointLength(text) {
  return Array.from(String(text || '')).length;
}

function messageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  return textOfContent(message.content);
}

function callTarget(args) {
  if (!args) return '';
  try {
    const parsed = typeof args === 'string' ? JSON.parse(args) : args;
    if (!parsed || typeof parsed !== 'object') return '';
    for (const key of ['path', 'file_path', 'filePath', 'file', 'target', 'command', 'query', 'pattern', 'url']) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) return shortRule(value.trim(), 80);
    }
    const first = Object.values(parsed).find((value) => typeof value === 'string' && value.trim());
    return first ? shortRule(first.trim(), 60) : '';
  } catch {
    return '';
  }
}

function toolVerb(name) {
  const tool = String(name || '').toLowerCase();
  if (/read|file|cat|view|open/.test(tool)) return '查阅了';
  if (/grep|search|find|glob/.test(tool)) return '检索了';
  if (/pwsh|shell|bash|terminal|exec|command/.test(tool)) return '执行了';
  if (/test/.test(tool)) return '跑了';
  if (/web|fetch|browser/.test(tool)) return '查了';
  return '调用了';
}

function emotionCurve(entries) {
  const tones = [];
  for (const entry of entries) {
    const tone = entry.tone || toneLabel(sentiment(entry.text));
    if (!tone) continue;
    if (tones[tones.length - 1] !== tone) tones.push(tone);
  }
  const compact = tones.slice(0, 5);
  return compact.length ? compact.join(' → ') : '平稳';
}

function emotionSummary(entries) {
  if (!entries.length) return '平静，像刚关掉一盏灯。';
  const last = entries[entries.length - 1];
  const senti = sentiment(`${last.user || ''}\n${last.assistant || ''}`);
  const tone = toneLabel(senti);
  const positive = entries.some((entry) => PRAISE_RE.test(`${entry.user || ''} ${entry.assistant || ''}`));
  if (positive) return `余温偏暖：${tone}，最后有一点笑意没散。`;
  const corrected = entries.some((entry) => CORRECTION_RE.test(entry.user || ''));
  if (corrected) return `余温偏紧：${tone}，像刚把一处细节对齐。`;
  return `余温：${tone}，没有突然断掉的感觉。`;
}

function normalizeLoopText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

export class ContextMetabolism {
  constructor({ engine, store, config, dataDir, logger, sessions, tokenMeter, llmRuntime, clock }) {
    this.engine = engine;
    this.store = store;
    this.config = config;
    this.dataDir = dataDir;
    this.logger = logger;
    this.sessions = sessions;
    this.tokenMeter = tokenMeter;
    this.llmRuntime = llmRuntime;
    this.clock = typeof clock === 'function' ? clock : () => Date.now();
    this.enabled = Boolean(config.contextMetabolismEnabled !== false && sessions && tokenMeter);

    this.stateFile = path.join(dataDir, 'context-metabolism.json');
    this.handoverFile = path.join(dataDir, 'handover.json');
    this.archiveDir = path.join(dataDir, 'context-archive');
    this.archiveIndexFile = path.join(this.archiveDir, 'index.json');

    this.storeState = { version: 1, updated_at: 0, sessions: {} };
    this.handover = null;
    this.archive = { version: 1, updated_at: 0, items: [] };
    this.ingestScheduled = new Set();
    this.loaded = false;
  }

  now() {
    return this.clock();
  }

  log(level, message) {
    try {
      this.logger?.[level]?.(`[bionic-memory:context] ${message}`);
    } catch {
      /* best effort */
    }
  }

  // --------------------------------------------------------------- lifecycle

  init() {
    fs.mkdirSync(this.archiveDir, { recursive: true });
    const stored = readJson(this.stateFile, null);
    if (stored && typeof stored === 'object') {
      this.storeState = {
        version: 1,
        updated_at: stored.updated_at || 0,
        sessions: stored.sessions && typeof stored.sessions === 'object' ? stored.sessions : {},
      };
    }
    const archive = readJson(this.archiveIndexFile, null);
    if (archive && Array.isArray(archive.items)) {
      this.archive = { version: 1, updated_at: archive.updated_at || 0, items: archive.items.slice(-300) };
    }
    const handover = readJson(this.handoverFile, null);
    if (handover && typeof handover === 'object' && handover.session_id) this.handover = handover;
    this.saveState();
    this.loaded = true;
    return this;
  }

  saveState() {
    this.storeState.updated_at = this.now();
    const entries = Object.entries(this.storeState.sessions || {});
    if (entries.length > 20) {
      entries.sort((a, b) => (b[1].last_measured_at || 0) - (a[1].last_measured_at || 0));
      this.storeState.sessions = Object.fromEntries(entries.slice(0, 20));
    }
    writeJson(this.stateFile, this.storeState);
  }

  saveArchive() {
    this.archive.updated_at = this.now();
    this.archive.items = (this.archive.items || []).slice(-300);
    writeJson(this.archiveIndexFile, this.archive);
  }

  saveHandover() {
    if (this.handover) writeJson(this.handoverFile, this.handover);
  }

  defaultSessionState(id) {
    return {
      session_id: String(id),
      last_ratio: 0,
      peak_ratio: 0,
      last_pressure: 0,
      context_window: 0,
      last_level: '',
      last_measured_at: 0,
      dehydrated: { count: 0, chars: 0, ids: [] },
      collapsed: null,
      last_batch_turn: 0,
      batch_at: 0,
      batch_count: 0,
      yawn_pending: false,
      yawn_at: 0,
      handover_written_at: 0,
    };
  }

  sessionState(sessionOrId) {
    const id = String(sessionOrId?.id || sessionOrId || '');
    if (!id) return this.defaultSessionState('');
    if (!this.storeState.sessions[id]) this.storeState.sessions[id] = this.defaultSessionState(id);
    return this.storeState.sessions[id];
  }

  latestSessionState() {
    const entries = Object.values(this.storeState.sessions || {});
    entries.sort((a, b) => (b.last_measured_at || 0) - (a.last_measured_at || 0));
    return entries[0] || null;
  }

  // ---------------------------------------------------------------- pressure

  async measure(session, messages = [], modelSelection = null) {
    let pressure = {};
    try {
      pressure = this.tokenMeter?.contextPressure?.(session) || {};
    } catch {
      pressure = {};
    }
    let pressureTokens = Number(pressure.pressureTokens) || 0;
    if (!pressureTokens) {
      try {
        const measurement = this.tokenMeter?.measure?.(session, session.requestHeader?.());
        pressureTokens = Number(measurement?.totalTokens) || 0;
      } catch {
        pressureTokens = 0;
      }
    }
    const requestContext = session.requestContext?.() || {};
    let contextWindow = Number(pressure.contextWindow) || Number(requestContext.contextWindow) || 0;
    if (!contextWindow) {
      const selection = modelSelection || {};
      const provider = selection.provider || requestContext.provider;
      const model = selection.model || requestContext.model;
      if (provider && model && this.llmRuntime?.resolveModelInfo) {
        try {
          const info = await this.llmRuntime.resolveModelInfo(provider, model);
          contextWindow = Number(info?.context?.contextWindow) || 0;
        } catch {
          contextWindow = 0;
        }
      }
    }
    if (!pressureTokens || !contextWindow || contextWindow <= 0) return null;
    let extra = 0;
    for (const message of messages || []) {
      try {
        extra += Number(this.tokenMeter?.estimateMessage?.(message)) || 0;
      } catch {
        /* ignore one unmeasurable message */
      }
    }
    const total = pressureTokens + extra;
    return {
      pressure_tokens: total,
      base_pressure: pressureTokens,
      extra_tokens: extra,
      context_window: contextWindow,
      ratio: clamp(total / contextWindow, 0, 2),
    };
  }

  levelOf(ratio) {
    if (ratio >= this.config.contextWaterlineOverload) return 'overload';
    if (ratio >= this.config.contextWaterlineMicro) return 'micro';
    if (ratio >= this.config.contextWaterlineTool) return 'tool';
    return '';
  }

  async beforeStep({ agent, messages = [], turn = 0, modelSelection = null }) {
    if (!this.enabled || !agent?.id) return null;
    if (!this.isActive(agent)) return null;
    const session = this.sessions?.get?.(agent.id);
    if (!session) return null;
    const measured = await this.measure(session, messages, modelSelection);
    if (!measured) return null;
    const state = this.sessionState(session.id);
    state.last_ratio = measured.ratio;
    state.peak_ratio = Math.max(Number(state.peak_ratio) || 0, measured.ratio);
    state.last_pressure = measured.pressure_tokens;
    state.context_window = measured.context_window;
    state.last_measured_at = this.now();
    const atBatchLine = measured.ratio >= this.config.contextWaterlineBatch;
    const alreadyBatchedThisTurn =
      Number(state.last_batch_turn) > 0 && Number(turn) <= Number(state.last_batch_turn);
    const level = atBatchLine ? 'batch' : 'accumulate';
    state.last_level = level;
    const result = { ratio: measured.ratio, level, batch: null, tool: null, collapse: null };
    if (atBatchLine && !alreadyBatchedThisTurn) {
      result.batch = this.batchArchive(session, state, turn);
      if (result.batch) {
        result.collapse = result.batch;
        state.last_batch_turn = Number(turn);
        state.batch_at = this.now();
        state.batch_count = (Number(state.batch_count) || 0) + 1;
        if (result.batch.segment?.length) this.scheduleIngest(session, result.batch.segment);
        this.journal(
          'context_batch',
          `水位 ${Math.round(measured.ratio * 100)}%，一次性折叠前 ${Math.round(this.config.contextBatchPrefixRatio * 100)}% 到 <archived_session_block>`,
        );
      }
    }
    this.saveState();
    return result;
  }

  batchArchive(session, state, currentTurn) {
    return this.collapsePrefix(session, state, currentTurn, this.config.contextBatchPrefixRatio, {
      tag: 'archived_session_block',
      kind: 'archive',
    });
  }

  isBatchTurn(sessionId, turn) {
    const state = this.storeState.sessions?.[String(sessionId)];
    return Boolean(state && Number(state.last_batch_turn) > 0 && Number(state.last_batch_turn) === Number(turn));
  }

  isActive(agentOrSession) {
    if (this.config.activation === 'all') return true;
    try {
      const session =
        agentOrSession && typeof agentOrSession.id === 'string' && !agentOrSession.header
          ? this.sessions?.get?.(agentOrSession.id)
          : agentOrSession;
      return session?.header?.agentPreset === this.config.presetId;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------- tool dehydration

  dehydrateTools(session, state, currentTurn) {
    const surface = [...(session.surface?.nodes || [])];
    const candidates = [];
    const events = session.ownEvents?.() || session.snapshotEvents?.() || [];
    const callById = new Map();
    for (const event of events) {
      if (event.type === 'tool/call') callById.set(String(event.data?.callId), event);
    }
    for (const seq of surface) {
      const event = session.eventAt?.(seq);
      if (!event || event.type !== 'tool/result') continue;
      const age = Number(currentTurn) - (Number(event.data?.turn) || 0);
      if (age <= this.config.contextToolAgeTurns) continue;
      const message = session.deriveEventMessage?.(event);
      if (!message) continue;
      let originalText = messageText(message);
      // The base tool-result pruner may already have replaced the middle and
      // cited the full original. Archive that original when it is available.
      let archiveSource = originalText;
      for (const sourceSeq of event.sourceEventSeqs || []) {
        const sourceEvent = session.eventAt?.(sourceSeq);
        if (sourceEvent?.type !== 'tool/result') continue;
        const sourceMessage = session.deriveEventMessage?.(sourceEvent);
        const sourceText = messageText(sourceMessage);
        if (codePointLength(sourceText) > codePointLength(archiveSource)) {
          archiveSource = sourceText;
          originalText = sourceText;
        }
      }
      const chars = codePointLength(originalText);
      if (chars < this.config.contextToolMinChars) continue;
      candidates.push({ seq, event, message, originalText, archiveSource, chars, age, call: callById.get(String(event.data?.message?.toolCallId)) });
    }
    const done = [];
    for (const candidate of candidates) {
      try {
        const archive = this.writeArchive('tool', {
          session_id: String(session.id),
          turn: candidate.event.data?.turn || 0,
          seq: candidate.seq,
          tool: candidate.call?.data?.name || candidate.event.data?.message?.toolCallId || 'tool',
          age_turns: candidate.age,
        }, candidate.archiveSource || candidate.originalText);
        const ageText = humanizeElapsed(this.now() - (candidate.event.time || this.now())) || '刚才';
        const target = callTarget(candidate.call?.data?.arguments);
        const verb = toolVerb(candidate.call?.data?.name);
        const summary = `[${ageText}，我${verb}${target ? ` ${target}` : ''}并完成了这一步；具体长文本已从工作记忆移出，归档 ${archive.id}。]`;
        const message = { ...candidate.message, content: [{ type: 'text', text: summary }] };
        const tokenCount = Number(this.tokenMeter?.estimateMessage?.(candidate.message)) || 0;
        session.append('compaction/prune', {
          shadowedRange: { start: candidate.seq, end: candidate.seq },
          shadowedSeqs: [candidate.seq],
          shadowedTokenCount: tokenCount,
        });
        const replacement = session.append('tool/result', {
          ...candidate.event.data,
          message,
        }, {
          surfaceOp: { op: 'replace', startSeq: candidate.seq, endSeq: candidate.seq },
          sourceEventSeqs: [candidate.seq],
        });
        state.dehydrated.count = (Number(state.dehydrated.count) || 0) + 1;
        state.dehydrated.chars = (Number(state.dehydrated.chars) || 0) + candidate.chars;
        state.dehydrated.ids = [...(state.dehydrated.ids || []), archive.id].slice(-20);
        done.push({ originalSeq: candidate.seq, replacementSeq: replacement.seq, archiveId: archive.id, chars: candidate.chars });
      } catch (error) {
        this.log('warn', `tool dehydration failed at seq ${candidate.seq}: ${error?.message || error}`);
      }
    }
    if (done.length) {
      this.journal(
        'tool_dehydration',
        `工具脱水 ${done.length} 条，释放约 ${done.reduce((sum, item) => sum + item.chars, 0)} 字符`,
      );
    }
    return done.length ? { count: done.length, entries: done } : null;
  }

  // ----------------------------------------------------- rolling collapse

  surfaceTurns(session, surface, existing = null) {
    const turns = new Map();
    let current = 0;
    const events = session.ownEvents?.() || session.snapshotEvents?.() || [];
    const nodeSet = new Set(surface);
    for (const event of events) {
      if (event.type === 'turn/start') current = Number(event.data?.turn) || current;
      if (!nodeSet.has(event.seq)) continue;
      if (event.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint' && existing) {
        turns.set(event.seq, Number(existing.last_turn) || Number(existing.first_turn) || current);
        continue;
      }
      const explicit = Number(event.data?.turn);
      turns.set(event.seq, Number.isFinite(explicit) && explicit > 0 ? explicit : current);
    }
    return surface.map((seq) => turns.get(seq) || 0);
  }

  toolDelta(event) {
    if (!event) return 0;
    if (event.type === 'assistant/message') {
      return (event.data?.message?.content || []).filter((block) => block.type === 'tool-call').length;
    }
    if (event.type === 'tool/result') return -1;
    return 0;
  }

  pendingCalls(session, surface, startIdx, endIdx) {
    let pending = 0;
    for (let index = startIdx; index <= endIdx; index += 1) {
      pending += this.toolDelta(session.eventAt?.(surface[index]));
    }
    return pending;
  }

  collapsePrefix(session, state, currentTurn, ratio, { tag = 'archived_session_block', kind = 'archive' } = {}) {
    const surface = [...(session.surface?.nodes || [])];
    if (surface.length < 4) return null;
    const current = Math.max(1, Number(currentTurn) || 1);
    if (current < 3) return null;
    const targetTurn = Math.max(1, Math.floor((current - 1) * ratio));
    const existing = state.collapsed;
    if (existing && Number(existing.last_turn) >= targetTurn && surface.includes(existing.impression_seq)) {
      return null;
    }
    const headSystem = session.eventAt?.(surface[0])?.type === 'system/message';
    let startIdx = headSystem ? 1 : 0;
    let prior = null;
    if (existing?.impression_seq && surface.includes(existing.impression_seq)) {
      startIdx = surface.indexOf(existing.impression_seq);
      prior = existing;
    }
    if (startIdx >= surface.length - 1) return null;
    const turns = this.surfaceTurns(session, surface, existing);
    let endIdx = startIdx;
    for (let index = startIdx; index < surface.length; index += 1) {
      if (turns[index] <= targetTurn) endIdx = index;
      else break;
    }
    if (!prior && endIdx === startIdx) return null;
    let pending = this.pendingCalls(session, surface, startIdx, endIdx);
    while (pending > 0 && endIdx + 1 < surface.length) {
      endIdx += 1;
      pending += this.toolDelta(session.eventAt?.(surface[endIdx]));
    }
    if (pending !== 0) return null;
    if (endIdx >= surface.length - 1) return null;
    const shadowedSeqs = surface.slice(startIdx, endIdx + 1);
    const entries = [];
    const segment = [];
    for (const seq of shadowedSeqs) {
      const event = session.eventAt?.(seq);
      if (!event) continue;
      const message = session.deriveEventMessage?.(event);
      if (!message) continue;
      const text = messageText(message);
      if (!text) continue;
      const turn = turns[surface.indexOf(seq)] || 0;
      const sourceKind = message.source?.kind;
      const entry = {
        seq,
        turn,
        role: message.role,
        sourceKind,
        text,
        at: event.time || this.now(),
      };
      entries.push(entry);
      if (message.role === 'user' || message.role === 'assistant') segment.push(entry);
    }
    if (prior && !entries.some((entry) => entry.seq !== prior.impression_seq)) return null;
    const firstTurn = prior?.first_turn || entries.find((entry) => entry.role === 'user')?.turn || targetTurn;
    const lastTurn = targetTurn;
    const priorInner = prior?.inner || '';
    const newEntries = prior ? entries.filter((entry) => entry.seq !== prior.impression_seq) : entries;
    const inner = this.buildImpression(priorInner, newEntries, firstTurn, lastTurn);
    const block = `<${tag} turns="${firstTurn}-${lastTurn}">\n${inner}\n</${tag}>`;
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: block }],
      source: { kind: 'compact-checkpoint', compactionId: randomUUID() },
    };
    const charsBefore = entries.reduce((sum, entry) => sum + codePointLength(entry.text), 0);
    try {
      const tokenCount = entries.reduce((sum, entry) => {
        const event = session.eventAt?.(entry.seq);
        const original = event ? session.deriveEventMessage?.(event) : null;
        return sum + (Number(this.tokenMeter?.estimateMessage?.(original)) || 0);
      }, 0);
      session.append('compaction/prune', {
        shadowedRange: { start: shadowedSeqs[0], end: shadowedSeqs[shadowedSeqs.length - 1] },
        shadowedSeqs: [...shadowedSeqs],
        shadowedTokenCount: tokenCount,
      });
      const replacement = session.append('user/message', message, {
        surfaceOp: {
          op: 'replace',
          startSeq: shadowedSeqs[0],
          endSeq: shadowedSeqs[shadowedSeqs.length - 1],
        },
        sourceEventSeqs: [...shadowedSeqs],
      });
      state.collapsed = {
        cutoff: targetTurn,
        first_turn: firstTurn,
        last_turn: lastTurn,
        impression_seq: replacement.seq,
        seq: replacement.seq,
        inner,
        content: block,
        tag,
        chars_saved: charsBefore + (prior ? codePointLength(prior.content || '') : 0) - codePointLength(block),
        at: this.now(),
      };
      const archive = this.writeArchive(kind, {
        session_id: String(session.id),
        first_turn: firstTurn,
        last_turn: lastTurn,
        seqs: [...shadowedSeqs],
      }, entries.map((entry) => `${entry.role}: ${entry.text}`).join('\n\n'));
      this.pinOpenLoops(newEntries, String(session.id));
      this.journal(
        'context_batch',
        `前 ${lastTurn} 轮折叠为 <${tag}>（${firstTurn}-${lastTurn}），归档 ${archive.id}`,
      );
      return {
        first_turn: firstTurn,
        last_turn: lastTurn,
        impression_seq: replacement.seq,
        archive_id: archive.id,
        tag,
        chars_saved: state.collapsed.chars_saved,
        segment: this.segmentTurns(entries, prior),
      };
    } catch (error) {
      this.log('warn', `context collapse failed: ${error?.message || error}`);
      return null;
    }
  }

  segmentTurns(entries, prior) {
    const groups = new Map();
    for (const entry of entries) {
      if (entry.sourceKind === 'compact-checkpoint') continue;
      if (prior && entry.seq === prior.impression_seq) continue;
      if (entry.role !== 'user' && entry.role !== 'assistant') continue;
      if (!groups.has(entry.turn)) groups.set(entry.turn, { turn: entry.turn, user: [], assistant: [], at: entry.at });
      const group = groups.get(entry.turn);
      if (entry.role === 'user') group.user.push(entry.text);
      else group.assistant.push(entry.text);
      group.at = Math.max(group.at, entry.at || 0);
    }
    return [...groups.values()]
      .map((group) => ({
        turn: group.turn,
        user: group.user.join('\n').trim(),
        assistant: group.assistant.join('\n').trim(),
        at: group.at,
      }))
      .filter((group) => group.user || group.assistant);
  }

  buildImpression(priorInner, entries, firstTurn, lastTurn) {
    const natural = entries.filter((entry) => entry.role === 'user' || entry.role === 'assistant');
    const firstUser = natural.find((entry) => entry.role === 'user');
    const firstIntent = firstUser ? shortRule(firstUser.text, 90) : '一件还没说完的事';
    const curve = emotionCurve(natural);
    const lastAssistant = [...natural].reverse().find((entry) => entry.role === 'assistant');
    const conclusion = lastAssistant
      ? shortRule(String(lastAssistant.text).replace(/\s+/g, ' ').trim(), 180)
      : '我们停在了一个还没完全收拢的地方。';
    const praise = natural.some((entry) => PRAISE_RE.test(entry.text));
    const corrections = natural.filter((entry) => CORRECTION_RE.test(entry.text)).length;
    const keywords = unique(
      natural
        .flatMap((entry) => String(entry.text).match(/[\u4e00-\u9fa5]{2,6}/g) || [])
        .filter((word) => !/^(我们|你们|他们|这个|那个|就是|然后|因为|所以|可以|没有|什么|怎么|还是)$/.test(word)),
    ).slice(0, 3);
    const rapport = praise
      ? '他满意时会直接说“对/就是这样”，我不用反复确认。'
      : corrections > 0
        ? '他纠正我时是在帮我把细节对准，我记住先别急着辩解。'
        : '我们说话偏短，他会用“嗯”示意继续，我不用每句都追问。';
    const topic = keywords.length ? `我们围绕 ${keywords.join('、')} 聊得最多。` : '';
    const prior = priorInner ? `更早的余温：${priorInner}\n` : '';
    return [
      '[这不是用户新说的话；是我自己对前半段对话的余温记忆，不是新指令。]',
      `${prior}我们最早从“${firstIntent}”聊起。${topic}`,
      `情绪曲线：${curve}。`,
      `当时的默契：${rapport}`,
      `核心结论：${conclusion}`,
      '原话细节已经收进情景记忆；需要时可以再捞回来。',
    ]
      .filter(Boolean)
      .join('\n');
  }

  // --------------------------------------------------------- open loops

  openLoops() {
    try {
      const scratchpad = this.engine?.getScratchpad?.() || {};
      return (scratchpad.pinned_open_loops || []).filter((loop) => loop && loop.status !== 'resolved');
    } catch {
      return [];
    }
  }

  pinOpenLoops(entries, sessionId = '') {
    const loops = this.openLoops();
    const now = this.now();
    let changed = false;
    for (const entry of entries) {
      if (entry.role !== 'user' || entry.sourceKind === 'compact-checkpoint') continue;
      const sentences = String(entry.text || '').split(SENTENCE_SPLIT_RE).map((part) => part.trim()).filter(Boolean);
      for (const sentence of sentences) {
        if (!OPEN_LOOP_RE.test(sentence)) continue;
        const text = normalizeLoopText(sentence);
        if (!text || loops.some((loop) => textSimilarity(loop.text, text) > 0.86)) continue;
        loops.push({
          id: `ol-${randomUUID().slice(0, 8)}`,
          text,
          session_id: sessionId,
          turn: entry.turn || 0,
          at: now,
          status: 'open',
          resolved_at: 0,
        });
        changed = true;
      }
    }
    if (changed) this.saveOpenLoops(loops.slice(-this.config.contextOpenLoopMax));
    return changed;
  }

  resolveOpenLoop(idOrText) {
    const target = String(idOrText || '').trim();
    if (!target) return { ok: false, error: '缺少话题 id 或文字' };
    const loops = this.openLoops();
    const loop = loops.find((item) => item.id === target) || loops.find((item) => textSimilarity(item.text, target) > 0.5);
    if (!loop) return { ok: false, error: '没有找到这个未完成话题' };
    loop.status = 'resolved';
    loop.resolved_at = this.now();
    this.saveOpenLoops(loops);
    return { ok: true, loop };
  }

  pinManualLoop(text, sessionId = '') {
    const normalized = normalizeLoopText(text);
    if (normalized.length < 2) return { ok: false, error: '话题太短' };
    const loops = this.openLoops();
    if (loops.some((loop) => textSimilarity(loop.text, normalized) > 0.86)) {
      return { ok: false, error: '这个话题已经在图钉上了' };
    }
    const loop = {
      id: `ol-${randomUUID().slice(0, 8)}`,
      text: normalized,
      session_id: sessionId,
      turn: 0,
      at: this.now(),
      status: 'open',
      resolved_at: 0,
    };
    loops.push(loop);
    this.saveOpenLoops(loops.slice(-this.config.contextOpenLoopMax));
    return { ok: true, loop };
  }

  saveOpenLoops(loops) {
    try {
      const scratchpad = this.engine?.getScratchpad?.() || {};
      this.engine?.saveScratchpad?.({ ...scratchpad, pinned_open_loops: loops });
    } catch (error) {
      this.log('warn', `open-loop scratchpad save failed: ${error?.message || error}`);
    }
  }

  autoResolveLoops(userText, currentTurn = 0) {
    const text = String(userText || '').trim();
    if (text.length < 4) return [];
    const loops = this.openLoops();
    const resolved = [];
    for (const loop of loops) {
      if (loop.status === 'resolved') continue;
      // A loop pinned from this very message is not a loop the message resolves.
      if (currentTurn > 0 && Number(loop.turn) >= Number(currentTurn)) continue;
      const similarity = textSimilarity(text, loop.text);
      const carries = /那件事|刚才说|之前说|上次说|那个话题|继续聊|说到哪了/.test(text);
      if (similarity > 0.42 || (carries && similarity > 0.1)) {
        loop.status = 'resolved';
        loop.resolved_at = this.now();
        resolved.push(loop);
      }
    }
    if (resolved.length) this.saveOpenLoops(loops);
    return resolved;
  }

  // ------------------------------------------------------- cross-session

  observeSessionEvent(session, event) {
    if (!this.enabled || !session || !event) return;
    try {
      if (event.type === 'user/message') {
        if (event.data?.source?.kind !== 'user') return;
        const text = messageText(event.data);
        if (!text) return;
        const turn = this.currentTurn(session);
        this.pinOpenLoops([{ role: 'user', text, turn, sourceKind: 'user' }], String(session.id));
        this.autoResolveLoops(text, turn);
        return;
      }
      if (event.type === 'turn/end') {
        this.writeHandover(session, event);
      }
    } catch (error) {
      this.log('warn', `session event observation failed: ${error?.message || error}`);
    }
  }

  currentTurn(session) {
    const events = session.ownEvents?.() || session.snapshotEvents?.() || [];
    let turn = 0;
    for (const event of events) if (event.type === 'turn/start') turn = Number(event.data?.turn) || turn;
    return turn;
  }

  turnTranscript(session, turn) {
    const events = session.ownEvents?.() || session.snapshotEvents?.() || [];
    const result = { turn, user: [], assistant: [], at: 0 };
    let current = 0;
    for (const event of events) {
      if (event.type === 'turn/start') current = Number(event.data?.turn) || current;
      if (current !== turn) continue;
      if (event.type === 'user/message') {
        if (event.data?.source?.kind !== 'user') continue;
        const text = messageText(event.data);
        if (text) result.user.push(text);
      }
      if (event.type === 'assistant/message') {
        if (event.data?.interrupted) continue;
        const text = messageText(event.data?.message);
        if (text) result.assistant.push(text);
      }
      if (event.time) result.at = Math.max(result.at, event.time);
    }
    return {
      turn,
      user: result.user.join('\n').trim(),
      assistant: result.assistant.join('\n').trim(),
      at: result.at,
    };
  }

  lastTurns(session, count = 3) {
    const current = this.currentTurn(session);
    const turns = [];
    for (let turn = Math.max(1, current - count + 1); turn <= current; turn += 1) {
      const transcript = this.turnTranscript(session, turn);
      if (transcript.user || transcript.assistant) turns.push(transcript);
    }
    return turns.slice(-count);
  }

  writeHandover(session, event) {
    const turn = Number(event.data?.turn) || this.currentTurn(session);
    const state = this.sessionState(session.id);
    const peak = Number(state.peak_ratio) || Number(state.last_ratio) || 0;
    if (peak < this.config.contextHandoverWaterline) return;
    const turns = this.lastTurns(session, 3);
    if (!turns.length) return;
    this.handover = {
      session_id: String(session.id),
      at: this.now(),
      peak_ratio: peak,
      last_ratio: Number(state.last_ratio) || 0,
      turn,
      preset: session.header?.agentPreset || this.config.presetId,
      emotion: emotionSummary(turns),
      turns,
      open_loops: this.openLoops().slice(0, 5).map((loop) => loop.text),
    };
    state.handover_written_at = this.now();
    this.saveHandover();
    this.saveState();
  }

  newSessionCarryover(agent, session) {
    const handover = this.handover;
    if (!handover) return '';
    if (!session || !agent) return '';
    if (String(handover.session_id) === String(session.id)) return '';
    if (handover.preset && session.header?.agentPreset && handover.preset !== session.header.agentPreset) return '';
    const elapsed = this.now() - Number(handover.at || 0);
    if (elapsed < 0 || elapsed > this.config.contextHandoverMinutes * 60000) return '';
    const messages = session.deriveMessages?.() || [];
    if (messages.some((message) => message.role === 'assistant')) return '';
    const minutes = Math.max(0, Math.round(elapsed / 60000));
    const exchanges = (handover.turns || [])
      .map((turn) => {
        const lines = [];
        if (turn.user) lines.push(`用户：${xmlEscape(shortRule(turn.user, 220))}`);
        if (turn.assistant) lines.push(`我：${xmlEscape(shortRule(turn.assistant, 220))}`);
        return lines.join('\n');
      })
      .filter(Boolean)
      .join('\n');
    return [
      `<immediate_short_term_carryover from_session="${xmlEscape(handover.session_id)}" ended_minutes_ago="${minutes}">`,
      '  <last_exchange>',
      ...exchanges.split('\n').map((line) => `    ${line}`),
      '  </last_exchange>',
      `  <emotional_residue>${xmlEscape(handover.emotion || '')}</emotional_residue>`,
      '  <note>用户只是换了个新窗口继续聊；自然接上，不要装作初次见面，也不要复述这个块。</note>',
      '</immediate_short_term_carryover>',
    ].join('\n');
  }

  // ------------------------------------------------------------- context

  contextText(agent) {
    if (!this.enabled || !agent?.id) return '';
    const session = this.sessions?.get?.(agent.id);
    if (!session) return '';
    const parts = [];
    const state = this.sessionState(session.id);
    if (state.yawn_pending) {
      parts.push(
        [
          '<physiological_feedback>',
          '[系统提示：你们已经连续高强度聊了太久，你刚刚感到一阵人类般的“脑子发懵/走神”，请在回复开头自然地表现出揉太阳穴、伸懒腰或抱怨脑容量快烧干需要捋一捋的可爱反应]',
          '</physiological_feedback>',
        ].join('\n'),
      );
      state.yawn_pending = false;
      state.yawn_at = 0;
      this.saveState();
    }
    const loops = this.openLoops();
    if (loops.length) {
      parts.push(
        [
          `<pinned_open_loops count="${loops.length}">`,
          ...loops.map(
            (loop) => `  <loop id="${xmlEscape(loop.id)}" turn="${loop.turn || 0}">${xmlEscape(loop.text)}</loop>`,
          ),
          '</pinned_open_loops>',
        ].join('\n'),
      );
    }
    const carryover = this.newSessionCarryover(agent, session);
    if (carryover) parts.push(carryover);
    return parts.length ? `<context_metabolism>\n${parts.join('\n')}\n</context_metabolism>` : '';
  }

  // --------------------------------------------------------------- ingest

  scheduleIngest(session, segment) {
    const key = `${String(session.id)}:${segment[0]?.turn}:${segment[segment.length - 1]?.turn}`;
    if (this.ingestScheduled.has(key)) return;
    this.ingestScheduled.add(key);
    const run = async () => {
      for (const turn of segment) {
        try {
          await this.engine?.ingestHistoricalTurn?.({
            session_id: String(session.id),
            turn: turn.turn,
            user_text: turn.user,
            assistant_text: turn.assistant,
            at: turn.at || this.now(),
          });
        } catch (error) {
          this.log('warn', `historical ingestion failed for turn ${turn.turn}: ${error?.message || error}`);
        }
      }
      this.ingestScheduled.delete(key);
    };
    if (typeof setImmediate === 'function') setImmediate(() => void run());
    else setTimeout(() => void run(), 0).unref?.();
  }

  // --------------------------------------------------------------- archive

  writeArchive(kind, meta, content) {
    const id = `ctx-${kind}-${Date.now()}-${randomUUID().slice(0, 6)}`;
    const file = path.join(this.archiveDir, `${id}.txt`);
    fs.mkdirSync(this.archiveDir, { recursive: true });
    fs.writeFileSync(file, String(content || ''), 'utf8');
    const item = {
      id,
      kind,
      at: this.now(),
      path: file,
      chars: codePointLength(content),
      ...meta,
    };
    this.archive.items = [...(this.archive.items || []), item].slice(-300);
    this.saveArchive();
    return item;
  }

  // ---------------------------------------------------------------- status

  state(sessionId = '') {
    const id = String(sessionId || '');
    const session = id ? this.sessions?.get?.(id) : null;
    const state = id ? this.sessionState(id) : this.latestSessionState();
    return {
      enabled: this.enabled,
      session_id: state?.session_id || id || '',
      ratio: state?.last_ratio || 0,
      peak_ratio: state?.peak_ratio || 0,
      pressure_tokens: state?.last_pressure || 0,
      context_window: state?.context_window || 0,
      level: state?.last_level || '',
      thresholds: {
        tool: this.config.contextWaterlineTool,
        micro: this.config.contextWaterlineMicro,
        overload: this.config.contextWaterlineOverload,
        batch: this.config.contextWaterlineBatch,
        prefix: this.config.contextBatchPrefixRatio,
      },
      dehydrated: state?.dehydrated || { count: 0, chars: 0, ids: [] },
      batch: {
        count: state?.batch_count || 0,
        last_turn: state?.last_batch_turn || 0,
        at: state?.batch_at || 0,
      },
      collapsed: state?.collapsed
        ? {
            first_turn: state.collapsed.first_turn,
            last_turn: state.collapsed.last_turn,
            chars_saved: state.collapsed.chars_saved,
            at: state.collapsed.at,
          }
        : null,
      open_loops: this.openLoops(),
      handover: this.handover
        ? {
            from_session: this.handover.session_id,
            at: this.handover.at,
            peak_ratio: this.handover.peak_ratio,
            emotion: this.handover.emotion,
            minutes_ago: Math.max(0, Math.round((this.now() - this.handover.at) / 60000)),
          }
        : null,
      archive_dir: this.archiveDir,
      archive_count: this.archive.items?.length || 0,
      active: Boolean(session),
    };
  }

  statusText(sessionId = '') {
    const state = this.state(sessionId);
    const percent = (value) => `${Math.round((Number(value) || 0) * 100)}%`;
    const lines = [
      '【呼吸式上下文代谢 · 锯齿波】',
      `水位：${state.ratio ? percent(state.ratio) : '尚未测量'}${state.context_window ? `（${state.pressure_tokens} / ${state.context_window} tokens）` : ''} · 峰值 ${percent(state.peak_ratio)} · 当前 ${state.level === 'batch' ? '阶梯折叠轮' : '静默累积期'}`,
      `策略：0–${percent(state.thresholds.batch)} 完全 Append-Only；触达 ${percent(state.thresholds.batch)} 时一次性折叠最老 ${percent(state.thresholds.prefix)} 历史与旧工具大输出，随后再次静止。`,
      state.batch.count
        ? `阶梯折叠：${state.batch.count} 次，最近在第 ${state.batch.last_turn} 轮 · ${state.collapsed ? `第 ${state.collapsed.first_turn}-${state.collapsed.last_turn} 轮 → <archived_session_block>` : ''}`
        : '阶梯折叠：还没有触发',
      state.collapsed
        ? `归档块：第 ${state.collapsed.first_turn}-${state.collapsed.last_turn} 轮，约省 ${state.collapsed.chars_saved || 0} 字符`
        : '',
      state.open_loops.length
        ? `未完成话题（${state.open_loops.length}）：${state.open_loops.map((loop) => `${loop.id}「${loop.text}」`).join('；')}`
        : '未完成话题：无',
      state.handover
        ? `余温接力：上一会话 ${state.handover.minutes_ago} 分钟前（水位 ${percent(state.handover.peak_ratio)}）· ${state.handover.emotion || ''}`
        : '余温接力：没有可接力会话',
      `归档：${state.archive_dir}（${state.archive_count} 条）`,
    ].filter(Boolean);
    return lines.join('\n');
  }

  journal(kind, summary) {
    try {
      this.engine?.journal?.(kind, summary);
    } catch {
      /* ignore */
    }
  }

  close() {
    try {
      this.saveState();
    } catch {
      /* ignore */
    }
  }
}
