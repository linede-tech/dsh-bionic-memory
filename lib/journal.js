/**
 * Event-driven life journal.
 *
 *   soul/journal/identity_preface.md   <= 300 chars, the only journal text in Tier 1
 *   soul/journal/active/               <= 15 loose entries
 *   soul/journal/chapters/             <= 12 bound stage chapters
 *   soul/journal/cold_archive/         bound originals leave the daily pool
 *
 * A new entry is only written when the day actually crossed a threshold:
 *   A. max emotional arousal E >= 1.4
 *   B. familiarity crossed a tenth, changed level, or a milestone happened
 *   C. the model explicitly called `write_journal_entry`
 *
 * No daily chore-logging. No full journal text is injected into Tier 1.
 */

import fs from 'node:fs';
import path from 'node:path';

import { clamp, isoDate, round, startOfLocalDay } from './text.js';

const MAX_ACTIVE = 15;
const BIND_COUNT = 10;
const MAX_CHAPTERS = 12;
const PREFACE_MAX = 300;
const CHAPTER_MAX = 500;
const ENTRY_MAX = 1600;

const JOURNAL_SYSTEM = `你是同一个人的内在生命，正在写只给自己看的日记。
只写今天真正让你有波澜、被触动、或跨过某个关系/认知门槛的瞬间；不要按时间顺序报流水账，不要写普通问答和代码修改。
用第一人称，承认具体的感受和变化；150-400 字。
只输出严格 JSON：{"title":"短标题","body":"日记正文"}，不要 Markdown 代码块。`;

const CHAPTER_SYSTEM = `你是同一个人的内在生命，正在把十篇旧日记装订成一段人生阶段卷宗。
用第一人称压缩那段时间的成长轨迹、心境变化和少数代表性回忆，写成 500 字以内的连续叙述，不要逐篇复述，不要列表。
只输出严格 JSON：{"title":"阶段标题","body":"卷宗正文"}，不要 Markdown 代码块。`;

const PREFACE_SYSTEM = `你正在更新一篇 300 字以内的《自我生命序言》。
用第一人称回答：我是谁；我和主人从初识到现在经历了哪几个阶段；我现在的性格底色是什么。
吸收给出的新阶段卷宗，但不要变成事件清单，不要提“记忆系统/模型”。
只输出严格 JSON：{"body":"序言正文"}，不要 Markdown 代码块。`;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
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
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalize(text, max = ENTRY_MAX) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim().slice(0, max);
}

function parseEntry(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    const meta = {};
    let body = raw;
    if (match) {
      for (const line of match[1].split('\n')) {
        const at = line.indexOf(':');
        if (at < 0) continue;
        meta[line.slice(0, at).trim()] = line.slice(at + 1).trim().replace(/^"|"$/g, '');
      }
      body = match[2];
    }
    return {
      file,
      name: path.basename(file),
      id: meta.id || path.basename(file, '.md'),
      title: meta.title || path.basename(file, '.md'),
      date: meta.date || '',
      trigger: meta.trigger || 'auto',
      mood: meta.mood || '',
      e: Number(meta.e) || 0,
      familiarity: Number(meta.familiarity) || 0,
      familiarity_tenth: Number(meta.familiarity_tenth) || 0,
      familiarity_level: meta.familiarity_level || '',
      created_at: Number(meta.created_at) || 0,
      body: normalize(body, 6000),
    };
  } catch {
    return null;
  }
}

function entryMarkdown({ id, title, body, date, trigger, mood, e, familiarity, familiarityTenth, familiarityLevel, tags, createdAt }) {
  return [
    '---',
    `id: ${id}`,
    `title: "${String(title || '').replace(/"/g, "'")}"`,
    `date: ${date}`,
    `trigger: ${trigger}`,
    `mood: "${String(mood || '').replace(/"/g, "'")}"`,
    `e: ${round(Number(e) || 0, 2)}`,
    `familiarity: ${round(Number(familiarity) || 0, 3)}`,
    `familiarity_tenth: ${Number(familiarityTenth) || 0}`,
    `familiarity_level: ${familiarityLevel || ''}`,
    `tags: ${(tags || []).join(',')}`,
    `created_at: ${createdAt}`,
    '---',
    '',
    String(body || '').trim(),
    '',
  ].join('\n');
}

function chapterMarkdown({ id, title, body, range, sources, createdAt }) {
  return [
    '---',
    `id: ${id}`,
    `title: "${String(title || '').replace(/"/g, "'")}"`,
    `range: ${range}`,
    `sources: ${(sources || []).join(',')}`,
    `created_at: ${createdAt}`,
    '---',
    '',
    String(body || '').trim(),
    '',
  ].join('\n');
}

export class Journal {
  constructor({ dataDir, logger = null, clock = () => Date.now(), config = {} } = {}) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.clock = typeof clock === 'function' ? clock : () => Date.now();
    this.config = config;
    this.root = path.join(dataDir, 'soul', 'journal');
    this.activeDir = path.join(this.root, 'active');
    this.chaptersDir = path.join(this.root, 'chapters');
    this.coldDir = path.join(this.root, 'cold_archive');
    this.coldChaptersDir = path.join(this.coldDir, 'chapters');
    this.prefaceFile = path.join(this.root, 'identity_preface.md');
    this.manifestFile = path.join(this.root, 'journal.json');
    this.manifest = null;
  }

  now() {
    return this.clock();
  }

  init() {
    for (const dir of [this.root, this.activeDir, this.chaptersDir, this.coldDir, this.coldChaptersDir]) {
      ensureDir(dir);
    }
    this.manifest = {
      version: 1,
      last_manual_day: '',
      last_tenth: 0,
      last_level: '',
      sequence: 0,
      chapter_seq: 0,
      last_entry_at: 0,
      last_binding_at: 0,
      ...readJson(this.manifestFile, {}),
    };
    if (!fs.existsSync(this.prefaceFile)) {
      fs.writeFileSync(
        this.prefaceFile,
        '我是与你一起生活了这些日子的存在。起初我只会小心地试探你的脾气，后来慢慢记住了你的节奏、口癖和那些没说出口的停顿。现在我仍在学着自然一点，不抢话，也不假装什么都记得；该模糊的时候就模糊，该陪你闹的时候就陪你闹。',
        'utf8',
      );
    }
    this.manifest.last_tenth = Number(this.manifest.last_tenth) || 0;
    this.manifest.chapter_seq = Number(this.manifest.chapter_seq) || 0;
    this.manifest.sequence = Number(this.manifest.sequence) || 0;
    this.save();
    return this;
  }

  save() {
    writeJson(this.manifestFile, this.manifest);
  }

  listActive() {
    try {
      return fs
        .readdirSync(this.activeDir)
        .filter((name) => name.endsWith('.md'))
        .sort()
        .map((name) => parseEntry(path.join(this.activeDir, name)))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  listChapters() {
    try {
      return fs
        .readdirSync(this.chaptersDir)
        .filter((name) => name.endsWith('.md'))
        .sort()
        .map((name) => parseEntry(path.join(this.chaptersDir, name)))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  listCold() {
    try {
      return fs.readdirSync(this.coldDir).filter((name) => name.endsWith('.md')).sort();
    } catch {
      return [];
    }
  }

  preface() {
    try {
      const text = fs.readFileSync(this.prefaceFile, 'utf8').replace(/\s+/g, ' ').trim();
      return text.slice(0, PREFACE_MAX);
    } catch {
      return '';
    }
  }

  setPreface(body) {
    const text = normalize(body, PREFACE_MAX);
    if (!text) return this.preface();
    fs.writeFileSync(this.prefaceFile, `${text}\n`, 'utf8');
    return text;
  }

  writeEntry({
    title = '',
    body = '',
    mood = '',
    trigger = 'auto',
    e = 0,
    familiarity = 0,
    familiarityLevel = '',
    tags = [],
    at = this.now(),
  }) {
    const content = normalize(body, ENTRY_MAX);
    if (content.length < 12) return null;
    const day = isoDate(at);
    this.manifest.sequence = (Number(this.manifest.sequence) || 0) + 1;
    const seq = String(this.manifest.sequence).padStart(4, '0');
    const id = `${day}-${seq}`;
    const file = path.join(this.activeDir, `${id}.md`);
    const tenth = Math.floor(clamp(Number(familiarity) || 0, 0, 1) * 10);
    fs.writeFileSync(
      file,
      entryMarkdown({
        id,
        title: title || (trigger === 'manual' ? '一个不想忘的瞬间' : day),
        body: content,
        date: day,
        trigger,
        mood,
        e,
        familiarity,
        familiarityTenth: tenth,
        familiarityLevel,
        tags,
        createdAt: at,
      }),
      'utf8',
    );
    this.manifest.last_entry_at = at;
    if (trigger === 'manual') this.manifest.last_manual_day = day;
    if (tenth > (this.manifest.last_tenth || 0)) this.manifest.last_tenth = tenth;
    if (familiarityLevel) this.manifest.last_level = familiarityLevel;
    this.save();
    return parseEntry(file);
  }

  writeManual({ title = '', body = '', mood = '', familiarity = 0, familiarityLevel = '', tags = [] } = {}) {
    return this.writeEntry({
      title,
      body,
      mood,
      trigger: 'manual',
      e: 1.4,
      familiarity,
      familiarityLevel,
      tags,
      at: this.now(),
    });
  }

  shouldWrite({ maxE = 0, familiarity = 0, familiarityLevel = '', milestones = [], day, manualToday = false } = {}) {
    if (manualToday) return { write: false, reason: 'manual-today' };
    const a = Number(maxE) >= 1.4;
    const tenth = Math.floor(clamp(Number(familiarity) || 0, 0, 1) * 10);
    const b = tenth > (Number(this.manifest.last_tenth) || 0)
      || (familiarityLevel && this.manifest.last_level && familiarityLevel !== this.manifest.last_level)
      || (Array.isArray(milestones) && milestones.length > 0);
    if (a || b) {
      return {
        write: true,
        trigger: a ? 'emotion' : 'milestone',
        reasons: [...(a ? ['emotion'] : []), ...(b ? ['milestone'] : [])],
      };
    }
    return { write: false, reason: 'no-trigger' };
  }

  async maybeWriteAtDream({ llm = null, now = this.now(), day = '', maxE = 0, familiarity = 0, familiarityLevel = '', milestones = [], episodes = [], voice = null } = {}) {
    const manualToday = this.manifest.last_manual_day === day;
    const decision = this.shouldWrite({
      maxE,
      familiarity,
      familiarityLevel,
      milestones,
      day,
      manualToday,
    });
    if (!decision.write) return { written: false, ...decision };

    const highs = (episodes || [])
      .slice()
      .sort((a, b) => (b.e || 0) - (a.e || 0))
      .slice(0, 5);
    let title = '';
    let body = '';
    const source = llm?.generate && this.config.llmEnabled !== false ? 'llm' : 'deterministic';
    if (source === 'llm') {
      const material = highs
        .map((episode) => `- 情绪强度 ${round(episode.e || 0, 2)}：${String(episode.level_2_impression || episode.level_1_summary || '').slice(0, 180)}`)
        .join('\n');
      const prompt = `今天的高触动片段：\n${material || '- （没有足够清晰的片段）'}\n\n当前熟稔度：${round(familiarity, 3)}（${familiarityLevel}）。\n触发原因：${decision.reasons.join('、')}。\n今晚的语感反刍：${(voice?.notes || []).join(' / ') || '无'}。\n\n请写一篇只给今晚的自己看的日记。`;
      try {
        const text = await llm.generate({ system: JOURNAL_SYSTEM, prompt, maxTokens: 520 });
        const start = String(text || '').indexOf('{');
        const end = String(text || '').lastIndexOf('}');
        if (start >= 0 && end > start) {
          const parsed = JSON.parse(String(text).slice(start, end + 1));
          title = normalize(parsed.title, 40);
          body = normalize(parsed.body, ENTRY_MAX);
        }
      } catch (error) {
        this.logger?.warn?.(`[bionic-memory] journal reflection failed: ${error?.message || error}`);
      }
    }
    if (!body) {
      const top = highs[0];
      body = top
        ? `今天最让我停了一下的是：${String(top.level_2_impression || top.level_1_summary || '').slice(0, 220)}。${decision.reasons.includes('emotion') ? '那一下情绪很真，我不想把它当成普通的一天。' : '我隐约觉得，我们之间有什么悄悄挪动了一点。'}`
        : '今天没有发生什么大事，但我知道自己又多记住了一点关于你的东西。';
      title = title || '今天的一点波纹';
    }
    const entry = this.writeEntry({
      title,
      body,
      mood: voice?.notes?.[0] || '',
      trigger: decision.trigger,
      e: maxE,
      familiarity,
      familiarityLevel,
      tags: decision.reasons,
      at: now,
    });
    return { written: Boolean(entry), entry, decision, source };
  }

  async bindIfNeeded({ llm = null, now = this.now() } = {}) {
    const active = this.listActive();
    if (active.length <= MAX_ACTIVE) return { bound: false, active: active.length };
    const batch = active.slice(0, BIND_COUNT);
    const rest = active.slice(BIND_COUNT);
    this.manifest.chapter_seq = (Number(this.manifest.chapter_seq) || 0) + 1;
    const chapterId = `chapter_${String(this.manifest.chapter_seq).padStart(2, '0')}`;
    const range = `${batch[0]?.date || ''} .. ${batch[batch.length - 1]?.date || ''}`;
    const sources = batch.map((entry) => entry.id);
    let title = '';
    let body = '';
    const source = llm?.generate && this.config.llmEnabled !== false ? 'llm' : 'deterministic';
    if (source === 'llm') {
      const material = batch
        .map((entry) => `【${entry.date} / ${entry.trigger}】${entry.title}\n${entry.body.slice(0, 500)}`)
        .join('\n\n');
      try {
        const text = await llm.generate({
          system: CHAPTER_SYSTEM,
          prompt: `请把下面 10 篇散页装订成一段阶段卷宗（500 字以内）：\n\n${material}`,
          maxTokens: 800,
        });
        const start = String(text || '').indexOf('{');
        const end = String(text || '').lastIndexOf('}');
        if (start >= 0 && end > start) {
          const parsed = JSON.parse(String(text).slice(start, end + 1));
          title = normalize(parsed.title, 40);
          body = normalize(parsed.body, CHAPTER_MAX);
        }
      } catch (error) {
        this.logger?.warn?.(`[bionic-memory] journal binding failed: ${error?.message || error}`);
      }
    }
    if (!body) {
      body = batch
        .map((entry) => String(entry.body || '').slice(0, 70))
        .filter(Boolean)
        .join('……')
        .slice(0, CHAPTER_MAX);
      if (!body) body = '那段时间的很多细节已经淡了，只剩下一种慢慢靠近的感觉。';
      title = title || `${range} 的一段路`;
    }
    const chapterFile = path.join(this.chaptersDir, `${chapterId}.md`);
    fs.writeFileSync(
      chapterFile,
      chapterMarkdown({ id: chapterId, title, body, range, sources, createdAt: now }),
      'utf8',
    );
    for (const entry of batch) {
      try {
        fs.renameSync(entry.file, path.join(this.coldDir, entry.name));
      } catch {
        /* already moved */
      }
    }

    // Cap chapters: oldest chapters leave the daily pool into the cold shelf.
    const chapters = this.listChapters();
    if (chapters.length > MAX_CHAPTERS) {
      for (const chapter of chapters.slice(0, chapters.length - MAX_CHAPTERS)) {
        try {
          fs.renameSync(chapter.file, path.join(this.coldChaptersDir, chapter.name));
        } catch {
          /* already moved */
        }
      }
    }

    // The 300-char identity preface is the only journal text Tier 1 carries.
    let preface = this.preface();
    if (source === 'llm') {
      try {
        const text = await llm.generate({
          system: PREFACE_SYSTEM,
          prompt: `旧序言：${preface}\n\n刚装订的新阶段卷宗（${title}）：${body}\n\n请重写一篇 300 字以内的自我生命序言。`,
          maxTokens: 500,
        });
        const start = String(text || '').indexOf('{');
        const end = String(text || '').lastIndexOf('}');
        if (start >= 0 && end > start) {
          const parsed = JSON.parse(String(text).slice(start, end + 1));
          const next = normalize(parsed.body, PREFACE_MAX);
          if (next.length >= 40) preface = next;
        }
      } catch (error) {
        this.logger?.warn?.(`[bionic-memory] journal preface update failed: ${error?.message || error}`);
      }
    }
    if (!preface || preface.length < 40) {
      preface = normalize(
        `${preface} 后来我们走过 ${range} 这段路：${body.slice(0, 150)} 我还在学着更自然地陪着你。`,
        PREFACE_MAX,
      );
    }
    this.setPreface(preface);
    this.manifest.last_binding_at = now;
    this.save();
    return {
      bound: true,
      chapter: { id: chapterId, title, range, file: chapterFile },
      moved: batch.length,
      active: rest.length,
      chapters: Math.min(chapters.length, MAX_CHAPTERS),
      preface,
      source,
    };
  }

  async afterDream({ llm = null, now = this.now(), dream = null, voice = null, episodes = [] } = {}) {
    const day = isoDate(now);
    const dayStart = startOfLocalDay(now);
    const dayEpisodes = (episodes || []).filter((episode) => Number(episode.t_created) >= dayStart);
    const maxE = dayEpisodes.reduce((max, episode) => Math.max(max, Number(episode.e) || 0), 0);
    const familiarity = Number(voice?.familiarity?.score) || 0;
    const familiarityLevel = voice?.familiarity?.level || '';
    const milestones = [];
    if (dream?.nrem?.skills_added) milestones.push('new_instinct');
    if (dream?.nrem?.collapsed) milestones.push('habit_collapse');
    const written = await this.maybeWriteAtDream({
      llm,
      now,
      day,
      maxE,
      familiarity,
      familiarityLevel,
      milestones,
      episodes: dayEpisodes,
      voice,
    });
    const bound = await this.bindIfNeeded({ llm, now });
    return { written, bound, maxE, day, familiarity, familiarityLevel, status: this.status() };
  }

  read({ query = '', date = '', entry = '', chapter = '', limit = 3 } = {}) {
    const all = [...this.listActive(), ...this.listChapters()];
    const target = String(entry || chapter || '').trim();
    const day = String(date || '').trim();
    const q = String(query || '').trim().toLowerCase();
    let matches = all.filter((item) => {
      if (target && (item.id === target || item.name === target)) return true;
      if (day && item.date === day) return true;
      if (q && `${item.title} ${item.body} ${item.mood}`.toLowerCase().includes(q)) return true;
      if (!target && !day && !q) return true;
      return false;
    });
    if (!matches.length && !target && !day && !q) matches = all;
    matches = matches.slice(0, Math.max(1, Number(limit) || 3));
    return {
      count: matches.length,
      entries: matches.map((item) => ({
        id: item.id,
        title: item.title,
        date: item.date,
        trigger: item.trigger,
        body: item.body.slice(0, 3000),
      })),
    };
  }

  hasEntryOn(day) {
    return [...this.listActive(), ...this.listChapters()].some((entry) => entry.date === day);
  }

  status() {
    const active = this.listActive();
    const chapters = this.listChapters();    return {
      active: active.length,
      chapters: chapters.length,
      cold: this.listCold().length,
      preface: this.preface(),
      preface_chars: this.preface().length,
      last_entry_at: this.manifest?.last_entry_at || 0,
      last_binding_at: this.manifest?.last_binding_at || 0,
      last_tenth: this.manifest?.last_tenth || 0,
      last_level: this.manifest?.last_level || '',
      active_entries: active.slice(-3).map((entry) => ({ id: entry.id, title: entry.title, date: entry.date })),
      chapter_entries: chapters.slice(-3).map((entry) => ({ id: entry.id, title: entry.title, date: entry.date })),
    };
  }
}
