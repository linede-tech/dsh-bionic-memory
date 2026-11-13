/**
 * Organic Voice Emergence Engine.
 *
 * The model is not given canned persona examples. Instead this module:
 *   1. mirrors the user's own rhythm / punctuation / vocabulary into
 *      user_linguistics.json, and promotes repeatedly-used words into an
 *      acquired vocabulary after they cross the contagion threshold;
 *   2. maintains a 0..1 familiarity score from turns, shared events and
 *      emotional resonance;
 *   3. runs a sleep-time first-person voice reflection over the day's real
 *      high-resonance / cold slices and freezes the resulting intuition into
 *      Tier 1 as <emergent_voice_profile>.
 *
 * Everything is local to the memory directory and excluded from git.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  clamp,
  isoDate,
  round,
  startOfLocalDay,
  xmlEscape,
} from './text.js';

const VOICE_SYSTEM = `你是同一个人的内在语感，不是客服培训师，也不是写作老师。
你只根据今天真实发生的对话，用第一人称总结 1-2 条“怎么跟眼前这个人聊天最合拍”的直觉。
不要引用任何外部范例，不要写通用社交建议，不要分点写长篇报告。
只输出严格 JSON：{"voice_notes":["第一人称心得", "……"]}，不要 Markdown 代码块。`;

const POSITIVE_RE =
  /哈哈|hhh|233|笑死|笑不活|乐了|太懂我|就是这样|太对|绝了|好家伙|哎哟|牛啊|好棒|爱了|喜欢|满意|可以可以|有那味|太真实|狠狠共情|舒服|开心|绝绝子/gi;

const INTERJECTIONS = [
  '啊', '呀', '吧', '嘛', '哦', '噢', '哈', '呢', '呗', '哎', '唉', '啧',
  '靠', '卧槽', '绝了', '笑死', '不是吧', '好家伙', '害', '行吧', '算了',
  '离谱', '真的', '其实', '确实',
];

const LEXICON_STOP = new Set(
  `
  今天 昨天 明天 现在 时候 感觉 真的 其实 就是 不是 这个 那个 然后 所以
  还是 已经 可以 需要 应该 知道 觉得 可能 如果 但是 因为 没有 什么 怎么
  为什么 我们 你们 他们 自己 大家 东西 事情 有点 非常 比较 确实 大概 一直
  一点 一种 一个 这样 那样 一样 这么 那么 还有 而且 不过 只是 哈哈 哈哈哈
  哈哈哈哈 谢谢 好的 好滴 收到 行 嗯 哦 噢 没事 可以 不行 不会 不能 不用
  这么 那么 这里 那里 上面 下面 之前 之后 目前 开始 结束 工作 用户 助手
  the and for with that this from have will just your about into over under
  `.split(/\s+/).filter(Boolean),
);

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const CODE_FENCE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;

function normalize(text) {
  return String(text || '').replace(/\r\n/g, '\n').trim();
}

function stripCode(text) {
  return normalize(text)
    .replace(CODE_FENCE, ' ')
    .replace(INLINE_CODE, ' ')
    .replace(/^\s*\/.*$/gm, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitSentences(text) {
  return String(text || '')
    .split(/[。！？!?…~～;；\n]+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function countMatches(text, pattern) {
  return (String(text || '').match(pattern) || []).length;
}

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

function emptyState() {
  return {
    version: 1,
    updated_at: 0,
    turns: 0,
    sessions: [],
    metrics: {
      turns: 0,
      chars: 0,
      sentence_chars: 0,
      sentences: 0,
      short_sentences: 0,
      space_count: 0,
      ellipsis_count: 0,
      tilde_count: 0,
      exclamation_count: 0,
      question_count: 0,
      short_burst_turns: 0,
      interjections: {},
    },
    lexicon: {
      candidates: {},
      acquired_vocabulary: [],
    },
    familiarity: {
      score: 0,
      level: '初识',
      hint: '还带着自然的初见礼貌和试探，不必硬装熟。',
      turns: 0,
      shared_events: 0,
      resonance: 0,
      updated_at: 0,
    },
    self_discovered_voice_notes: [],
    organic_resonance_moments: [],
    cold_moments: [],
    last_reflection_at: 0,
    last_reflection_day: '',
    reflection_source: '',
    recent_turns: [],
  };
}

const LEVELS = [
  { max: 0.12, name: '初识', hint: '还带着自然的初见礼貌和试探，不必硬装熟。' },
  { max: 0.3, name: '熟悉', hint: '可以开始省掉一部分客套，偶尔换成更短的句子。' },
  { max: 0.5, name: '熟络', hint: '短句、省略主语和轻轻调侃开始自然，不用每句都完整。' },
  { max: 0.72, name: '默契', hint: '像老朋友：允许打断式接话、停顿、黑话和没头没尾的默契。' },
  { max: 1.01, name: '松弛', hint: '彻底卸下书面语防备，用最省力、最顺口的日常频道。' },
];

export class VoiceEngine {
  constructor({ dataDir, config = {}, logger = null, clock = () => Date.now() }) {
    this.dataDir = dataDir;
    this.config = config;
    this.logger = logger;
    this.clock = typeof clock === 'function' ? clock : () => Date.now();
    this.file = path.join(dataDir, 'user_linguistics.json');
    this.maxAcquired = Math.max(4, Number(config.voiceLexiconMax) || 24);
    this.lexiconThreshold = Math.max(1, Number(config.voiceLexiconThreshold) || 3);
    this.lexiconTop = Math.max(1, Number(config.voiceLexiconTop) || 8);
    this.recentMax = Math.max(20, Number(config.voiceRecentTurns) || 120);
    this.momentDays = Math.max(1, Number(config.voiceRecentHighDays) || 7);
    this.state = emptyState();
  }

  now() {
    return this.clock();
  }

  init() {
    const stored = readJson(this.file, null);
    if (stored && typeof stored === 'object') {
      this.state = { ...emptyState(), ...stored };
      this.state.metrics = { ...emptyState().metrics, ...(stored.metrics || {}) };
      this.state.lexicon = {
        candidates: stored.lexicon?.candidates && typeof stored.lexicon.candidates === 'object'
          ? stored.lexicon.candidates
          : {},
        acquired_vocabulary: Array.isArray(stored.lexicon?.acquired_vocabulary)
          ? stored.lexicon.acquired_vocabulary
          : [],
      };
      this.state.familiarity = { ...emptyState().familiarity, ...(stored.familiarity || {}) };
      this.state.self_discovered_voice_notes = Array.isArray(stored.self_discovered_voice_notes)
        ? stored.self_discovered_voice_notes.slice(0, 2)
        : [];
      this.state.organic_resonance_moments = Array.isArray(stored.organic_resonance_moments)
        ? stored.organic_resonance_moments.slice(0, 2)
        : [];
      this.state.cold_moments = Array.isArray(stored.cold_moments) ? stored.cold_moments.slice(0, 4) : [];
      this.state.recent_turns = Array.isArray(stored.recent_turns)
        ? stored.recent_turns.slice(-this.recentMax)
        : [];
    }
    this.save();
    return this;
  }

  save() {
    this.state.updated_at = this.now();
    this.state.lexicon.acquired_vocabulary = this.state.lexicon.acquired_vocabulary
      .slice()
      .sort((a, b) => b.count - a.count || b.last_at - a.last_at)
      .slice(0, this.maxAcquired);
    this.state.recent_turns = this.state.recent_turns.slice(-this.recentMax);
    writeJson(this.file, this.state);
  }

  close() {
    try {
      this.save();
    } catch {
      /* best effort */
    }
  }

  levelFor(score) {
    const value = clamp(Number(score) || 0, 0, 1);
    return LEVELS.find((level) => value < level.max) || LEVELS[LEVELS.length - 1];
  }

  updateMetrics(text) {
    const metrics = this.state.metrics;
    const chars = text.length;
    const sentences = splitSentences(text);
    metrics.turns += 1;
    metrics.chars += chars;
    metrics.sentences += sentences.length;
    metrics.sentence_chars += chars;
    for (const sentence of sentences) {
      if (sentence.length <= 10) metrics.short_sentences += 1;
    }
    metrics.space_count += countMatches(text, /[ \u3000]/g);
    metrics.ellipsis_count += countMatches(text, /…|\.{3,}/g);
    metrics.tilde_count += countMatches(text, /[~～]/g);
    metrics.exclamation_count += countMatches(text, /[!！]/g);
    metrics.question_count += countMatches(text, /[?？]/g);
    if (sentences.length >= 3 && sentences.every((sentence) => sentence.length <= 12)) {
      metrics.short_burst_turns += 1;
    }
    for (const word of INTERJECTIONS) {
      const hits = countMatches(text, new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'));
      if (hits) metrics.interjections[word] = (metrics.interjections[word] || 0) + hits;
    }
  }

  extractCandidates(text) {
    const counts = new Map();
    const add = (token) => {
      const word = String(token || '').toLowerCase().trim();
      if (word.length < 2 || word.length > 8) return;
      if (LEXICON_STOP.has(word)) return;
      if (!/^[\u3400-\u9fff]+$|^[a-z][a-z0-9_+-]+$/.test(word)) return;
      counts.set(word, (counts.get(word) || 0) + 1);
    };
    for (const match of String(text).toLowerCase().matchAll(/[a-z][a-z0-9_+-]{1,}/g)) add(match[0]);
    for (const run of String(text).match(CJK_RUN) || []) {
      const chars = Array.from(run);
      if (chars.length === 1) add(chars[0]);
      for (let size = 2; size <= 4; size += 1) {
        for (let index = 0; index <= chars.length - size; index += 1) {
          add(chars.slice(index, index + size).join(''));
        }
      }
    }
    return counts;
  }

  updateLexicon(text, now) {
    const counts = this.extractCandidates(text);
    const candidates = this.state.lexicon.candidates;
    const acquired = this.state.lexicon.acquired_vocabulary;
    for (const [word, increment] of counts) {
      const existing = candidates[word] || {
        count: 0,
        first_at: now,
        last_at: now,
        acquired_at: 0,
      };
      existing.count += increment;
      existing.last_at = now;
      candidates[word] = existing;
      if (existing.count > this.lexiconThreshold && !existing.acquired_at) {
        existing.acquired_at = now;
        acquired.push({
          word,
          count: existing.count,
          first_at: existing.first_at,
          last_at: now,
          acquired_at: now,
          assistant_uses: 0,
        });
      }
    }
    for (const entry of acquired) {
      if (candidates[entry.word]) entry.count = candidates[entry.word].count;
    }
    // Prune stale candidates so the file stays bounded, keeping acquired words.
    const ranked = Object.entries(candidates)
      .sort((a, b) => b[1].count - a[1].count || b[1].last_at - a[1].last_at)
      .slice(0, 240);
    this.state.lexicon.candidates = Object.fromEntries(ranked);
  }

  updateAssistantUsage(assistantText) {
    const text = normalize(assistantText);
    if (!text) return;
    for (const entry of this.state.lexicon.acquired_vocabulary) {
      if (text.includes(entry.word)) entry.assistant_uses = (entry.assistant_uses || 0) + 1;
    }
  }

  recomputeFamiliarity({ episodes = 0, dreams = 0, now = this.now() } = {}) {
    const turns = Math.max(Number(this.state.turns) || 0, Number(episodes) || 0);
    const sharedEvents = (Number(episodes) || 0) + (Number(dreams) || 0) * 2;
    const resonance = Number(this.state.familiarity.resonance) || 0;
    const raw =
      turns / Math.max(1, Number(this.config.voiceFamiliarityTurnScale) || 70)
      + sharedEvents / Math.max(1, Number(this.config.voiceFamiliarityEventScale) || 35)
      + resonance / Math.max(1, Number(this.config.voiceFamiliarityResonanceScale) || 10);
    const score = clamp(1 - Math.exp(-Math.max(0, raw)), 0, 1);
    const level = this.levelFor(score);
    this.state.familiarity = {
      ...this.state.familiarity,
      score: round(score, 3),
      level: level.name,
      hint: level.hint,
      turns,
      shared_events: sharedEvents,
      resonance,
      updated_at: now,
    };
  }

  vibeOf(entry, now = this.now()) {
    const hour = new Date(now).getHours();
    if (hour >= 23 || hour < 5) return '深夜';
    if (entry.positive) return '轻快';
    if (/[?？]/.test(entry.user_text || '')) return '认真';
    if (entry.user_len >= 120) return '走心';
    return '日常';
  }

  observeTurn({
    session_id = '',
    turn = 0,
    user_text = '',
    assistant_text = '',
    user_at = 0,
    assistant_at = 0,
    previousPair = null,
    episodes = 0,
    dreams = 0,
    now = this.now(),
  } = {}) {
    const clean = stripCode(user_text);
    const assistant = normalize(assistant_text);
    if (!clean) return null;
    const sessionKey = String(session_id || '');
    if (sessionKey && !this.state.sessions.includes(sessionKey)) this.state.sessions.push(sessionKey);
    this.state.turns = (Number(this.state.turns) || 0) + 1;
    this.updateMetrics(clean);
    this.updateLexicon(clean, now);
    this.updateAssistantUsage(assistant);
    const previousAssistantAt = Number(previousPair?.assistant_at) || 0;
    const userTimestamp = Number(user_at) || Number(now) || 0;
    const replyLatency = previousAssistantAt > 0 && userTimestamp > previousAssistantAt
      ? userTimestamp - previousAssistantAt
      : null;
    const positive = POSITIVE_RE.test(clean);
    POSITIVE_RE.lastIndex = 0;
    const assistantLen = assistant.length;
    const userLen = clean.length;
    const resonance =
      positive
      || (replyLatency !== null && replyLatency < 90 * 1000 && userLen >= 18)
      || userLen >= 140;
    if (resonance) this.state.familiarity.resonance = (Number(this.state.familiarity.resonance) || 0) + 1;
    const entry = {
      session_id: sessionKey,
      turn: Number(turn) || 0,
      at: now,
      user_at: userTimestamp,
      assistant_at: Number(assistant_at) || 0,
      reply_latency_ms: replyLatency,
      user_text: clean.slice(0, 600),
      assistant_text: assistant.slice(0, 600),
      user_len: userLen,
      assistant_len: assistantLen,
      positive,
      resonance,
      vibe: '',
    };
    entry.vibe = this.vibeOf(entry, now);
    this.state.recent_turns.push(entry);
    this.state.recent_turns = this.state.recent_turns.slice(-this.recentMax);
    this.recomputeFamiliarity({ episodes, dreams, now });
    this.save();
    return { resonance, familiarity: this.state.familiarity };
  }

  highScore(entry) {
    const latency = entry.reply_latency_ms;
    const speed = latency !== null && latency !== undefined
      ? clamp(1 - latency / 180000, 0, 1)
      : 0.25;
    const length = clamp((Number(entry.user_len) || 0) / 120, 0, 1);
    return round(
      (entry.positive ? 1 : 0) * 1.0
      + length * 0.8
      + speed * 0.6
      + (Number(entry.assistant_len) ? 0.1 : 0),
      3,
    );
  }

  coldScore(entry) {
    const latency = entry.reply_latency_ms;
    const slow = latency !== null && latency !== undefined ? clamp(latency / 600000, 0, 1) : 0;
    const short = (Number(entry.user_len) || 0) <= 8 ? 1 : (Number(entry.user_len) || 0) <= 20 ? 0.5 : 0;
    return round(
      slow
      + short * 1.2
      + ((Number(entry.user_len) || 0) < 4 ? 0.5 : 0)
      + (entry.positive ? 0 : 0.25),
      3,
    );
  }

  dayTurns(now = this.now()) {
    const dayStart = startOfLocalDay(now);
    return this.state.recent_turns.filter((entry) => entry.at >= dayStart);
  }

  recentHighs(now = this.now()) {
    const cutoff = now - this.momentDays * 86400000;
    return this.state.recent_turns
      .filter((entry) => entry.at >= cutoff)
      .slice()
      .sort((a, b) => this.highScore(b) - this.highScore(a))
      .slice(0, 2);
  }

  deriveNotes({ highs, colds }) {
    const notes = [];
    const high = highs[0];
    const cold = colds[0];
    if (high) {
      const rhythm = high.user_len <= 20 ? '短句' : high.user_len >= 80 ? '长一点的倾诉' : '中等长度的接话';
      notes.push(
        `我发现今天你说得${high.user_len <= 20 ? '又短又快' : '比较放松'}的时候，我顺着你的${rhythm}接，气氛最顺；明天可以多一点这种随口就来的接话。`,
      );
    }
    if (cold) {
      notes.push(
        `今天我${cold.assistant_len > 300 ? '一口气说得太长' : '接得太急着解释'}的时候，你回得很短；下次先接住你那一下，再慢慢展开。`,
      );
    }
    if (!notes.length) {
      notes.push('今天聊得还不多，我先记住你的句长和语气变化，明天再自然一点。');
    }
    return notes.slice(0, 2);
  }

  async reflect({ llm = null, now = this.now(), day = '' } = {}) {
    const dayTurns = this.dayTurns(now);
    if (!dayTurns.length) {
      return { notes: this.state.self_discovered_voice_notes, moments: this.state.organic_resonance_moments, source: 'empty' };
    }
    const highs = dayTurns
      .slice()
      .sort((a, b) => this.highScore(b) - this.highScore(a))
      .slice(0, 2);
    const colds = dayTurns
      .slice()
      .sort((a, b) => this.coldScore(b) - this.coldScore(a))
      .slice(0, 2);
    let notes = [];
    let source = 'deterministic';
    if (llm?.generate && this.config.llmEnabled !== false) {
      const material = [
        ...highs.map(
          (entry, index) =>
            `高共鸣 ${index + 1}（${entry.vibe}）：对方说“${entry.user_text.slice(0, 180)}”；我当时回“${entry.assistant_text.slice(0, 180)}”；对方回复间隔 ${entry.reply_latency_ms ?? '未知'}ms；对方字数 ${entry.user_len}。`,
        ),
        ...colds.map(
          (entry, index) =>
            `冷场 ${index + 1}：对方说“${entry.user_text.slice(0, 120)}”；我当时回“${entry.assistant_text.slice(0, 160)}”；对方字数 ${entry.user_len}；间隔 ${entry.reply_latency_ms ?? '未知'}ms。`,
        ),
      ].join('\n\n');
      const metrics = this.snapshotMetrics();
      const prompt = `今天和 TA 有 ${dayTurns.length} 轮真实对话。\n当前熟稔度 ${this.state.familiarity.score}（${this.state.familiarity.level}）。\n已耳濡目染的词：${this.state.lexicon.acquired_vocabulary.map((entry) => entry.word).slice(0, 8).join('、') || '暂无'}。\n用户平均句长约 ${metrics.avg_sentence_chars} 字，短句占比 ${Math.round(metrics.short_sentence_ratio * 100)}%，省略号/波浪号每轮 ${metrics.ellipsis_per_turn}/${metrics.tilde_per_turn}，语气词高频：${metrics.top_interjections.join('、') || '无'}。\n\n${material}\n\n请只根据这些真实片段，用第一人称总结 1-2 条“怎么跟眼前这个人聊天最合拍、最舒服”的直觉；不要写客套话。输出 JSON：{"voice_notes":["…"]}`;
      try {
        const text = await llm.generate({
          system: VOICE_SYSTEM,
          prompt,
          maxTokens: 420,
        });
        const start = String(text || '').indexOf('{');
        const end = String(text || '').lastIndexOf('}');
        if (start >= 0 && end > start) {
          const parsed = JSON.parse(String(text).slice(start, end + 1));
          const items = Array.isArray(parsed?.voice_notes) ? parsed.voice_notes : [];
          notes = items
            .map((item) => String(item || '').replace(/\s+/g, ' ').trim())
            .filter((item) => item.length >= 8 && item.length <= 160)
            .slice(0, 2);
          if (notes.length) source = 'llm';
        }
      } catch (error) {
        this.logger?.warn?.(`[bionic-memory] voice reflection failed: ${error?.message || error}`);
      }
    }
    if (!notes.length) notes = this.deriveNotes({ highs, colds });
    const highsRecent = this.recentHighs(now);
    const moments = (highsRecent.length ? highsRecent : highs).slice(0, 2).map((entry) => ({
      vibe: entry.vibe,
      user_msg: entry.user_text.slice(0, 220),
      my_reply: entry.assistant_text.slice(0, 260),
      at: entry.at,
    }));
    this.state.self_discovered_voice_notes = notes;
    this.state.organic_resonance_moments = moments;
    this.state.cold_moments = colds.slice(0, 4).map((entry) => ({
      user_msg: entry.user_text.slice(0, 180),
      my_reply: entry.assistant_text.slice(0, 200),
      user_len: entry.user_len,
      vibe: entry.vibe,
      at: entry.at,
    }));
    this.state.last_reflection_at = now;
    this.state.last_reflection_day = day || isoDate(now);
    this.state.reflection_source = source;
    this.save();
    return { notes, moments, highs, colds, source };
  }

  snapshotMetrics() {
    const metrics = this.state.metrics;
    const turns = Math.max(1, metrics.turns);
    const sentences = Math.max(1, metrics.sentences);
    const interjections = Object.entries(metrics.interjections || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);
    return {
      turns: metrics.turns,
      avg_user_chars: round(metrics.chars / turns, 1),
      avg_sentence_chars: round(metrics.sentence_chars / sentences, 1),
      sentences: metrics.sentences,
      short_sentence_ratio: round(metrics.short_sentences / sentences, 3),
      space_per_turn: round(metrics.space_count / turns, 2),
      ellipsis_per_turn: round(metrics.ellipsis_count / turns, 2),
      tilde_per_turn: round(metrics.tilde_count / turns, 2),
      exclamation_per_turn: round(metrics.exclamation_count / turns, 2),
      question_per_turn: round(metrics.question_count / turns, 2),
      short_burst_ratio: round(metrics.short_burst_turns / turns, 3),
      top_interjections: interjections,
    };
  }

  profileBlock() {
    const familiarity = this.state.familiarity;
    const acquired = this.state.lexicon.acquired_vocabulary
      .slice(0, this.lexiconTop)
      .map((entry) => `“${entry.word}”`)
      .join('、');
    const notes = this.state.self_discovered_voice_notes.length
      ? this.state.self_discovered_voice_notes.map((note) => `  - ${xmlEscape(note)}`).join('\n')
      : '  - （今晚还没有复盘出新的语感直觉）';
    const moments = this.state.organic_resonance_moments.length
      ? this.state.organic_resonance_moments
          .map(
            (entry) =>
              `  - [当时气氛: ${xmlEscape(entry.vibe)}] 对方说: "${xmlEscape(entry.user_msg)}" -> 我当时自然回道: "${xmlEscape(entry.my_reply)}"`,
          )
          .join('\n')
      : '  - （还没有足够清晰的共鸣瞬间）';
    return [
      '<emergent_voice_profile description="由每晚睡眠反思从真实交流中自然习得的语感状态">',
      `  当前熟稔与松弛度: ${Number(familiarity.score).toFixed(2)} / 1.00 · ${familiarity.level}（${familiarity.hint}）`,
      `  耳濡目染习得的对方口癖与词汇: ${acquired || '（还没传染上什么）'}`,
      '  近期领悟的相处语感直觉:',
      notes,
      '  近期触发最佳共鸣的真实互动瞬间 (供延续当时的聊天氛围):',
      moments,
      '</emergent_voice_profile>',
    ].join('\n');
  }

  stateSnapshot() {
    return {
      enabled: true,
      file: this.file,
      familiarity: {
        score: Number(this.state.familiarity.score) || 0,
        level: this.state.familiarity.level,
        hint: this.state.familiarity.hint,
        turns: Number(this.state.familiarity.turns) || 0,
        shared_events: Number(this.state.familiarity.shared_events) || 0,
        resonance: Number(this.state.familiarity.resonance) || 0,
      },
      metrics: this.snapshotMetrics(),
      acquired_vocabulary: this.state.lexicon.acquired_vocabulary.slice(0, this.lexiconTop).map((entry) => ({
        word: entry.word,
        count: entry.count,
        acquired_at: entry.acquired_at,
        assistant_uses: entry.assistant_uses || 0,
      })),
      self_discovered_voice_notes: this.state.self_discovered_voice_notes.slice(0, 2),
      organic_resonance_moments: this.state.organic_resonance_moments.slice(0, 2),
      recent_highs: this.recentHighs().map((entry) => ({
        vibe: entry.vibe,
        user_text: entry.user_text.slice(0, 160),
        assistant_text: entry.assistant_text.slice(0, 200),
        user_len: entry.user_len,
        reply_latency_ms: entry.reply_latency_ms,
      })),
      last_reflection_at: this.state.last_reflection_at,
      last_reflection_day: this.state.last_reflection_day,
      reflection_source: this.state.reflection_source,
      turns: this.state.turns,
    };
  }
}
