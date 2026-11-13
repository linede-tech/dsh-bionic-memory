/**
 * StyleBank — few-shot natural-voice anchor collection.
 *
 * The bank records real User -> Assistant pairs from the Bionic Memory Mode.
 * A pair enters when the next user turn shows strong positive feedback, when a
 * dense conversational continuation follows, when the user explicitly teaches
 * "你应该这么说：…", or via `/style save`. The highest-weight five are compiled
 * into the daily Tier 1 block so the model imitates its own best natural voice
 * without putting per-turn data into the static prefix.
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const POSITIVE_RE =
  /哈哈|hhh|233|笑死|笑不活|乐了|太可爱|可爱|懂我|就是这样|太对|绝了|好家伙|哎哟|牛啊|好棒|爱了|喜欢|满意|可以可以|有那味|像人|自然|太真实|狠狠共情/gi;

const DENSE_RE = /然后|而且|对了|话说|继续|还有|不过|所以|结果|后来|接着|说真的|我跟你讲/;

const TEACHING_RE = /(?:你(?:应该|可以|要|得)这么(?:说|回)|你这么说|应该这样回|示范一下|标准答案是)[：:]\s*([\s\S]{4,1200})/;

function normalize(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function hashKey(user, assistant) {
  return createHash('sha256').update(`${normalize(user)}\n${normalize(assistant)}`).digest('hex').slice(0, 24);
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

export class StyleBank {
  constructor({ dataDir, config = {}, logger = null, clock = () => Date.now() }) {
    this.dataDir = dataDir;
    this.config = config;
    this.logger = logger;
    this.clock = typeof clock === 'function' ? clock : () => Date.now();
    this.file = path.join(dataDir, 'style_bank.json');
    this.entries = [];
    this.loaded = false;
    this.max = Math.max(10, Number(config.styleBankMax) || 200);
    this.topN = Math.min(10, Math.max(1, Number(config.styleBankTop) || 5));
    this.manualWeight = Math.max(1, Number(config.styleBankManualWeight) || 10);
    this.feedbackWeight = Math.max(1, Number(config.styleBankFeedbackWeight) || 3);
    this.continuationWeight = Math.max(1, Number(config.styleBankContinuationWeight) || 1.5);
    this.maxChars = Math.max(200, Number(config.styleBankMaxChars) || 1200);
  }

  now() {
    return this.clock();
  }

  init() {
    const stored = readJson(this.file, null);
    const entries = Array.isArray(stored) ? stored : stored?.entries;
    this.entries = (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry && entry.id && entry.user && entry.assistant)
      .map((entry) => ({
        id: String(entry.id),
        key: entry.key || hashKey(entry.user, entry.assistant),
        user: normalize(entry.user).slice(0, this.maxChars),
        assistant: normalize(entry.assistant).slice(0, this.maxChars),
        weight: Number(entry.weight) || 1,
        source: entry.source || 'unknown',
        created_at: Number(entry.created_at) || this.now(),
        last_seen: Number(entry.last_seen) || 0,
        hits: Number(entry.hits) || 1,
        session_id: entry.session_id || '',
        turn: Number(entry.turn) || 0,
        tags: Array.isArray(entry.tags) ? entry.tags.slice(0, 8) : [],
      }))
      .slice(0, this.max);
    this.loaded = true;
    this.save();
    return this;
  }

  save() {
    this.entries = this.entries
      .slice()
      .sort((a, b) => b.weight - a.weight || b.last_seen - a.last_seen)
      .slice(0, this.max);
    writeJson(this.file, {
      version: 1,
      updated_at: this.now(),
      entries: this.entries,
    });
  }

  record({ user = '', assistant = '', weight = 1, source = 'auto', session_id = '', turn = 0, tags = [] } = {}) {
    const u = normalize(user).slice(0, this.maxChars);
    const a = normalize(assistant).slice(0, this.maxChars);
    if (u.length < 2 || a.length < 8) return null;
    if (a.length > this.maxChars || u.length > this.maxChars) return null;
    if (/```|^\s*(?:import|export|function|class|const|let|var)\b/m.test(a)) return null;
    const key = hashKey(u, a);
    const now = this.now();
    const existing = this.entries.find((entry) => entry.key === key);
    if (existing) {
      existing.weight = Math.max(Number(existing.weight) || 1, Number(weight) || 1);
      existing.last_seen = now;
      existing.hits = (Number(existing.hits) || 1) + 1;
      if (source === 'manual' || source === 'user_taught') existing.source = source;
      if (session_id) existing.session_id = String(session_id);
      if (turn) existing.turn = Number(turn) || 0;
      this.save();
      return existing;
    }
    const entry = {
      id: `sty-${randomUUID().slice(0, 8)}`,
      key,
      user: u,
      assistant: a,
      weight: Math.max(1, Number(weight) || 1),
      source,
      created_at: now,
      last_seen: now,
      hits: 1,
      session_id: String(session_id || ''),
      turn: Number(turn) || 0,
      tags: Array.isArray(tags) ? tags.slice(0, 8) : [],
    };
    this.entries.push(entry);
    this.save();
    return entry;
  }

  extractTeaching(text) {
    const match = String(text || '').match(TEACHING_RE);
    if (!match) return '';
    return normalize(match[1]).replace(/^["“]|["”]$/g, '').slice(0, this.maxChars);
  }

  fromTurn({ session_id = '', turn = 0, user_text = '', assistant_text = '', previousPair = null, now = this.now() } = {}) {
    const current = normalize(user_text);
    const captured = [];
    const teaching = this.extractTeaching(current);
    if (teaching) {
      const userContext = normalize(previousPair?.user_text) || '（用户示范）';
      const entry = this.record({
        user: userContext,
        assistant: teaching,
        weight: this.manualWeight,
        source: 'user_taught',
        session_id,
        turn,
        tags: ['taught'],
      });
      if (entry) captured.push(entry);
    }
    const positive = POSITIVE_RE.test(current);
    POSITIVE_RE.lastIndex = 0;
    const dense =
      current.length >= 40
      && DENSE_RE.test(current)
      && !/^(?:帮我|请|把|写|改|查|运行|执行|修|拉|做|生成|整理|分析)/.test(current);
    if ((positive || dense) && previousPair?.user_text && previousPair?.assistant_text) {
      const entry = this.record({
        user: previousPair.user_text,
        assistant: previousPair.assistant_text,
        weight: positive ? this.feedbackWeight : this.continuationWeight,
        source: positive ? 'feedback' : 'continuation',
        session_id,
        turn: previousPair.turn || Math.max(0, Number(turn) - 1),
        tags: [positive ? 'positive' : 'dense'],
      });
      if (entry) captured.push(entry);
    }
    return { captured, teaching: Boolean(teaching) };
  }

  fromManual({ user = '', assistant = '', session_id = '', turn = 0 } = {}) {
    return this.record({
      user: user || '（用户示范）',
      assistant,
      weight: this.manualWeight,
      source: 'manual',
      session_id,
      turn,
      tags: ['manual'],
    });
  }

  top(count = this.topN) {
    return this.entries
      .slice()
      .sort((a, b) => b.weight - a.weight || b.last_seen - a.last_seen)
      .slice(0, Math.max(1, Number(count) || this.topN));
  }

  all() {
    return this.entries.slice().sort((a, b) => b.weight - a.weight || b.last_seen - a.last_seen);
  }

  remove(id) {
    const target = String(id || '').trim();
    const index = this.entries.findIndex((entry) => entry.id === target || entry.key === target);
    if (index < 0) return { ok: false, error: '没有找到这条语料' };
    const [removed] = this.entries.splice(index, 1);
    this.save();
    return { ok: true, entry: removed };
  }

  state() {
    return {
      enabled: true,
      count: this.entries.length,
      max: this.max,
      top_n: this.topN,
      file: this.file,
      manual_weight: this.manualWeight,
      feedback_weight: this.feedbackWeight,
      top: this.top(this.topN).map((entry) => ({
        id: entry.id,
        user: entry.user.slice(0, 140),
        assistant: entry.assistant.slice(0, 180),
        weight: entry.weight,
        source: entry.source,
        hits: entry.hits,
      })),
    };
  }

  close() {
    try {
      this.save();
    } catch {
      /* best effort */
    }
  }
}
