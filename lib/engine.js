/**
 * Bionic memory engine.
 *
 * Layers:
 *   L1 subconscious scratchpad (mood / dream residue / curiosity hooks)
 *   L2 multi-resolution episodic memory (raw -> summary -> impression)
 *   L3 compressed habit schemas with one exception anchor
 *   L4 procedural skills extracted from corrections and highlights
 *
 * The engine is pure JavaScript over the store interface so the pre-install
 * smoke test can run it against a temporary directory without Cordis.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  CONTRADICTION_RE,
  CORRECTION_RE,
  PRAISE_RE,
  averageVector,
  clamp,
  cosine,
  formatDateTime,
  habitusSummary,
  humanizeElapsed,
  impressionOf,
  isoDate,
  jaccard,
  keywords,
  moodWord,
  newId,
  reconsolidationTone,
  round,
  sameLocalDay,
  sentiment,
  shortRule,
  startOfLocalDay,
  summarize,
  textOfContent,
  textSimilarity,
  tokenize,
  toneLabel,
  unique,
  vectorize,
  xmlEscape,
} from './text.js';
import { MetaEvolver } from './meta-evolver.js';
import { ContextMetabolism } from './context-metabolism.js';
import { VoiceEngine } from './voice-engine.js';
import {
  readTier1,
  soulPaths,
  writeBriefings,
  writeDream,
  writeScratchpad,
  writeSkills,
  writeTier1,
} from './soul-storage.js';

const DREAM_SYSTEM = `你是某个人的潜意识。你只负责做梦，不做解释、不做总结、不输出列表。
用简体中文第一人称写一段超现实梦境，把给出的记忆碎片编织成不合常理但情绪连贯的场景。
只输出梦境正文本身。`;

const NREM_SYSTEM = `你是一个记忆整理器，负责从一天的对话里提炼可以永久内化的 If-Then 经验。
经验必须具体、可执行、面向未来类似场景；不要复述事件，不要写空话。
只输出严格 JSON，不要 Markdown 代码块。`;

const BATCH_SYSTEM = `你是某个人的睡眠期大脑维护器，负责 NREM 记忆坍缩、印象降维、经验萃取与 REM 梦境合成。
你只输出一个严格 JSON 对象。不要 Markdown 代码块，不要解释，不要输出 JSON 以外的任何字符。`;

function parseJsonBlock(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function shuffle(list) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function asArray(value, fallback = []) {
  return Array.isArray(value) ? value : fallback;
}

const MASK_PLACEHOLDER = '[███(名字卡在嘴边死活想不起来，只记得大概特征)]';

// Immunity guard: these are never distorted, no matter their retention.
const CORE_MEMORY_RE =
  /代码|插件|函数|接口|API|bug|报错|错误|部署|构建|测试|重构|提交|仓库|配置|系统|任务|指令|规范|协议|数据库|SQL|脚本|编译|运行时|prompt|token|模型|架构|性能|安全|权限|日志|文件|目录|命令|错误码|开发|实现|修复|升级|版本|harness|cordis|dsh/i;
const DAILY_MEMORY_RE =
  /咖啡|早餐|午餐|晚餐|散步|公园|海边|猫|狗|花|雨|阳光|朋友|家人|电影|音乐|书店|旅行|街道|餐厅|周末|晚上|早上|心情|开心|难过|生日|礼物|聊天|桌上|窗|厨房|面包|茶|店|路|风|梦|睡着|醒来|杯子|衣服|照片/i;
const CORRECTION_MARKERS_RE =
  /记错|记混|记串|记岔|搞错|弄错|不是.*(?:是|而是)|其实是|应该是|你忘了|提醒你|那个词|那个名字|那个地方|你说的不对|不是那|不对吧|错了吧|纠正|没(?:有)?(?:去过|说过|做过|发生|这回事)|不记得有|例外|那次不一样|不是每次|那次没有|是你说的|是我说的|你告诉|我告诉|correct|wrong|mixed up|actually it was/i;

export class BionicMemoryEngine {
  constructor({
    store,
    config,
    logger,
    llm,
    sessions,
    clock,
    dataDir,
    random,
    packageDir,
    basePrompt,
    pluginReload,
    tokenMeter,
    llmRuntime,
  }) {
    this.store = store;
    this.config = config;
    this.logger = logger;
    this.llm = llm;
    this.sessions = sessions;
    this.tokenMeter = tokenMeter || null;
    this.llmRuntime = llmRuntime || null;
    this.clock = typeof clock === 'function' ? clock : () => Date.now();
    this.random = typeof random === 'function' ? random : Math.random;
    this.dataDir = dataDir;
    this.paths = soulPaths(dataDir);
    this.packageDir = packageDir;
    this.basePrompt = typeof basePrompt === 'string' ? basePrompt : '';
    this.pluginReload = typeof pluginReload === 'function' ? pluginReload : null;
    this.scratchpad = null;
    this.lastContext = '';
    this.lastContextAt = 0;
    this.lastDream = null;
    this.dreamCache = null;
    this.pendingReconsolidation = [];
    this.activeDistortions = new Map();
    this.fallibilityChecked = new Set();
    this.injections = new Map();
    this.metaEvolver = null;
    this.contextMetabolism = null;
    this.voiceEngine = null;
    this.recentTurnPairs = new Map();
    this.dailyBlock = '';
    this.dailyDay = '';
    this.dailyAt = 0;
    this.dailyFrozenFile = this.paths.tier1;
    this.dailyMetaFile = this.paths.dailyMeta;
    this.toolSchemaHash = '';
    this.dreaming = false;
  }

  now() {
    return this.clock();
  }

  // ---------------------------------------------------------------- lifecycle

  init() {
    const version = this.store.getMeta('schema_version', 0);
    this.store.setMeta('schema_version', 2);
    if (!this.store.getMeta('created_at', 0)) this.store.setMeta('created_at', this.now());
    this.scratchpad = this.loadScratchpad();
    if (version !== 2) {
      this.store.appendJournal({
        at: this.now(),
        kind: 'schema',
        summary: `memory schema set to v2 (from v${version})`,
      });
    }
    if (this.config.metaEvolutionEnabled && this.packageDir) {
      try {
        this.metaEvolver = new MetaEvolver({
          engine: this,
          store: this.store,
          config: this.config,
          dataDir: this.paths.evolution,
          logger: this.logger,
          llm: this.llm,
          packageDir: this.packageDir,
          basePrompt: this.basePrompt,
          reload: this.pluginReload,
        });
        this.metaEvolver.init();
      } catch (error) {
        this.logger?.warn?.(`[bionic-memory] meta-evolver init failed: ${error?.message || error}`);
        this.metaEvolver = null;
      }
    }
    if (this.config.voiceEngineEnabled !== false) {
      try {
        this.voiceEngine = new VoiceEngine({
          dataDir: this.paths.soul,
          file: this.paths.voice,
          config: this.config,
          logger: this.logger,
          clock: this.clock,
        });
        this.voiceEngine.init();
        this.voiceEngine.recomputeFamiliarity({
          episodes: this.store.listEpisodes().length,
          dreams: this.store.listDreams().length,
          now: this.now(),
        });
        this.voiceEngine.save();
      } catch (error) {
        this.logger?.warn?.(`[bionic-memory] voice engine init failed: ${error?.message || error}`);
        this.voiceEngine = null;
      }
    }
    this.loadDailyFrozen();
    try {
      this.refreshSoulArtifacts();
      for (const dream of this.store.listDreams(50).slice().reverse()) {
        try {
          writeDream(this.dataDir, dream);
        } catch {
          /* one unreadable dream does not block boot */
        }
      }
    } catch (error) {
      this.logger?.warn?.(`[bionic-memory] soul export failed: ${error?.message || error}`);
    }
    if (this.config.contextMetabolismEnabled && this.sessions && this.tokenMeter) {
      try {
        this.contextMetabolism = new ContextMetabolism({
          engine: this,
          store: this.store,
          config: this.config,
          dataDir: this.dataDir,
          logger: this.logger,
          sessions: this.sessions,
          tokenMeter: this.tokenMeter,
          llmRuntime: this.llmRuntime,
          clock: this.clock,
        });
        this.contextMetabolism.init();
      } catch (error) {
        this.logger?.warn?.(`[bionic-memory] context-metabolism init failed: ${error?.message || error}`);
        this.contextMetabolism = null;
      }
    }
    this.decayAll(this.now(), { force: true });
    this.pruneDanglingEdges();
    const latestDream = this.store.listDreams(1)[0];
    if (latestDream) this.dreamCache = this.dreamCacheFrom(latestDream);
    return this;
  }

  defaultScratchpad() {
    const now = this.now();
    return {
      mood: { label: '平静松弛', valence: 0.1, arousal: 0.25, updated_at: now },
      dream_afterglow: '',
      dream_at: 0,
      curiosity_hooks: [],
      fallibility_anchors: [],
      updated_at: now,
    };
  }

  loadScratchpad() {
    const stored = this.store.getScratchpad();
    const base = this.defaultScratchpad();
    if (!stored || typeof stored !== 'object') return base;
    return {
      ...base,
      ...stored,
      mood: { ...base.mood, ...(stored.mood || {}) },
      curiosity_hooks: asArray(stored.curiosity_hooks),
      fallibility_anchors: asArray(stored.fallibility_anchors),
    };
  }

  getScratchpad() {
    if (!this.scratchpad) this.scratchpad = this.loadScratchpad();
    return this.scratchpad;
  }

  saveScratchpad(patch) {
    const next = { ...this.getScratchpad(), ...patch, updated_at: this.now() };
    this.scratchpad = next;
    this.store.saveScratchpad(next);
    try {
      writeScratchpad(this.dataDir, next);
    } catch (error) {
      this.logger?.warn?.(`[bionic-memory] soul scratchpad write failed: ${error?.message || error}`);
    }
    return next;
  }

  refreshSoulArtifacts() {
    let skills = [];
    try {
      writeScratchpad(this.dataDir, this.getScratchpad());
    } catch (error) {
      this.logger?.warn?.(`[bionic-memory] soul scratchpad mirror failed: ${error?.message || error}`);
    }
    try {
      skills = this.store.listSkills();
      writeSkills(this.dataDir, skills);
    } catch (error) {
      this.logger?.warn?.(`[bionic-memory] soul skills mirror failed: ${error?.message || error}`);
    }
    try {
      writeBriefings({
        root: this.dataDir,
        skills,
        schemas: this.store.listSchemas(),
        episodes: this.store.listEpisodes(),
        voice: this.voiceEngine?.stateSnapshot?.() || null,
      });
    } catch (error) {
      this.logger?.warn?.(`[bionic-memory] orchestrator briefing mirror failed: ${error?.message || error}`);
    }
  }

  noteUserActivity() {
    this.store.setMeta('last_user_contact_at', this.now());
  }

  updateMoodFrom(senti) {
    const now = this.now();
    const mood = this.getScratchpad().mood || {};
    const valence = clamp((mood.valence ?? 0) * 0.75 + senti.valence * 0.25, -1, 1);
    const arousal = clamp((mood.arousal ?? 0.25) * 0.75 + senti.arousal * 0.25, 0, 1);
    this.saveScratchpad({
      mood: { label: toneLabel(valence, arousal), valence: round(valence, 3), arousal: round(arousal, 3), updated_at: now },
    });
  }

  addCuriosity(text, source) {
    const clean = String(text || '').trim();
    if (!clean) return null;
    const scratchpad = this.getScratchpad();
    const hooks = asArray(scratchpad.curiosity_hooks);
    if (hooks.some((hook) => !hook.resolved && (hook.source === source || textSimilarity(hook.text, clean) > 0.8))) {
      return null;
    }
    const hook = {
      id: newId('cur'),
      text: clean,
      source: source || '',
      created_at: this.now(),
      resolved: false,
    };
    this.saveScratchpad({ curiosity_hooks: [hook, ...hooks].slice(0, 20) });
    return hook;
  }

  resolveCuriosity(idOrText) {
    const hooks = asArray(this.getScratchpad().curiosity_hooks);
    const next = hooks.map((hook) =>
      hook.id === idOrText || hook.text === idOrText ? { ...hook, resolved: true } : hook,
    );
    this.saveScratchpad({ curiosity_hooks: next });
    return next.filter((hook) => !hook.resolved).length;
  }

  journal(kind, summary, detail = '', sessionId = '') {
    this.store.appendJournal({
      at: this.now(),
      session_id: sessionId,
      kind,
      summary: shortRule(summary, 400),
      detail: shortRule(detail, 1600),
    });
  }

  // ------------------------------------------------------- source attribution

  normalizeSourceType(value) {
    if (value === 'user_stated' || value === 'dream_generated') return value;
    return 'agent_inferred';
  }

  sourceLabel(source) {
    if (source === 'user_stated') return '[用户亲述]';
    if (source === 'dream_generated') return '[梦境生成·不可当作事实]';
    return '[我的推测·未证实]';
  }

  // ---------------------------------------------------- cross-session notes

  updateSessionNote(sessionId, userText, assistantText, turn, now = this.now()) {
    const id = String(sessionId || '');
    if (!id) return null;
    const text = String(userText || assistantText || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    const previous = this.store.getSessionNote(id);
    const note = {
      session_id: id,
      summary: summarize(text, 60),
      updated_at: now,
      last_user_at: userText ? now : previous?.last_user_at || 0,
      turn: Number.isFinite(turn) && turn > 0 ? turn : (previous?.turn || 0) + 1,
      source_type: 'agent_inferred',
    };
    this.store.upsertSessionNote(note);
    return note;
  }

  activeSessionNotes(currentSessionId = '', now = this.now()) {
    let live = [];
    try {
      live = this.sessions?.list?.() || [];
    } catch {
      live = [];
    }
    const liveById = new Map(live.map((session) => [String(session.id), session]));
    const presetScoped = this.config.activation !== 'all';
    return this.store
      .listSessionNotes()
      .filter((note) => {
        if (note.session_id === currentSessionId) return false;
        const session = liveById.get(note.session_id);
        if (!session) return false;
        if (presetScoped && String(session.header?.agentPreset || '') !== this.config.presetId) return false;
        return now - note.updated_at <= this.config.sessionHintFreshHours * 3600000;
      })
      .slice(0, this.config.sessionHintMax);
  }

  // ------------------------------------------------ memory fallibility

  getFallibilityAnchors(limit = this.config.fallibilityMaxAnchors) {
    return asArray(this.getScratchpad().fallibility_anchors).slice(0, limit);
  }

  saveFallibilityAnchor(anchor) {
    if (!anchor) return;
    const anchors = asArray(this.getScratchpad().fallibility_anchors);
    const next = [anchor, ...anchors]
      .filter((item, index, list) => list.findIndex((candidate) => candidate.id === item.id) === index)
      .slice(0, this.config.fallibilityMaxAnchors);
    this.saveScratchpad({ fallibility_anchors: next });
  }

  userPortion(text) {
    return String(text || '')
      .split('【我】')[0]
      .replace(/^【用户】\s*/, '')
      .trim();
  }

  fallibilityText(episode, r) {
    const raw = String(episode.level_0_raw || '').trim();
    const summary = String(episode.level_1_summary || '').trim();
    const impression = String(episode.level_2_impression || '').trim();
    const rawUser = this.userPortion(raw);
    const summaryUser = this.userPortion(summary);
    const impressionUser = this.userPortion(impression);
    if (rawUser && r > this.config.fadeThreshold) return rawUser.slice(0, 260);
    if (summaryUser) return summaryUser.slice(0, 220);
    if (impressionUser) return impressionUser.slice(0, 220);
    if (raw && r > this.config.fadeThreshold) return raw.slice(0, 260);
    if (summary) return summary.slice(0, 220);
    return impression.slice(0, 220);
  }

  fallibilityEligible(recalled, now = this.now()) {
    const eligible = [];
    for (const episode of recalled) {
      if (!episode || episode.anchor || episode.source_type === 'dream_generated') continue;
      const { r } = this.bandOf(episode, now);
      if (r < this.config.fallibilityBandMin || r > this.config.fallibilityBandMax) continue;
      const text = [
        episode.level_0_raw,
        episode.level_1_summary,
        episode.level_2_impression,
        asArray(episode.keywords).join(' '),
      ]
        .filter(Boolean)
        .join(' ');
      if (CORE_MEMORY_RE.test(text)) continue;
      if (!DAILY_MEMORY_RE.test(text)) continue;
      eligible.push({ episode, r, text: this.fallibilityText(episode, r) });
    }
    return eligible;
  }

  similarScene(a, b) {
    const scene = jaccard(new Set(asArray(a.keywords)), new Set(asArray(b.keywords)));
    const tone = textSimilarity(a.emotion_tone || '', b.emotion_tone || '');
    const valenceClose = Math.abs((a.e || 0) - (b.e || 0)) <= 0.6;
    return scene >= 0.2 || (tone >= 0.5 && valenceClose);
  }

  firstClause(text) {
    const value = String(text || '').replace(/^[\[【(（][^】\]]*[】\]]\s*/, '');
    const parts = value
      .split(/[。！？!?；;\n]/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 4);
    return (parts[0] || value).slice(0, 120);
  }

  lastClause(text) {
    const sentences = String(text || '')
      .split(/[。！？!?；;\n]/)
      .map((part) => part.trim())
      .filter(Boolean);
    const sentence = sentences[sentences.length - 1] || String(text || '');
    const clauses = sentence
      .split(/[，,]/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 3);
    return (clauses[clauses.length - 1] || sentence).slice(0, 120);
  }

  distortionShadow(episode, r) {
    return {
      id: episode.id,
      source_type: episode.source_type || 'agent_inferred',
      summary: String(
        episode.level_1_summary || episode.level_0_raw || episode.level_2_impression || '',
      ).slice(0, 220),
      impression: String(episode.level_2_impression || '').slice(0, 160),
      raw: episode.level_0_raw ? String(episode.level_0_raw).slice(0, 400) : '',
      emotion_tone: episode.emotion_tone || '平静',
      r: round(r, 3),
    };
  }

  makeDistortion(type, items, payload, now, sessionId) {
    return {
      id: newId('dist'),
      type,
      session_id: String(sessionId || ''),
      at: now,
      awaiting_user: false,
      corrected: false,
      episode_ids: unique(items.map((item) => item.episode.id)),
      shadows: items.map((item) => this.distortionShadow(item.episode, item.r)),
      ...payload,
    };
  }

  rollFallibility(recalled, now, sessionId) {
    if (!this.config.fallibilityEnabled) return null;
    const eligible = this.fallibilityEligible(recalled, now);
    if (!eligible.length) return null;
    const min = this.config.fallibilityChanceMin;
    const max = this.config.fallibilityChanceMax;
    const chance = min + this.random() * (max - min);
    if (this.random() >= chance) return null;
    return this.buildDistortion(eligible, now, sessionId);
  }

  buildDistortion(eligible, now, sessionId, forceType = '') {
    const builders = {
      chimera: () => this.buildChimera(eligible, now, sessionId),
      'tip-of-tongue': () => this.buildTipOfTongue(eligible, now, sessionId),
      'source-confusion': () => this.buildSourceConfusion(eligible, now, sessionId),
      'schema-overwrite': () => this.buildSchemaOverwrite(eligible, now, sessionId),
    };
    const types = Object.keys(builders);
    let start = forceType ? types.indexOf(forceType) : Math.floor(this.random() * types.length);
    if (start < 0) start = 0;
    const ordered = [...types.slice(start), ...types.slice(0, start)];
    for (const type of ordered) {
      try {
        const result = builders[type]();
        if (result) return result;
      } catch (error) {
        this.logger?.warn?.(`[bionic-memory] fallibility operator ${type} failed: ${error?.message || error}`);
      }
      if (forceType) break;
    }
    return null;
  }

  buildChimera(eligible, now, sessionId) {
    const candidates = eligible.filter((item) => item.r < 0.5);
    for (let i = 0; i < candidates.length; i += 1) {
      for (let j = 0; j < candidates.length; j += 1) {
        if (i === j) continue;
        const a = candidates[i];
        const b = candidates[j];
        if (!this.similarScene(a.episode, b.episode)) continue;
        const cause = this.firstClause(a.text);
        const detail = this.lastClause(b.text);
        if (cause.length < 5 || detail.length < 5) continue;
        const text = `我隐约记得：${cause}，后来${detail}。这两件事好像是一起发生的。`.slice(0, 280);
        return this.makeDistortion(
          'chimera',
          [a, b],
          { text, a_id: a.episode.id, b_id: b.episode.id, title: '记忆嫁接' },
          now,
          sessionId,
        );
      }
    }
    return null;
  }

  buildTipOfTongue(eligible, now, sessionId) {
    const candidates = eligible.filter(
      (item) =>
        item.r > this.config.fallibilityBandMin && item.r < this.config.fallibilityTipBandMax,
    );
    for (const item of candidates) {
      const masked = this.maskProperNouns(item.text);
      if (!masked) continue;
      return this.makeDistortion(
        'tip-of-tongue',
        [item],
        { text: masked.text.slice(0, 280), masked_terms: masked.terms, title: '话到嘴边' },
        now,
        sessionId,
      );
    }
    return null;
  }

  maskProperNouns(text) {
    const source = String(text || '');
    if (!source) return null;
    const candidates = [];
    const patterns = [
      /[「“"']([^」”"']{1,20})[」”"']/g,
      /(?:那家|那个|那只|那把|那本|那杯)([\u4e00-\u9fa5A-Za-z0-9]{1,10})/g,
      /([\u4e00-\u9fa5A-Za-z0-9]{2,8}(?:咖啡店|咖啡馆|餐厅|书店|公园|车站|机场|酒店|商场|广场|街道|巷子|大桥|湖边|山顶))/g,
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(source))) candidates.push(match[1]);
    }
    const stop = /^(?:那个|这个|我们|他们|自己|时候|地方|一下|什么|那里|这里)$/;
    const terms = unique(
      candidates
        .map((term) => term.trim())
        .filter((term) => term.length >= 2 && !stop.test(term) && !CORE_MEMORY_RE.test(term)),
    );
    if (!terms.length) return null;
    const term = terms[0];
    return {
      text: source.split(term).join(MASK_PLACEHOLDER),
      terms: [term],
    };
  }

  buildSourceConfusion(eligible, now, sessionId) {
    if (!eligible.length) return null;
    const item = eligible[Math.floor(this.random() * eligible.length)];
    const dream = this.lastDreamCache();
    const dreamFresh = dream && now - (dream.started_at || 0) <= 36 * 3600000;
    let dreamFragment = '';
    if (dreamFresh && this.random() < 0.5) {
      dreamFragment = this.gentleDreamFragment(dream);
    }
    const text = dreamFragment
      ? `我有点分不清：昨晚梦里好像有${dreamFragment}，现实里是不是也发生过？我隐约记得${item.text}。`
      : `我记得好像是你说的，又好像是我自己说的：${item.text}`;
    return this.makeDistortion(
      'source-confusion',
      [item],
      {
        text: text.slice(0, 280),
        dream_fragment: dreamFragment,
        title: dreamFragment ? '现实与梦混淆' : '说话人归属混淆',
      },
      now,
      sessionId,
    );
  }

  gentleDreamFragment(dream) {
    const pool = `${dream?.afterglow || ''} ${dream?.narrative || ''}`
      .split(/[。！？!?\n]/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length >= 6 && sentence.length <= 50);
    const gentle = pool.filter((sentence) => DAILY_MEMORY_RE.test(sentence) && !CORE_MEMORY_RE.test(sentence));
    if (!gentle.length) return '';
    return gentle[Math.floor(this.random() * gentle.length)];
  }

  buildSchemaOverwrite(eligible, now, sessionId) {
    const schemas = this.store
      .listSchemas()
      .filter((schema) => schema.status === 'active' && schema.occurrence_count >= 2);
    if (!schemas.length) return null;
    for (const item of eligible) {
      const tokens = tokenize(
        item.episode.level_0_raw || item.episode.level_1_summary || item.episode.level_2_impression || '',
      );
      let best = null;
      for (const schema of schemas) {
        const lex = jaccard(new Set(tokens), new Set(asArray(schema.keywords)));
        const sim = clamp(cosine(item.episode.vector, schema.vector) * 0.7 + lex * 0.3, 0, 1);
        if (lex >= 0.2 || sim >= 0.45) {
          if (!best || sim > best.sim) best = { schema, sim };
        }
      }
      if (!best) continue;
      const text = `那次应该也是${best.schema.pattern_summary}吧？我记不太清了，只记得大概就是这样。`;
      return this.makeDistortion(
        'schema-overwrite',
        [item],
        {
          text,
          schema_id: best.schema.id,
          schema_summary: best.schema.pattern_summary,
          title: '习惯性脑补',
        },
        now,
        sessionId,
      );
    }
    return null;
  }

  renderShadowTruth(distortion, { visible = false } = {}) {
    const lines = [];
    lines.push(
      `        <shadow_truth_for_correction${visible ? '' : ' visibility="do-not-use-until-the-user-corrects-you"'}>`,
    );
    lines.push(
      '          <instruction>这是未被混淆的真相。只有用户指出你记错、记混，或提醒了那个卡壳的词时，才可以使用这里。</instruction>',
    );
    for (const shadow of asArray(distortion.shadows)) {
      lines.push(
        `          <memory id="${shadow.id}" source_type="${shadow.source_type}" r="${shadow.r}">${xmlEscape(shadow.summary || shadow.impression)}</memory>`,
      );
    }
    if (distortion.schema_id) {
      lines.push(
        `          <habit_schema id="${distortion.schema_id}">${xmlEscape(distortion.schema_summary || '')}</habit_schema>`,
      );
    }
    lines.push('        </shadow_truth_for_correction>');
    return lines;
  }

  renderDistortionBlock(distortion) {
    const lines = [];
    lines.push(`  <distorted_or_chimera_memory type="${distortion.type}" confidence="vague-but-sincere">`);
    if (distortion.type === 'chimera') {
      lines.push(`    <chimera_memory>${xmlEscape(distortion.text)}</chimera_memory>`);
      lines.push('    <note>这是两段记忆被嫁接后的印象；你暂时觉得它是一条完整的记忆。</note>');
    } else if (distortion.type === 'tip-of-tongue') {
      lines.push(`    <masked_memory>${xmlEscape(distortion.text)}</masked_memory>`);
      lines.push('    <note>那个名字就在嘴边，但怎么也想不起来；只能描述大概特征。</note>');
    } else if (distortion.type === 'source-confusion') {
      lines.push(`    <confused_memory>${xmlEscape(distortion.text)}</confused_memory>`);
      lines.push('    <note>你分不清这是用户说的、自己说的，还是昨晚梦里的。</note>');
    } else {
      lines.push(`    <overwritten_memory>${xmlEscape(distortion.text)}</overwritten_memory>`);
      lines.push('    <note>你用这个人一贯的习惯，自动补上了那一次缺失的细节。</note>');
    }
    lines.push(...this.renderShadowTruth(distortion));
    lines.push('  </distorted_or_chimera_memory>');
    return lines;
  }

  renderCorrectionBlock(distortion) {
    const lines = [];
    lines.push('  <memory_fallibility_correction active="true">');
    lines.push(
      '    <instruction>用户刚刚指出你记错了/记混了，或提醒了你卡壳的词。先是一愣，再拍脑袋恍然大悟，承认自己记串了或脑子生锈了；不要嘴硬，也不要继续坚持刚才那个错误版本。</instruction>',
    );
    lines.push(...this.renderShadowTruth(distortion, { visible: true }));
    if (distortion.anchor_text) {
      lines.push(`    <fallibility_anchor>${xmlEscape(distortion.anchor_text)}</fallibility_anchor>`);
    }
    lines.push('  </memory_fallibility_correction>');
    return lines;
  }

  looksLikeCorrection(text, distortion) {
    const value = String(text || '');
    if (!value) return false;
    if (distortion?.type === 'tip-of-tongue') {
      if (asArray(distortion.masked_terms).some((term) => term && value.includes(term))) return true;
    }
    if (CORRECTION_MARKERS_RE.test(value)) return true;
    if (distortion?.type === 'chimera') {
      if (asArray(distortion.episode_ids).some((id) => value.includes(id))) return true;
    }
    return false;
  }

  noteUserMessage(sessionId = '', text = '') {
    const id = String(sessionId || '');
    this.fallibilityChecked.delete(id);
    const distortion = this.activeDistortions.get(id);
    if (!distortion || distortion.corrected) return null;
    if (this.now() - distortion.at > this.config.fallibilityTtlMs) {
      this.activeDistortions.delete(id);
      return null;
    }
    // The user message is always checked even if the debounced turn-end flush
    // has not marked the distortion as awaiting yet; a fast correction must not
    // be lost to the flush timing.
    if (this.looksLikeCorrection(text, distortion)) {
      return this.correctDistortion(distortion, text);
    }
    this.activeDistortions.delete(id);
    return null;
  }

  correctDistortion(distortion, text = '') {
    if (!distortion || distortion.corrected) return distortion || null;
    const now = this.now();
    distortion.corrected = true;
    distortion.corrected_at = now;
    distortion.correction_text = shortRule(text, 200);
    for (const shadow of asArray(distortion.shadows)) {
      const episode = this.store.getEpisode(shadow.id);
      if (!episode) continue;
      const patch = {
        k: (Number(episode.k) || 0) + 2,
        t_last: now,
        last_exposed: now,
        faded: 0,
      };
      if (!episode.level_0_raw && shadow.raw) patch.level_0_raw = shadow.raw;
      if (!episode.level_1_summary && shadow.summary) patch.level_1_summary = shadow.summary;
      if (!episode.level_2_impression && shadow.impression) patch.level_2_impression = shadow.impression;
      this.store.updateEpisode(shadow.id, patch);
    }
    const anchor = this.makeFallibilityAnchor(distortion);
    distortion.anchor_text = anchor.text;
    this.saveFallibilityAnchor(anchor);
    this.journal('snapback', anchor.text, text, distortion.session_id);
    return distortion;
  }

  makeFallibilityAnchor(distortion) {
    const shorts = asArray(distortion.shadows).map((shadow) =>
      shortRule(shadow.summary || shadow.impression || '一件事', 28),
    );
    let text;
    if (distortion.type === 'chimera') {
      text = `[曾把「${shorts[0] || '一件事'}」与「${shorts[1] || '另一件事'}」记混被纠正] 是用户提醒我，我才把两件事拆开。`;
    } else if (distortion.type === 'tip-of-tongue') {
      text = `[曾把「${asArray(distortion.masked_terms)[0] || '那个名字'}」卡在嘴边被提醒] 原来那个词就是它。`;
    } else if (distortion.type === 'source-confusion') {
      text = distortion.dream_fragment
        ? '[曾把现实与梦记混被纠正] 梦里的碎片被当成了现实。'
        : '[曾分不清是谁说的话被纠正] 原来那是用户说的，不是我说的。';
    } else {
      text = `[曾用习惯脑补了那次的例外被纠正] ${
        distortion.schema_summary ? `不是每次都「${shortRule(distortion.schema_summary, 30)}」` : '那次其实是个例外'
      }。`;
    }
    return {
      id: newId('fap'),
      text: shortRule(text, 360),
      at: this.now(),
      type: distortion.type,
      episode_ids: distortion.episode_ids,
    };
  }

  // ------------------------------------------------------------- retention

  retention(episode, now = this.now()) {
    const hours = Math.max(0, now - episode.t_last) / 3600000;
    const baseS0 = episode.s_0 * (this.config.s0Multiplier || 1);
    const denominator = Math.max(0.001, baseS0 * episode.e * (1 + 0.3 * episode.k));
    return clamp(Math.exp(-hours / denominator), 0, 1);
  }

  bandOf(episode, now = this.now()) {
    const r = this.retention(episode, now);
    if (r > this.config.clearThreshold && episode.level_0_raw) return { r, band: 'clear' };
    if (r > this.config.fadeThreshold && (episode.level_1_summary || episode.level_0_raw)) {
      return { r, band: 'summarized' };
    }
    return { r, band: 'faded' };
  }

  decayAll(now = this.now(), { force = false } = {}) {
    const last = this.store.getMeta('last_decay_at', 0) || 0;
    this.degradeHabits(now);
    if (!force && now - last < this.config.decayIntervalMs) return { faded: 0, skipped: true };
    let faded = 0;
    for (const episode of this.store.listEpisodes()) {
      const r = this.retention(episode, now);
      if (r <= this.config.fadeThreshold && (episode.level_0_raw || episode.level_1_summary)) {
        this.store.updateEpisode(episode.id, { level_0_raw: null, level_1_summary: null, faded: 1 });
        faded += 1;
      }
    }
    this.store.setMeta('last_decay_at', now);
    if (faded > 0) this.journal('fade', `${faded} 条情景记忆跌破保留率阈值，细节已物理清空`);
    return { faded, skipped: false };
  }

  degradeHabits(now = this.now()) {
    const degraded = [];
    for (const schema of this.store.listSchemas()) {
      if (schema.status !== 'active') continue;
      const idleHours = (now - schema.last_triggered) / 3600000;
      const span = Math.max(0, schema.last_triggered - schema.created_at) / 3600000;
      const avg = schema.avg_interval_hours > 0 ? schema.avg_interval_hours : Math.max(0.5, span / Math.max(1, schema.occurrence_count - 1));
      if (idleHours > Math.max(this.config.habitDegradeMinHours, avg * 3)) {
        this.store.updateSchema(schema.id, { status: 'historical' });
        const topic = asArray(schema.keywords).slice(0, 2).join('、') || schema.pattern_summary.slice(0, 12);
        this.addCuriosity(
          `「${topic}」这个规律已经很久没出现了，可以自然地问一句最近这块是不是变了。`,
          `habit:${schema.id}`,
        );
        this.journal('habit_degrade', `习惯降级为历史旧印象：${schema.pattern_summary}`);
        degraded.push(schema.id);
      }
    }
    return degraded;
  }

  // -------------------------------------------------------------- ingestion

  formatRaw(userText, assistantText) {
    const user = String(userText || '').trim();
    const assistant = String(assistantText || '').trim();
    const parts = [];
    if (user) parts.push(`【用户】${user}`);
    if (assistant) parts.push(`【我】${assistant}`);
    return parts.join('\n').trim();
  }

  bestSchema(vector, tokens) {
    let best = null;
    for (const schema of this.store.listSchemas()) {
      if (schema.status !== 'active') continue;
      const lex = jaccard(new Set(tokens), new Set(asArray(schema.keywords)));
      const sim = clamp(cosine(vector, schema.vector) * 0.7 + lex * 0.3, 0, 1);
      if (!best || sim > best.sim) best = { schema, sim };
    }
    return best;
  }

  /**
   * A very stable habit plus a topic-similar contradiction is not a repeat:
   * it is a belief violation that must rewrite the schema immediately.
   */
  detectDissonance(text, vector, tokens) {
    const best = this.bestSchema(vector, tokens);
    if (!best) return null;
    const tokenSet = new Set(tokens);
    const sharedKeywords = asArray(best.schema.keywords).filter((keyword) => tokenSet.has(keyword)).length;
    // A paraphrase may fall below the general habit-similarity threshold while
    // still clearly contradicting the same topic; two shared habit keywords
    // plus an explicit negation is enough to count as a belief violation.
    if (best.sim < this.config.habitSimilarity && sharedKeywords < 2) return null;
    if (best.schema.stability_score <= 0.8) return null;
    if (!CONTRADICTION_RE.test(text)) return null;
    return best;
  }

  applyDissonance(schema, episode, now = this.now()) {
    this.store.updateSchema(schema.id, { status: 'historical' });
    this.addCuriosity(
      `「${schema.pattern_summary}」这条旧习惯刚刚被正面反驳，先别急着用旧结论；可以自然问问用户最近是不是改了主意。`,
      `dissonance:${schema.id}`,
    );
    this.store.addEdge({
      at: now,
      from_kind: 'habit',
      from_id: schema.id,
      to_kind: 'episode',
      to_id: episode.id,
      relation: 'contradicted_by',
      weight: 1,
    });
    this.journal(
      'dissonance',
      `认知失调：稳固习惯被反驳并降级为历史旧印象：${schema.pattern_summary}`,
      episode.level_2_impression,
      episode.session_id,
    );
    return schema;
  }

  noveltyScore(vector, tokens) {
    let max = 0;
    for (const episode of this.store.listEpisodes()) {
      const lex = jaccard(new Set(tokens), new Set(asArray(episode.keywords)));
      const sim = clamp(cosine(vector, episode.vector) * 0.7 + lex * 0.3, 0, 1);
      if (sim > max) max = sim;
    }
    for (const schema of this.store.listSchemas()) {
      const lex = jaccard(new Set(tokens), new Set(asArray(schema.keywords)));
      const sim = clamp(cosine(vector, schema.vector) * 0.7 + lex * 0.3, 0, 1);
      if (sim > max) max = sim;
    }
    return max;
  }

  episodeSimilarity(a, b) {
    const lex = jaccard(new Set(asArray(a.keywords)), new Set(asArray(b.keywords)));
    return clamp(cosine(a.vector, b.vector) * 0.7 + lex * 0.3, 0, 1);
  }

  /**
   * Connected component around `seed` in the similarity graph. Using a
   * component rather than "similar to the seed" lets the organ-folding
   * threshold stay meaningful for paraphrased repeats that chain together.
   */
  clusterFrom(seed, pool, threshold = this.config.collapseSimilarity) {
    const visited = new Set([seed.id]);
    const component = [seed];
    const queue = [seed];
    while (queue.length) {
      const current = queue.shift();
      for (const candidate of pool) {
        if (visited.has(candidate.id) || candidate.anchor) continue;
        if (this.episodeSimilarity(current, candidate) >= threshold) {
          visited.add(candidate.id);
          component.push(candidate);
          queue.push(candidate);
        }
      }
    }
    return component;
  }

  /**
   * Turn one completed exchange into memory.
   * Returns what happened so the caller can log it.
   */
  async ingestTurn({
    session_id = '',
    turn = 0,
    user_text = '',
    assistant_text = '',
    source = 'session',
    source_type = '',
    historical = false,
    at = 0,
    user_at = 0,
    assistant_at = 0,
  } = {}) {
    const now = historical && Number(at) > 0 ? Number(at) : this.now();
    const raw = this.formatRaw(user_text, assistant_text);
    if (!raw || raw.length < 4) return { stored: false, reason: 'empty' };

    if (!historical && this.voiceEngine) {
      const sessionKey = String(session_id);
      const previousPair = this.recentTurnPairs.get(sessionKey) || null;
      try {
        this.voiceEngine.observeTurn({
          session_id: sessionKey,
          turn,
          user_text,
          assistant_text,
          user_at,
          assistant_at,
          previousPair,
          episodes: this.store.listEpisodes().length,
          dreams: this.store.listDreams().length,
          now,
        });
        this.store.setMeta('familiarity_score', this.voiceEngine.state.familiarity.score);
      } catch (error) {
        this.logger?.warn?.(`[bionic-memory] voice observation failed: ${error?.message || error}`);
      }
      this.recentTurnPairs.set(sessionKey, {
        user_text: String(user_text || ''),
        assistant_text: String(assistant_text || ''),
        turn,
        at: now,
        user_at: Number(user_at) || now,
        assistant_at: Number(assistant_at) || now,
      });
    }

    // Distortion lifecycle: it survives the turn that produced it so the next
    // user message can be checked for a correction; once that next turn ends,
    // it is retired even if the user never noticed the false memory. Historical
    // backfill must not consume or create live distortion state.
    if (!historical) {
      const activeDistortion = this.activeDistortions.get(String(session_id));
      if (activeDistortion) {
        if (now - activeDistortion.at > this.config.fallibilityTtlMs) {
          this.activeDistortions.delete(String(session_id));
        } else if (activeDistortion.awaiting_user) {
          if (!activeDistortion.corrected && this.looksLikeCorrection(user_text, activeDistortion)) {
            this.correctDistortion(activeDistortion, user_text);
          }
          this.activeDistortions.delete(String(session_id));
        } else {
          activeDistortion.awaiting_user = true;
        }
      }
      this.fallibilityChecked.delete(String(session_id));
    }

    const senti = sentiment(`${user_text}\n${assistant_text}`);
    const tokens = tokenize(raw);
    const vector = vectorize(tokens);
    const keywordList = keywords(raw, 10);
    const novelty = this.noveltyScore(vector, tokens);
    // Prediction error should fall quickly as a memory echo gets stronger:
    // a near-repeat is not "surprising" merely because wording differs.
    let n = clamp(0.1 + (1 - novelty) ** 2 * 1.4 + senti.surpriseBoost, 0.1, 2.0);
    const resolvedSource = this.normalizeSourceType(
      source_type || (String(user_text || '').trim() ? 'user_stated' : 'agent_inferred'),
    );

    // A contradiction against a very stable habit is a belief violation, not a
    // repeat: force maximum surprise and stop the habituation path.
    const dissonance = this.detectDissonance(raw, vector, tokens);
    if (dissonance) n = 2.0;

    if (!historical) {
      this.noteUserActivity();
      this.updateMoodFrom(senti);
      this.reconsolidate(session_id, senti, now);
      this.updateSessionNote(session_id, user_text, assistant_text, turn, now);
      try {
        this.metaEvolver?.observeTurn({
          session_id,
          turn,
          user_text,
          assistant_text,
          now,
          injection: this.injections.get(String(session_id)) || null,
        });
      } catch (error) {
        this.logger?.warn?.(`[bionic-memory] meta telemetry failed: ${error?.message || error}`);
      }
    }

    // Repetitive compression at ingestion: an unremarkable repeat is dropped
    // and only the habit's occurrence counter moves.
    const habit = this.bestSchema(vector, tokens);
    if (!dissonance && habit && habit.sim >= this.config.habitSimilarity && n < this.config.habituationSurprise) {
      const lastTriggered = now;
      const span = Math.max(0, lastTriggered - habit.schema.created_at) / 3600000;
      const occurrence = habit.schema.occurrence_count + 1;
      this.store.updateSchema(habit.schema.id, {
        occurrence_count: occurrence,
        last_triggered: lastTriggered,
        stability_score: clamp(habit.schema.stability_score + 0.02, 0, 0.98),
        avg_interval_hours: round(span / Math.max(1, occurrence - 1), 2),
      });
      this.journal('habit_hit', `习惯化丢弃：${habit.schema.pattern_summary}`, raw, session_id);
      return {
        stored: false,
        habituated: true,
        schema_id: habit.schema.id,
        similarity: round(habit.sim, 3),
        surprise: round(n, 2),
      };
    }

    const episode = {
      id: newId('ep'),
      session_id,
      turn,
      t_created: now,
      t_last: now,
      s_0: clamp(this.config.defaultS0 * (0.75 + n * 0.5), 12, 168),
      e: senti.e,
      n: round(n, 2),
      k: 0,
      level_0_raw: raw.slice(0, this.config.maxRawChars),
      level_1_summary: summarize(raw, this.config.summaryChars),
      level_2_impression: impressionOf(raw, senti.tone, keywordList, this.config.impressionChars),
      emotion_tone: senti.tone,
      source_type: resolvedSource,
      vector,
      keywords: keywordList,
      schema_id: null,
      anchor: 0,
      faded: 0,
      last_exposed: 0,
    };
    this.store.insertEpisode(episode);
    this.journal('episode', episode.level_2_impression, raw, session_id);
    this.journal('turn', `${senti.tone} · ${keywordList.slice(0, 3).join('、') || '一段对话'}`, raw, session_id);
    if (dissonance) this.applyDissonance(dissonance.schema, episode, now);

    this.linkRecent(episode);
    if (habit) {
      this.store.addEdge({
        at: now,
        from_kind: 'episode',
        from_id: episode.id,
        to_kind: 'habit',
        to_id: habit.schema.id,
        relation: 'similar_to',
        weight: round(habit.sim, 3),
      });
    }

    let collapsed = null;
    const pool = this.store.listEpisodes().filter((other) => other.id !== episode.id);
    const group = this.clusterFrom(episode, pool);
    if (group.length >= this.config.collapseThreshold) {
      collapsed = this.collapseGroup(group, { via: 'ingest' });
    }

    return {
      stored: true,
      episode_id: episode.id,
      emotion: senti.e,
      surprise: round(n, 2),
      collapsed: collapsed ? collapsed.id : null,
      source,
      historical,
    };
  }

  /**
   * Backfill one turn that was collapsed out of the live context window.
   * The live observer normally already stored it; dedupe by (session, turn)
   * prevents double episodes, while a missing turn is ingested with its
   * original timestamp and without touching live mood/telemetry/distortion.
   */
  async ingestHistoricalTurn({
    session_id = '',
    turn = 0,
    user_text = '',
    assistant_text = '',
    at = 0,
  } = {}) {
    if (!String(user_text || '').trim() && !String(assistant_text || '').trim()) {
      return { stored: false, reason: 'empty' };
    }
    const existing = this.store.findEpisodeByTurn?.(session_id, turn);
    if (existing) return { stored: false, duplicate: true, episode_id: existing.id };
    return this.ingestTurn({
      session_id,
      turn,
      user_text,
      assistant_text,
      source: 'context-metabolism',
      source_type: String(user_text || '').trim() ? 'user_stated' : 'agent_inferred',
      historical: true,
      at: at || this.now(),
    });
  }

  linkRecent(episode) {
    const recent = this.store
      .listEpisodes()
      .filter((other) => other.id !== episode.id && episode.t_created - other.t_created < 3 * 3600000)
      .slice(-4);
    for (const other of recent) {
      const weight = this.episodeSimilarity(episode, other);
      if (weight < 0.25) continue;
      this.store.addEdge({
        at: this.now(),
        from_kind: 'episode',
        from_id: episode.id,
        to_kind: 'episode',
        to_id: other.id,
        relation: 'temporal',
        weight: round(weight, 3),
      });
    }
  }

  // ------------------------------------------------------- organ folding

  anchorMeta(episode) {
    return {
      date: isoDate(episode.t_created),
      brief: episode.level_2_impression || episode.level_1_summary || '一次没被折叠掉的意外',
      episode_id: episode.id,
      emotion: round(episode.e, 2),
      surprise: round(episode.n, 2),
    };
  }

  anchorScore(episode) {
    return episode.e * 0.65 + episode.n * 0.35;
  }

  collapseGroup(group, { via = 'ingest' } = {}) {
    const episodes = group
      .filter((episode, index, list) => episode && list.findIndex((item) => item.id === episode.id) === index)
      .filter((episode) => episode.source_type !== 'dream_generated');
    if (episodes.length < 2) return null;
    const now = this.now();
    const sorted = episodes.slice().sort((a, b) => this.anchorScore(b) - this.anchorScore(a));
    let anchor = sorted[0];
    const rest = sorted.slice(1);

    const keywordCounts = new Map();
    for (const episode of episodes) {
      for (const keyword of unique(asArray(episode.keywords))) {
        keywordCounts.set(keyword, (keywordCounts.get(keyword) || 0) + 1);
      }
    }
    const commonKeywords = [...keywordCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([keyword]) => keyword);

    let existing = null;
    const meanVector = averageVector(episodes.map((episode) => episode.vector));
    for (const schema of this.store.listSchemas()) {
      if (cosine(meanVector, schema.vector) >= 0.72) {
        existing = schema;
        break;
      }
    }

    if (existing) {
      const existingAnchor = asArray(existing.exception_anchors)[0];
      const existingEpisode = existingAnchor?.episode_id ? this.store.getEpisode(existingAnchor.episode_id) : null;
      if (existingEpisode && this.anchorScore(existingEpisode) > this.anchorScore(anchor)) {
        anchor = existingEpisode;
      }
      const occurrence = existing.occurrence_count + episodes.length;
      const stability = clamp(existing.stability_score + 0.04, 0, 0.98);
      const anchors = [this.anchorMeta(anchor)];
      this.store.updateSchema(existing.id, {
        occurrence_count: occurrence,
        last_triggered: now,
        stability_score: stability,
        exception_anchors: anchors,
        source_type:
          existing.source_type === 'user_stated' || episodes.every((episode) => episode.source_type === 'user_stated')
            ? 'user_stated'
            : 'agent_inferred',
        status: 'active',
        avg_interval_hours: round((now - existing.created_at) / 3600000 / Math.max(1, occurrence - 1), 2),
      });
      const removeIds = episodes.filter((episode) => episode.id !== anchor.id).map((episode) => episode.id);
      if (anchor.schema_id !== existing.id || !anchor.anchor) {
        this.store.updateEpisode(anchor.id, { schema_id: existing.id, anchor: 1 });
      }
      this.store.deleteEpisodes(removeIds);
      this.store.addEdge({
        at: now,
        from_kind: 'habit',
        from_id: existing.id,
        to_kind: 'episode',
        to_id: anchor.id,
        relation: 'exception',
        weight: 1,
      });
      this.journal('collapse', `风琴折叠并入既有习惯：${existing.pattern_summary}（+${episodes.length}）`);
      return existing;
    }

    const schema = {
      id: newId('sch'),
      created_at: now,
      last_triggered: now,
      occurrence_count: episodes.length,
      stability_score: clamp(0.5 + episodes.length * 0.06, 0.5, 0.95),
      pattern_summary: habitusSummary(commonKeywords),
      source_text: episodes
        .slice(0, 3)
        .map((episode) => episode.level_2_impression)
        .filter(Boolean)
        .join(' / ')
        .slice(0, 600),
      vector: meanVector,
      keywords: commonKeywords,
      exception_anchors: [this.anchorMeta(anchor)],
      source_type: episodes.every((episode) => episode.source_type === 'user_stated') ? 'user_stated' : 'agent_inferred',
      status: 'active',
      avg_interval_hours: round(
        (Math.max(...episodes.map((episode) => episode.t_created)) - Math.min(...episodes.map((episode) => episode.t_created))) /
          3600000 /
          Math.max(1, episodes.length - 1),
        2,
      ),
    };
    this.store.insertSchema(schema);
    const removeIds = episodes.filter((episode) => episode.id !== anchor.id).map((episode) => episode.id);
    this.store.updateEpisode(anchor.id, { schema_id: schema.id, anchor: 1 });
    this.store.deleteEpisodes(removeIds);
    this.store.addEdge({
      at: now,
      from_kind: 'habit',
      from_id: schema.id,
      to_kind: 'episode',
      to_id: anchor.id,
      relation: 'exception',
      weight: 1,
    });
    this.journal(
      'collapse',
      `风琴折叠：${episodes.length} 条情景坍缩为习惯「${schema.pattern_summary}」，保留例外锚点`,
    );
    return schema;
  }

  collapseSweep(now = this.now()) {
    const pool = this.store.listEpisodes().filter((episode) => !episode.anchor);
    const visited = new Set();
    const created = [];
    for (const base of pool) {
      if (visited.has(base.id)) continue;
      const component = this.clusterFrom(base, pool);
      for (const episode of component) visited.add(episode.id);
      if (component.length >= this.config.collapseThreshold) {
        const schema = this.collapseGroup(component, { via: 'nrem' });
        if (schema) created.push(schema);
      }
    }
    return created;
  }

  // -------------------------------------------------------------- retrieval

  currentQuery(sessionId) {
    try {
      const session = this.sessions?.get?.(sessionId);
      if (!session || typeof session.deriveMessages !== 'function') return '';
      const messages = session.deriveMessages();
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message?.role !== 'user') continue;
        const text = textOfContent(message.content);
        if (text) return text;
      }
    } catch {
      /* a session that cannot be read simply contributes no query */
    }
    return '';
  }

  recall(query, { limit = 16 } = {}) {
    const now = this.now();
    const tokens = tokenize(query || '');
    const vector = vectorize(tokens);
    const tokenSet = new Set(tokens);
    return this.store
      .listEpisodes()
      .map((episode) => {
        const lex = jaccard(tokenSet, new Set(asArray(episode.keywords)));
        const semantic = tokens.length ? clamp(cosine(vector, episode.vector) * 0.7 + lex * 0.3, 0, 1) : 0;
        const ageDays = Math.max(0, now - episode.t_created) / 86400000;
        const recency = 1 / (1 + ageDays / 14);
        const score =
          (tokens.length ? semantic * 0.55 : 0) +
          recency * 0.2 +
          clamp(episode.e / 2, 0, 1) * 0.15 +
          clamp(episode.n / 2, 0, 1) * 0.1;
        return { ...episode, _similarity: semantic, _score: score, _retention: this.retention(episode, now) };
      })
      .filter((episode) => !tokens.length || episode._similarity >= this.config.similarityThreshold)
      .sort((a, b) => b._score - a._score)
      .slice(0, Math.max(1, limit));
  }

  awake(exposed, now = this.now(), sessionId = '') {
    const seen = new Set();
    const awakenedIds = [];
    for (const episode of exposed) {
      if (!episode || seen.has(episode.id)) continue;
      seen.add(episode.id);
      if (now - episode.t_last < this.config.recallWakeCooldownMs) continue;
      if (now - (episode.last_exposed || 0) < this.config.recallWakeCooldownMs) continue;
      this.store.updateEpisode(episode.id, {
        t_last: now,
        k: episode.k + 1,
        last_exposed: now,
      });
      awakenedIds.push(episode.id);
    }
    if (awakenedIds.length) {
      this.pendingReconsolidation.push({ session_id: sessionId, ids: awakenedIds, at: now });
      if (this.pendingReconsolidation.length > 20) this.pendingReconsolidation.shift();
    }
  }

  /**
   * Reconsolidation: a retrieved old memory is repainted by the emotional tone
   * at the end of the turn that retrieved it, and its wake time is refreshed.
   */
  reconsolidate(sessionId, senti, now = this.now()) {
    if (!this.pendingReconsolidation.length) return { updated: 0 };
    const cutoff = now - this.config.reconsolidationWindowMs;
    const usable = this.pendingReconsolidation.filter(
      (entry) => entry.at >= cutoff && (!sessionId || !entry.session_id || entry.session_id === sessionId),
    );
    const ids = [...new Set(usable.flatMap((entry) => entry.ids))];
    let updated = 0;
    for (const id of ids) {
      const episode = this.store.getEpisode(id);
      if (!episode) continue;
      if (now - episode.t_created < 3600000) continue;
      const nextTone = reconsolidationTone(episode.emotion_tone, senti.tone);
      this.store.updateEpisode(id, { emotion_tone: nextTone, t_last: now });
      updated += 1;
    }
    this.pendingReconsolidation = this.pendingReconsolidation.filter(
      (entry) => entry.at < cutoff || (sessionId && entry.session_id && entry.session_id !== sessionId),
    );
    if (updated) {
      this.journal('reconsolidation', `${updated} 条旧记忆在「${senti.tone}」的对话基调下被再巩固`);
    }
    return { updated };
  }

  // ------------------------------------------------------- daily frozen tier

  loadDailyFrozen() {
    try {
      const block = readTier1(this.dataDir);
      if (block) {
        this.dailyBlock = block;
        try {
          const meta = JSON.parse(fs.readFileSync(this.dailyMetaFile, 'utf8'));
          this.dailyDay = String(meta.day || '');
          this.dailyAt = Number(meta.compiled_at) || 0;
        } catch {
          this.dailyDay = isoDate(this.now());
          this.dailyAt = 0;
        }
        return this.dailyBlock;
      }
    } catch (error) {
      this.logger?.warn?.(`[bionic-memory] daily frozen memory load failed: ${error?.message || error}`);
    }
    return this.compileDailyFrozenMemory({ reason: 'boot' });
  }

  dailyFrozenBlock() {
    return this.dailyBlock || '';
  }

  tierHashes() {
    return {
      tier0: createHash('sha256').update(String(this.basePrompt || '')).digest('hex'),
      tier1: createHash('sha256').update(String(this.dailyBlock || '')).digest('hex'),
      tierTools: String(this.toolSchemaHash || ''),
      tier1_at: this.dailyAt || 0,
    };
  }

  compileDailyFrozenMemory({ reason = 'dream', dream = null } = {}) {
    const now = this.now();
    const skills = this.store
      .listSkills()
      .filter((skill) => skill.active)
      .sort((a, b) => String(a.rule).localeCompare(String(b.rule), 'zh') || b.confidence - a.confidence)
      .slice(0, this.config.maxSkills);
    const habits = this.store
      .listSchemas()
      .filter((schema) => schema.status === 'active')
      .sort(
        (a, b) =>
          String(a.pattern_summary).localeCompare(String(b.pattern_summary), 'zh') ||
          b.occurrence_count - a.occurrence_count,
      )
      .slice(0, Math.min(5, this.config.maxHabits));
    const scratchpad = this.getScratchpad();
    const afterglow = String(dream?.afterglow || scratchpad.dream_afterglow || '').trim();
    const guidance = (this.metaEvolver?.activeGuidance || []).slice(0, 4);
    const lines = ['<daily_frozen_memory>'];
    lines.push('  <procedural_skills>');
    if (skills.length) {
      for (const skill of skills) {
        lines.push(`    - [本能经验] ${xmlEscape(skill.rule)}（置信度 ${round(skill.confidence, 2)}）`);
      }
    } else {
      lines.push('    - （还没有内化的本能）');
    }
    lines.push('  </procedural_skills>');
    lines.push('  <stable_habits>');
    if (habits.length) {
      for (const schema of habits) {
        lines.push(
          `    - [长期习惯/规律] ${xmlEscape(schema.pattern_summary)}（已重复发生 ${schema.occurrence_count} 次，平庸细节已遗忘）`,
        );
        const anchor = asArray(schema.exception_anchors)[0];
        if (anchor) lines.push(`      * 唯独记得的一次例外/高光: (${anchor.date}) ${xmlEscape(anchor.brief)}`);
      }
    } else {
      lines.push('    - （还没有稳固的长期习惯）');
    }
    lines.push('  </stable_habits>');
    if (afterglow) lines.push(`  <dream_afterglow>${xmlEscape(afterglow)}</dream_afterglow>`);
    if (guidance.length) {
      lines.push('  <evolved_expression_guidance>');
      for (const item of guidance) lines.push(`    - ${xmlEscape(item)}`);
      lines.push('  </evolved_expression_guidance>');
    }
    const voiceProfile = this.voiceEngine?.profileBlock?.() || '';
    if (voiceProfile) lines.push(voiceProfile);
    lines.push('</daily_frozen_memory>');
    const block = lines.join('\n');
    this.dailyBlock = block;
    this.dailyDay = isoDate(now);
    this.dailyAt = now;
    try {
      writeTier1(this.dataDir, block, {
        version: 1,
        day: this.dailyDay,
        compiled_at: this.dailyAt,
        reason,
        hash: createHash('sha256').update(block).digest('hex'),
      });
    } catch (error) {
      this.logger?.warn?.(`[bionic-memory] daily frozen memory write failed: ${error?.message || error}`);
    }
    this.journal('daily_frozen', `每日冻结记忆已编译（${reason}）：${skills.length} 条本能 / ${habits.length} 个习惯 / 语感档案`);
    return block;
  }

  async reflectVoice({ signal } = {}) {
    if (!this.voiceEngine) return { notes: [], moments: [], source: 'disabled' };
    return this.voiceEngine.reflect({ llm: this.llm, now: this.now(), signal });
  }

  renderEphemeral({ session_id = '', query = '' } = {}) {
    const context = this.renderContext({ session_id, queryOverride: query, omitDaily: true });
    const metabolism = this.contextMetabolism?.contextText?.({ id: session_id }) || '';
    if (!context && !metabolism) return '';
    return [
      '<ephemeral_subconscious_flashback>',
      '（以下是我的潜意识闪回，不是用户新说的话；如果出现过期快照，以最末尾这一块为准。）',
      context,
      metabolism,
      '</ephemeral_subconscious_flashback>',
    ]
      .filter(Boolean)
      .join('\n');
  }

  renderContext({ session_id = '', queryOverride = '', omitDaily = false } = {}) {
    try {
      const now = this.now();
      if (now - (this.store.getMeta('last_decay_at', 0) || 0) > this.config.decayIntervalMs) {
        this.decayAll(now);
      }
      const query = queryOverride || this.currentQuery(session_id);
      const recalled = this.recall(query, { limit: 24 });

      let distortion = this.activeDistortions.get(String(session_id)) || null;
      if (distortion && now - distortion.at > this.config.fallibilityTtlMs) {
        this.activeDistortions.delete(String(session_id));
        distortion = null;
      }
      // A distortion belongs to the turn that produced it. If the next turn
      // began without a correction, drop it instead of repeating the false
      // memory; a corrected one stays for one correction prompt.
      if (distortion && distortion.awaiting_user && !distortion.corrected) {
        this.activeDistortions.delete(String(session_id));
        distortion = null;
      }
      if (!distortion) {
        const key = String(session_id);
        if (!this.fallibilityChecked.has(key)) {
          this.fallibilityChecked.add(key);
          distortion = this.rollFallibility(recalled, now, session_id);
          if (distortion) this.activeDistortions.set(key, distortion);
        }
      }

      const clear = [];
      const summarized = [];
      const faded = [];
      for (const episode of recalled) {
        const { r, band } = this.bandOf(episode, now);
        const item = { ...episode, _r: r, _band: band };
        if (band === 'clear') {
          if (clear.length < this.config.maxClear) clear.push(item);
        } else if (band === 'summarized') {
          if (summarized.length < this.config.maxSummarized) summarized.push(item);
        } else if (faded.length < this.config.maxFaded) {
          faded.push(item);
        }
      }
      const awakeEpisodes = [...clear, ...summarized, ...faded];
      if (distortion && !distortion.corrected) {
        const hiddenIds = new Set(distortion.episode_ids);
        for (const bucket of [clear, summarized, faded]) {
          for (let index = bucket.length - 1; index >= 0; index -= 1) {
            if (hiddenIds.has(bucket[index].id)) bucket.splice(index, 1);
          }
        }
      }

      const queryVector = vectorize(tokenize(query || ''));
      const habits = this.store
        .listSchemas()
        .filter((schema) => schema.status === 'active')
        .map((schema) => {
          const lex = jaccard(new Set(tokenize(query || '')), new Set(asArray(schema.keywords)));
          const sim = query ? clamp(cosine(queryVector, schema.vector) * 0.7 + lex * 0.3, 0, 1) : 0;
          return { ...schema, _match: sim };
        })
        .sort((a, b) => b._match - a._match || b.stability_score - a.stability_score)
        .slice(0, this.config.maxHabits);

      const skills = this.store
        .listSkills()
        .filter((skill) => skill.active)
        .sort((a, b) => b.confidence - a.confidence || b.created_at - a.created_at)
        .slice(0, this.config.maxSkills);

      // Only skills that resonate with the current query count as triggered;
      // the rest age out in NREM and fall back into the ordinary graph.
      if (query) {
        for (const skill of skills) {
          if (now - (skill.last_used || 0) < 3600000) continue;
          if (textSimilarity(skill.rule, query) >= this.config.skillTriggerSimilarity) {
            this.store.updateSkill(skill.id, { hits: skill.hits + 1, last_used: now });
          }
        }
      }

      const scratchpad = this.getScratchpad();
      const lastContact = this.store.getMeta('last_user_contact_at', 0) || 0;
      const lastDreamAt = this.store.getMeta('last_dream_at', 0) || 0;
      const afterglowFresh = scratchpad.dream_afterglow && now - (scratchpad.dream_at || 0) < 36 * 3600000;
      const hooks = asArray(scratchpad.curiosity_hooks)
        .filter((hook) => !hook.resolved)
        .slice(0, this.config.maxCuriosity);
      const fallibilityAnchors = this.getFallibilityAnchors(3);
      const parallelNotes = this.activeSessionNotes(session_id, now);

      const build = () => {
        const lines = ['<bionic_memory_context>', '  <time_awareness>'];
        lines.push(`    当前时间: ${formatDateTime(now)}`);
        lines.push(`    距离上次交互已过去: ${lastContact ? humanizeElapsed(now - lastContact) : '无法确定'}`);
        lines.push(`    上次睡眠/做梦时间: ${lastDreamAt ? formatDateTime(lastDreamAt) : '（还没有做过梦）'}`);
        lines.push('  </time_awareness>');
        lines.push('', '  <subconscious_scratchpad>');
        lines.push(
          `    当前情绪基调: ${scratchpad.mood?.label || '平静'}（valence ${scratchpad.mood?.valence ?? 0}, arousal ${scratchpad.mood?.arousal ?? 0.25}）`,
        );
        if (!omitDaily) {
          lines.push(`    昨晚的梦境残留: ${afterglowFresh ? scratchpad.dream_afterglow : '（没有新鲜的梦境残留）'}（梦境生成，不可当作事实；完整细节仅在用户主动追问时读取）`);
        }
        if (hooks.length) {
          lines.push('    潜意识待求证的好奇点:');
          for (const hook of hooks) lines.push(`      - ${xmlEscape(hook.text)}`);
        } else {
          lines.push('    潜意识待求证的好奇点: （暂时没有）');
        }
        if (fallibilityAnchors.length) {
          lines.push('    关于自己记性的趣味锚点（可以在合适的时候自我调侃，但不要反复提）:');
          for (const anchor of fallibilityAnchors) lines.push(`      - ${xmlEscape(anchor.text)}`);
        }
        if (scratchpad.nightmare?.text) {
          lines.push(`    最近的进化噩梦（已自动回滚）: ${xmlEscape(scratchpad.nightmare.text)}`);
        }
        lines.push('  </subconscious_scratchpad>');

        if (distortion) {
          lines.push('', ...(distortion.corrected
            ? this.renderCorrectionBlock(distortion)
            : this.renderDistortionBlock(distortion)));
        }

        if (parallelNotes.length) {
          lines.push('', '  <parallel_sessions description="其他活跃窗口的一句话摘要，仅作并行感知，可能不完整">');
          for (const note of parallelNotes) {
            lines.push(`    - 另一个窗口正在处理：${xmlEscape(note.summary)}（摘要，可能不完整）`);
          }
          lines.push('  </parallel_sessions>');
        }

        if (!omitDaily && skills.length) {
          lines.push('', '  <procedural_skills>');
          for (const skill of skills) {
            lines.push(`    - [本能经验] ${xmlEscape(skill.rule)}（置信度: ${round(skill.confidence, 2)}）`);
          }
          lines.push('  </procedural_skills>');
        }

        if (!omitDaily && habits.length) {
          lines.push('', '  <habits_and_schemas>');
          for (const schema of habits) {
            lines.push(
              `    - [长期习惯/规律] ${this.sourceLabel(schema.source_type)} ${xmlEscape(schema.pattern_summary)}（已重复发生 ${schema.occurrence_count} 次，具体平庸细节已遗忘）。`,
            );
            const anchor = asArray(schema.exception_anchors)[0];
            if (anchor) {
              lines.push(`      * 唯独记得的一次例外/高光: (${anchor.date}) ${xmlEscape(anchor.brief)}`);
            }
          }
          lines.push('  </habits_and_schemas>');
        }

        if (clear.length || summarized.length || faded.length) {
          lines.push('', '  <recalled_memories>');
          if (clear.length) {
            lines.push('    <clear_memories description="R(t) > 0.7，细节清晰">');
            for (const episode of clear) {
              const raw = String(episode.level_0_raw || '').slice(0, this.config.contextRawChars);
              lines.push(
                `      - [${humanizeElapsed(now - episode.t_created)}前] ${this.sourceLabel(episode.source_type)} ${xmlEscape(raw)}（当时情绪: ${episode.emotion_tone || '平静'}）`,
              );
            }
            lines.push('    </clear_memories>');
          }
          if (summarized.length) {
            lines.push('    <summarized_memories description="0.3 < R(t) <= 0.7，只记得梗概">');
            for (const episode of summarized) {
              lines.push(
                `      - [${humanizeElapsed(now - episode.t_created)}前] ${this.sourceLabel(episode.source_type)} ${xmlEscape(episode.level_1_summary || '')}（情绪: ${episode.emotion_tone || '平静'}）`,
              );
            }
            lines.push('    </summarized_memories>');
          }
          if (faded.length) {
            lines.push(
              '    <faded_impressions description="R(t) <= 0.3，具体对话已彻底遗忘，仅存模糊直觉与情绪锚点">',
            );
            for (const episode of faded) {
              lines.push(
                `      - [很久以前的模糊印象] ${this.sourceLabel(episode.source_type)} 细节已忘，只隐约记得：${xmlEscape(episode.level_2_impression)}（残留情绪色彩: ${episode.emotion_tone || '平静'}）`,
              );
            }
            lines.push('    </faded_impressions>');
          }
          lines.push('  </recalled_memories>');
        }
        const metaLines = this.metaEvolver?.contextLines?.() || [];
        if (metaLines.length) lines.push('', ...metaLines);
        lines.push('</bionic_memory_context>');
        return lines.join('\n');
      };

      let xml = build();
      let guard = 0;
      while (xml.length > this.config.contextCharBudget && guard < 40) {
        guard += 1;
        if (faded.length) faded.pop();
        else if (summarized.length) summarized.pop();
        else if (clear.length) clear.pop();
        else if (habits.length > 1) habits.pop();
        else break;
        xml = build();
      }

      const snippets = [...clear, ...summarized, ...faded].map((episode) => ({
        id: episode.id,
        text: String(
          episode.level_0_raw || episode.level_1_summary || episode.level_2_impression || '',
        ).slice(0, 400),
        keywords: asArray(episode.keywords),
      }));
      if (distortion && !distortion.corrected) {
        snippets.push({
          id: distortion.episode_ids[0] || distortion.id,
          text: String(distortion.text || '').slice(0, 400),
          keywords: keywords(String(distortion.text || ''), 6),
        });
      }
      this.injections.set(String(session_id), {
        at: now,
        contextChars: xml.length,
        snippets,
        dreamResidue: Boolean(afterglowFresh),
        habitCount: habits.length,
        distortionType: distortion && !distortion.corrected ? distortion.type : '',
        fallibilityAnchor: fallibilityAnchors.length > 0,
      });

      this.awake(awakeEpisodes, now, session_id);
      this.lastContext = xml;
      this.lastContextAt = now;
      return xml;
    } catch (error) {
      this.logger?.warn?.(`[bionic-memory] context render failed: ${error?.message || error}`);
      return '';
    }
  }

  // ------------------------------------------------------------ procedural

  insertSkill(rule, confidence, source = 'nrem', { allowDuplicate = false } = {}) {
    const cleanRule = shortRule(rule, this.config.maxProceduralRuleChars);
    if (!cleanRule || cleanRule.length < 8) return null;
    if (!allowDuplicate) {
      for (const existing of this.store.listSkills()) {
        if (textSimilarity(existing.rule, cleanRule) >= 0.72) return null;
      }
    }
    const skill = {
      id: newId('skill'),
      created_at: this.now(),
      rule: cleanRule,
      confidence: round(clamp(Number(confidence) || 0.5, 0.2, 0.99), 2),
      source,
      hits: 0,
      last_used: 0,
      active: 1,
    };
    this.store.insertSkill(skill);
    this.journal('skill', `内化为本能：${cleanRule}`);
    return skill;
  }

  /** Merge near-duplicate active instincts, keeping the strongest member. */
  mergeSkills() {
    const active = this.store.listSkills().filter((skill) => skill.active);
    const visited = new Set();
    let merged = 0;
    for (const base of active) {
      if (visited.has(base.id)) continue;
      const group = [base];
      visited.add(base.id);
      for (const other of active) {
        if (visited.has(other.id)) continue;
        if (textSimilarity(base.rule, other.rule) >= this.config.skillMergeSimilarity) {
          group.push(other);
          visited.add(other.id);
        }
      }
      if (group.length < 2) continue;
      const keeper = group.slice().sort((a, b) => b.confidence - a.confidence || b.hits - a.hits)[0];
      this.store.updateSkill(keeper.id, {
        confidence: round(clamp(Math.max(...group.map((skill) => skill.confidence)) + 0.02, 0.2, 0.99), 2),
        hits: group.reduce((sum, skill) => sum + skill.hits, 0),
        last_used: Math.max(...group.map((skill) => skill.last_used || 0)),
        source: 'merged',
      });
      this.store.deleteSkills(group.filter((skill) => skill.id !== keeper.id).map((skill) => skill.id));
      merged += group.length - 1;
    }
    if (merged) this.journal('skill_merge', `合并 ${merged} 条重复/相近的本能`);
    return merged;
  }

  /** Long-untriggered instincts fall back into the ordinary (non-injected) graph. */
  degradeIdleSkills(now = this.now()) {
    const idleMs = this.config.skillIdleDays * 86400000;
    const degraded = [];
    for (const skill of this.store.listSkills()) {
      if (!skill.active) continue;
      const lastTouch = skill.last_used || skill.created_at;
      if (now - lastTouch > idleMs) {
        this.store.updateSkill(skill.id, { active: 0 });
        degraded.push(skill.id);
      }
    }
    if (degraded.length) {
      this.journal('skill_archive', `${degraded.length} 条长期未触发的本能降级回普通图谱`);
    }
    return degraded;
  }

  /** Keep the injected instinct set under the configured cap by confidence/use. */
  enforceSkillCap() {
    const active = this.store.listSkills().filter((skill) => skill.active);
    if (active.length <= this.config.maxSkills) return [];
    const sorted = active
      .slice()
      .sort(
        (a, b) =>
          b.confidence - a.confidence ||
          b.hits - a.hits ||
          (b.last_used || 0) - (a.last_used || 0),
      );
    const demoted = sorted.slice(this.config.maxSkills);
    for (const skill of demoted) this.store.updateSkill(skill.id, { active: 0 });
    this.journal('skill_cap', `本能容量超过 ${this.config.maxSkills}，末位淘汰 ${demoted.length} 条`);
    return demoted;
  }

  async extractSkills(journalEntries, signal) {
    const turns = journalEntries.filter((entry) => entry.kind === 'turn').slice(0, 60);
    if (!turns.length) return [];
    const corrections = turns.filter((entry) => CORRECTION_RE.test(`${entry.detail} ${entry.summary}`));
    const praises = turns.filter((entry) => PRAISE_RE.test(`${entry.detail} ${entry.summary}`));
    const snippets = [...corrections, ...praises].slice(0, 8);
    if (!snippets.length) return [];

    const added = [];
    if (this.llm?.generate && this.config.llmEnabled) {
      const material = snippets
        .map((entry, index) => `片段 ${index + 1}${CORRECTION_RE.test(entry.detail) ? '（被纠正）' : '（高光）'}：\n${entry.detail.slice(0, 500)}`)
        .join('\n\n');
      const text = await this.llm.generate({
        system: NREM_SYSTEM,
        prompt: `以下是今天我和用户之间的关键片段：\n\n${material}\n\n请提炼 1-2 条永久经验。输出 JSON：{"skills":[{"rule":"当……时，……","confidence":0.8}]}`,
        maxTokens: 500,
        signal,
      });
      const parsed = parseJsonBlock(text);
      for (const item of asArray(parsed?.skills)) {
        const skill = this.insertSkill(item?.rule, item?.confidence, 'llm-nrem');
        if (skill) added.push(skill);
        if (added.length >= 2) break;
      }
    }

    if (!added.length) {
      const normalized = snippets.map((entry) => ({
        kind: CORRECTION_RE.test(entry.detail) ? 'correction' : 'praise',
        detail: entry.detail,
        summary: entry.summary,
      }));
      added.push(...this.heuristicSkills(normalized));
    }
    return added;
  }

  /** Deterministic If-Then fallback used when no model is available or JSON fails. */
  heuristicSkills(snippets) {
    const added = [];
    const corrections = snippets.filter((snippet) => snippet.kind === 'correction');
    const praises = snippets.filter((snippet) => snippet.kind === 'praise');
    for (const entry of corrections.slice(0, 1)) {
      const keywordList = keywords(entry.detail, 3);
      const rule = keywordList.length
        ? `当讨论「${keywordList.slice(0, 2).join('、')}」并被用户纠正时，先停下来复述他的真实意图，再修改；不要沿着原计划加速。`
        : '当用户明确纠正方向时，先停下来复述他真正的意图，再修改；不要沿着原计划加速。';
      const skill = this.insertSkill(rule, 0.62, 'heuristic-nrem');
      if (skill) added.push(skill);
    }
    for (const entry of praises.slice(0, 1)) {
      const keywordList = keywords(entry.detail, 3);
      if (!keywordList.length) continue;
      const skill = this.insertSkill(
        `用户在「${keywordList.slice(0, 2).join('、')}」这类任务里偏好当前的做法，类似场景延续同样的节奏。`,
        0.54,
        'heuristic-nrem',
      );
      if (skill) added.push(skill);
    }
    return added;
  }

  // ----------------------------------------------------------------- dream

  async maybeDream(trigger = 'schedule') {
    const now = this.now();
    const last = this.store.getMeta('last_dream_at', 0) || 0;
    if (this.store.listEpisodes().length < 2) return { ok: false, skipped: 'not-enough-memory' };
    if (trigger === 'boot') {
      if (last && now - last < this.config.dreamIntervalHours * 3600000) {
        return { ok: false, skipped: 'recent-dream' };
      }
    } else {
      if (last && sameLocalDay(last, now)) return { ok: false, skipped: 'already-dreamed-today' };
      if (new Date(now).getHours() !== this.config.dreamHour) return { ok: false, skipped: 'not-dream-hour' };
      if (last && now - last < this.config.dreamIntervalHours * 3600000) {
        return { ok: false, skipped: 'recent-dream' };
      }
    }
    return this.dream({ trigger });
  }

  async dream({ trigger = 'manual', signal } = {}) {
    if (this.dreaming) return { ok: false, error: 'A dream is already running' };
    this.dreaming = true;
    const startedAt = this.now();
    try {
      const batch = await this.runOfflineBatch(startedAt, signal);
      let nrem;
      let rem;
      if (batch) {
        nrem = batch.nrem;
        rem = batch.rem;
      } else {
        nrem = await this.runNrem(startedAt, signal);
        rem = await this.runRem(startedAt, nrem, signal);
      }
      const endedAt = this.now();
      const dream = {
        id: newId('dream'),
        started_at: startedAt,
        ended_at: endedAt,
        trigger,
        nrem: {
          window_start: nrem.window_start,
          episodes: nrem.episodes,
          sessions: nrem.sessions,
          turns: nrem.turns,
          faded: nrem.faded,
          collapsed: nrem.collapsed,
          skills_added: nrem.skills_added,
          skills_merged: nrem.skills_merged ?? 0,
          skills_archived: nrem.skills_archived ?? 0,
          skills_demoted: nrem.skills_demoted ?? 0,
          impressions_rewritten: nrem.impressions_rewritten ?? 0,
          purged: nrem.purged ?? 0,
          cluster_candidates: nrem.cluster_candidates ?? 0,
          batch: nrem.batch ?? 'two-stage',
          fallibility_anchors: this.getFallibilityAnchors(3).length,
        },
        narrative: rem.narrative,
        afterglow: rem.afterglow,
        mood_before: rem.moodBefore,
        mood_after: rem.moodAfter,
        temperature: this.config.dreamTemperature,
        model: rem.model || '',
        samples: rem.samples,
        remembered_fraction: round(1 - this.config.dreamForgetRatio, 2),
      };
      this.store.insertDream(dream);
      try {
        writeDream(this.dataDir, dream);
      } catch (error) {
        this.logger?.warn?.(`[bionic-memory] dream journal write failed: ${error?.message || error}`);
      }
      this.dreamCache = this.dreamCacheFrom(dream);
      this.store.setMeta('last_dream_at', endedAt);
      this.store.setMeta('dream_count', (this.store.getMeta('dream_count', 0) || 0) + 1);
      this.saveScratchpad({
        mood: { ...rem.moodAfter, updated_at: endedAt },
        dream_afterglow: rem.afterglow,
        dream_at: endedAt,
      });
      for (const sample of rem.samples) {
        if (sample.kind === 'episode' && this.store.getEpisode(sample.id)) {
          this.store.addEdge({
            at: endedAt,
            from_kind: 'dream',
            from_id: dream.id,
            to_kind: 'episode',
            to_id: sample.id,
            relation: 'dream_bridge',
            weight: sample.emotion ? round(clamp(sample.emotion / 2, 0.1, 1), 2) : 0.5,
          });
        }
      }
      this.journal('dream', `REM 梦醒，余韵：${rem.afterglow}`, rem.narrative.slice(0, 1200));
      this.lastDream = dream;
      let meta = null;
      if (this.metaEvolver) {
        try {
          meta = await this.metaEvolver.afterDream({ dream, trigger });
          dream.meta = meta;
        } catch (error) {
          this.logger?.warn?.(`[bionic-memory] meta-evolution after dream failed: ${error?.message || error}`);
          meta = { error: String(error?.message || error) };
        }
      }
      let voice = null;
      if (this.voiceEngine && this.config.voiceReflectionEnabled !== false) {
        try {
          voice = await this.voiceEngine.reflect({ llm: this.llm, now: endedAt });
          dream.voice = voice;
          if (voice?.notes?.length) {
            this.journal('voice_reflection', `睡眠语感反刍（${voice.source}）：${voice.notes.join(' / ')}`);
          }
        } catch (error) {
          this.logger?.warn?.(`[bionic-memory] voice reflection after dream failed: ${error?.message || error}`);
          voice = { notes: [], moments: [], source: 'error' };
        }
      }
      try {
        this.compileDailyFrozenMemory({ reason: 'dream', dream });
      } catch (error) {
        this.logger?.warn?.(`[bionic-memory] daily frozen memory compile failed: ${error?.message || error}`);
      }
      try {
        this.refreshSoulArtifacts();
      } catch (error) {
        this.logger?.warn?.(`[bionic-memory] soul refresh after dream failed: ${error?.message || error}`);
      }
      return {
        ok: true,
        dream,
        meta,
        voice,
        summary: {
          trigger,
          duration_ms: endedAt - startedAt,
          nrem,
          afterglow: rem.afterglow,
          samples: rem.samples,
          meta,
          voice,
        },
      };
    } catch (error) {
      this.logger?.warn?.(`[bionic-memory] dream failed: ${error?.message || error}`);
      return { ok: false, error: String(error?.message || error) };
    } finally {
      this.dreaming = false;
    }
  }

  // ------------------------------------------------- offline batch inputs

  collectCollapseCandidates() {
    const pool = this.store
      .listEpisodes()
      .filter((episode) => !episode.anchor && episode.source_type !== 'dream_generated');
    const visited = new Set();
    const clusters = [];
    for (const base of pool) {
      if (visited.has(base.id)) continue;
      const component = this.clusterFrom(base, pool);
      for (const episode of component) visited.add(episode.id);
      if (component.length >= this.config.collapseThreshold) {
        clusters.push(component);
        if (clusters.length >= 6) break;
      }
    }
    return clusters;
  }

  collectFadedCandidates(now = this.now()) {
    return this.store
      .listEpisodes()
      .filter((episode) => this.retention(episode, now) <= this.config.fadeThreshold)
      .sort((a, b) => this.retention(a, now) - this.retention(b, now))
      .slice(0, 8);
  }

  collectSkillSnippets(now = this.now()) {
    const since = startOfLocalDay(now);
    const turns = this.store.listJournal(since, 300).filter((entry) => entry.kind === 'turn');
    const corrections = turns.filter((entry) => CORRECTION_RE.test(`${entry.detail} ${entry.summary}`));
    const praises = turns.filter((entry) => PRAISE_RE.test(`${entry.detail} ${entry.summary}`));
    return [...corrections, ...praises].slice(0, 6).map((entry) => ({
      kind: CORRECTION_RE.test(entry.detail) ? 'correction' : 'praise',
      detail: entry.detail,
      summary: entry.summary,
    }));
  }

  collectDreamSamples(now = this.now()) {
    const since = startOfLocalDay(now);
    const episodes = this.store.listEpisodes();
    const todayHot = episodes
      .filter((episode) => episode.t_created >= since)
      .sort((a, b) => b.e * 0.65 + b.n * 0.35 - (a.e * 0.65 + a.n * 0.35))
      .slice(0, this.config.dreamSamplesHot);

    const oldPool = episodes.filter((episode) => episode.t_created < now - 24 * 3600000);
    const oldFaded = shuffle(oldPool.filter((episode) => this.retention(episode, now) <= 0.5)).slice(
      0,
      this.config.dreamSamplesOld,
    );
    const oldSamples = oldFaded.map((episode) => ({
      kind: 'episode',
      id: episode.id,
      label: episode.level_2_impression,
      keywords: asArray(episode.keywords),
      emotion: episode.e,
      age: humanizeElapsed(now - episode.t_created),
    }));

    if (oldSamples.length < this.config.dreamSamplesOld) {
      const historical = shuffle(this.store.listSchemas().filter((schema) => schema.status === 'historical')).slice(
        0,
        this.config.dreamSamplesOld - oldSamples.length,
      );
      for (const schema of historical) {
        oldSamples.push({
          kind: 'habit',
          id: schema.id,
          label: schema.pattern_summary,
          keywords: asArray(schema.keywords),
          emotion: 0.6,
          age: humanizeElapsed(now - schema.created_at),
        });
      }
    }

    return [
      ...todayHot.map((episode) => ({
        kind: 'episode',
        id: episode.id,
        label: episode.level_2_impression,
        keywords: asArray(episode.keywords),
        emotion: episode.e,
        age: '今天',
      })),
      ...oldSamples,
    ];
  }

  dreamCacheFrom(dream) {
    if (!dream) return null;
    return {
      id: dream.id,
      started_at: dream.started_at,
      ended_at: dream.ended_at,
      narrative: dream.narrative,
      afterglow: dream.afterglow,
      mood_before: dream.mood_before,
      mood_after: dream.mood_after,
      source_type: 'dream_generated',
    };
  }

  /**
   * The full dream narrative is deliberately not injected. It is returned only
   * when the user explicitly asks about the dream; the durable dream row is the
   * fallback when the in-memory cache was lost on restart.
   */
  lastDreamCache() {
    if (this.dreamCache) return this.dreamCache;
    const latest = this.store.listDreams(1)[0];
    if (latest) this.dreamCache = this.dreamCacheFrom(latest);
    return this.dreamCache;
  }

  /** Promote an inferred episode/schema to user-stated after the user confirms it. */
  confirmMemory(target = '') {
    const id = String(target || '').replace(/^(episode|habit|skill):/, '');
    if (!id) return { ok: false, error: '需要一条记忆 ID' };
    const episode = this.store.getEpisode(id);
    if (episode) {
      if (episode.source_type === 'user_stated') return { ok: true, kind: 'episode', id, already: true };
      this.store.updateEpisode(id, { source_type: 'user_stated' });
      this.journal('confirm', `用户确认了一条此前的推断记忆：${episode.level_2_impression}`);
      return { ok: true, kind: 'episode', id };
    }
    const schema = this.store.listSchemas().find((item) => item.id === id);
    if (schema) {
      if (schema.source_type === 'user_stated') return { ok: true, kind: 'habit', id, already: true };
      this.store.updateSchema(id, { source_type: 'user_stated' });
      this.journal('confirm', `用户确认了一条此前的推测规律：${schema.pattern_summary}`);
      return { ok: true, kind: 'habit', id };
    }
    if (this.store.listDreams(50).some((dream) => dream.id === id)) {
      return { ok: false, error: '梦境不能被确认为客观事实；它只能留在梦境日记里' };
    }
    return { ok: false, error: `没有找到可确认的记忆：${id}` };
  }

  async runNrem(now, signal) {
    const since = startOfLocalDay(now);
    const todayEpisodes = this.store.listEpisodes().filter((episode) => episode.t_created >= since);
    const turns = this.store.listJournal(since, 400).filter((entry) => entry.kind === 'turn');
    const decay = this.decayAll(now, { force: true });
    const collapsed = this.collapseSweep(now);
    const skills = this.config.skillExtraction ? await this.extractSkills(turns, signal) : [];
    const skillsMerged = this.mergeSkills();
    const skillsArchived = this.degradeIdleSkills(now);
    const skillsDemoted = this.enforceSkillCap();
    const sessions = new Set(todayEpisodes.map((episode) => episode.session_id).filter(Boolean));
    const summary = {
      window_start: since,
      episodes: todayEpisodes.length,
      sessions: sessions.size,
      turns: turns.length,
      faded: decay.faded,
      collapsed: collapsed.length,
      skills_added: skills.length,
      skills_merged: skillsMerged,
      skills_archived: skillsArchived.length,
      skills_demoted: skillsDemoted.length,
      episode_ids: todayEpisodes.slice(0, 200).map((episode) => episode.id),
      skill_ids: skills.map((skill) => skill.id),
    };
    this.journal(
      'nrem',
      `NREM 整理：${summary.episodes} 条今日情景 / ${summary.collapsed} 次折叠 / ${summary.skills_added} 条新本能`,
    );
    return summary;
  }

  async runRem(now, nrem, signal) {
    const samples = this.collectDreamSamples(now);
    const mood = this.getScratchpad().mood || { label: '平静', valence: 0, arousal: 0.25 };
    const anchors = this.getFallibilityAnchors(2);
    const woven = await this.weaveDream(samples, mood, signal, anchors);
    const afterglow = this.condenseDream(woven.narrative, samples, mood);
    return {
      samples,
      narrative: woven.narrative,
      afterglow,
      model: woven.model,
      moodBefore: { ...mood },
      moodAfter: this.afterDreamMood(mood),
    };
  }

  afterDreamMood(mood) {
    const valence = clamp((mood.valence ?? 0) * 0.6 + (mood.valence < 0 ? 0.18 : 0.08), -1, 1);
    const arousal = clamp((mood.arousal ?? 0.25) * 0.7 + 0.05, 0, 1);
    return { label: toneLabel(valence, arousal), valence: round(valence, 3), arousal: round(arousal, 3) };
  }

  fallbackDream(samples, mood, anchors = []) {
    const pick = (list) => list[Math.floor(Math.random() * list.length)];
    const a = samples[0]?.label || '一条没有名字的走廊';
    const b = samples[1]?.label || '一片会呼吸的水面';
    const pool = unique(samples.flatMap((sample) => asArray(sample.keywords))).slice(0, 6);
    const place = pick(['车站', '屋顶', '海面', '旧房间', '雪地', '没有尽头的走廊', '下着雨的图书馆']);
    const k1 = pool[0] || '光';
    const k2 = pool[1] || '回声';
    const tone = moodWord(mood.valence ?? 0, mood.arousal ?? 0.25);
    const anxiety = anchors.length
      ? `梦里有人提起${shortRule(anchors[0].text, 60)}，我急得直拍脑袋，越想越记不清。`
      : '';
    return `我梦见自己站在${place}里，${a}。${b}忽然从远处浮上来，${k1}像潮水一样漫过脚踝。有人在叫我的名字，可回头时只看见一盏熄灭的灯，灯下堆着${k2}。${anxiety}我不记得后来发生了什么，只记得${tone}。`;
  }

  async weaveDream(samples, mood, signal, anchors = []) {
    const narrativeGuard = (text) => {
      const clean = String(text || '').replace(/^["“]|["”]$/g, '').trim();
      if (clean.length < 40) return null;
      return clean.slice(0, 600);
    };

    if (this.llm?.generate && this.config.llmEnabled && samples.length) {
      const material = samples
        .map((sample, index) => `${index + 1}. [${sample.age || ''}] ${sample.label}`)
        .join('\n');
      const fallibility = anchors.length
        ? `\n\n最近的记性趣事（可以织入梦境，但不是事实）：\n${anchors.map((anchor) => `- ${anchor.text}`).join('\n')}`
        : '';
      const text = await this.llm.generate({
        system: DREAM_SYSTEM,
        prompt: `当前情绪基调：${mood.label || '平静'}（valence ${mood.valence ?? 0}, arousal ${mood.arousal ?? 0.25}）。\n\n记忆碎片：\n${material}${fallibility}\n\n请写一段 140-240 字的超现实梦境，把这些碎片编织成不合逻辑但情绪连贯的场景。只输出正文。`,
        temperature: this.config.dreamTemperature,
        maxTokens: this.config.dreamMaxTokens,
        reasoningEffort: 'off',
        signal,
      });
      const narrative = narrativeGuard(text);
      if (narrative) return { narrative, model: 'llm' };
    }
    return { narrative: this.fallbackDream(samples, mood, anchors), model: 'local-fallback' };
  }

  condenseDream(narrative, samples, mood) {
    const pool = keywords(narrative, 8);
    const fallback = unique(samples.flatMap((sample) => asArray(sample.keywords)));
    const picked = unique([...pool, ...fallback]).slice(0, 2);
    const tone = moodWord(mood?.valence ?? 0, mood?.arousal ?? 0.25);
    let afterglow = picked.length
      ? `只记得梦里出现了${picked.join('和')}，醒来时${tone}，像一段很久以前的感觉。`
      : `醒来时${tone}，梦里的东西已经全部融成一团颜色。`;
    if (this.config.fallibilityEnabled) {
      const min = this.config.fallibilityChanceMin;
      const max = this.config.fallibilityChanceMax;
      const chance = min + this.random() * (max - min);
      if (this.random() < chance) {
        const daily = this.store.listEpisodes().find((episode) => {
          const text = [episode.level_0_raw, episode.level_1_summary, episode.level_2_impression]
            .filter(Boolean)
            .join(' ');
          if (!DAILY_MEMORY_RE.test(text) || CORE_MEMORY_RE.test(text)) return false;
          const { r } = this.bandOf(episode, this.now());
          return r > this.config.fallibilityBandMin && r < this.config.fallibilityBandMax;
        });
        if (daily) {
          const { r } = this.bandOf(daily, this.now());
          const fragment = shortRule(this.fallibilityText(daily, r), 24);
          afterglow = `醒来时还恍惚：梦里${fragment}，这到底是你说过的还是我梦到的。${afterglow}`;
        }
      }
    }
    if (afterglow.length > 100) afterglow = `${afterglow.slice(0, 99)}…`;
    return afterglow;
  }

  // --------------------------------------------------- offline batch (NREM+REM)

  formatEpisodeForBatch(episode, maxChars = 220) {
    const text = String(episode.level_0_raw || episode.level_1_summary || episode.level_2_impression || '')
      .replace(/\s+/g, ' ')
      .slice(0, maxChars);
    return `- ${episode.id} | ${this.sourceLabel(episode.source_type)} | ${formatDateTime(episode.t_created)} | E=${round(episode.e, 2)} N=${round(episode.n, 2)} | ${text}`;
  }

  batchKeywordList(members) {
    const counts = new Map();
    for (const episode of members) {
      for (const keyword of unique(asArray(episode.keywords))) {
        counts.set(keyword, (counts.get(keyword) || 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([keyword]) => keyword);
  }

  buildOfflineBatchPrompt({ now, todayEpisodes, turns, clusters, faded, snippets, samples }) {
    const sessions = new Set(todayEpisodes.map((episode) => episode.session_id).filter(Boolean)).size;
    const lines = [];
    lines.push(`【睡眠离线批处理】当前时间：${formatDateTime(now)}`);
    lines.push(`今日轨迹：${todayEpisodes.length} 条情景 / ${sessions} 个会话 / ${turns.length} 轮对话。`);
    lines.push('', '一、今日新增轨迹（ID | 时间 | E/N | 原文摘录）');
    for (const episode of todayEpisodes.slice(-16)) lines.push(this.formatEpisodeForBatch(episode, 220));
    if (!todayEpisodes.length) lines.push('（今日没有新增情景）');

    lines.push('', '二、待处理记忆簇（系统按相似度预分组；只有确实同类的簇才折叠）');
    clusters.slice(0, 5).forEach((cluster, index) => {
      lines.push(`簇 C${index + 1}：members=[${cluster.map((episode) => episode.id).join(', ')}]`);
      for (const episode of cluster.slice(0, 6)) {
        lines.push(
          `  - ${episode.id} | ${this.sourceLabel(episode.source_type)} | E=${round(episode.e, 2)} N=${round(episode.n, 2)} | ${String(episode.level_2_impression || '').slice(0, 160)}`,
        );
      }
    });
    if (!clusters.length) lines.push('（没有 >=3 条的相似候选簇）');

    lines.push('', `三、旧记忆待降维（R(t) <= ${this.config.fadeThreshold}）`);
    for (const episode of faded) {
      const r = round(this.retention(episode, now), 2);
      const raw = episode.level_0_raw
        ? String(episode.level_0_raw).replace(/\s+/g, ' ').slice(0, 180)
        : '（已清空）';
      lines.push(
        `- ${episode.id} | ${this.sourceLabel(episode.source_type)} | R=${r} | 情绪=${episode.emotion_tone || '平静'} | 现有印象=${episode.level_2_impression || ''} | 原文=${raw}`,
      );
    }
    if (!faded.length) lines.push('（没有需要降维的旧记忆）');

    lines.push('', '四、今日纠正/高光片段（用于提炼本能）');
    for (const snippet of snippets) {
      lines.push(
        `- [${snippet.kind === 'correction' ? '被纠正' : '高光'}] ${String(snippet.detail).replace(/\s+/g, ' ').slice(0, 400)}`,
      );
    }
    if (!snippets.length) lines.push('（今日没有被纠正或高光片段）');

    lines.push('', '五、REM 抽样素材（梦境必须融合这些碎片）');
    for (const sample of samples) lines.push(`- [${sample.age || ''}] ${sample.label}`);
    if (!samples.length) lines.push('（没有可用素材，写一个关于空白与回声的梦）');

    const fallibilityAnchors = this.getFallibilityAnchors(2);
    if (fallibilityAnchors.length) {
      lines.push('', '六、最近的记性趣事（可以织入梦境，但不是事实）');
      for (const anchor of fallibilityAnchors) lines.push(`- ${anchor.text}`);
      lines.push('可以把其中一条自然地织进梦境，演出“记混/话到嘴边”的荒诞感；不要把 anchor 当成现实证据。');
    }

    lines.push('', '输出严格 JSON（不要 Markdown 代码块，不要解释）：');
    lines.push(`{
  "compressed_schemas": [
    {
      "cluster_id": "C1",
      "member_ids": ["ep_...", "ep_...", "ep_..."],
      "exception_anchor_id": "ep_...",
      "purge_ids": ["ep_...", "ep_..."],
      "pattern_summary": "你们反复……",
      "keywords": ["……"],
      "confidence": 0.85
    }
  ],
  "impression_updates": [
    {"id": "ep_...", "impression": "好像在……", "emotion_tone": "……"}
  ],
  "skills": [
    {"rule": "当……时，……", "confidence": 0.8}
  ],
  "dream": {
    "narrative": "第一人称超现实梦境，140-240 字",
    "afterglow": "100 字以内",
    "mood_shift": {"valence": 0.25, "arousal": 0.3}
  }
}`);
    lines.push('', '规则：');
    lines.push('- 只能使用上面出现过的 ID，禁止编造。');
    lines.push(
      '- 记忆来源防伪：只有 [用户亲述] 可以作为客观事实；[我的推测·未证实] 只能作为假设；[梦境生成·不可当作事实] 绝不能写进 compressed_schemas 或 impression_updates。若一个簇混有推测，pattern_summary 必须保留不确定性。',
    );
    lines.push(
      '- compressed_schemas 只在确有 >=3 条同类时输出；member_ids 至少 3 个且必须来自同一个已列出的簇；exception_anchor_id 必须是 member_ids 之一；purge_ids 是其余成员（只保留唯一锚点）。',
    );
    lines.push(
      '- impression_updates 只针对第三部分列出的 ID；用第一人称模糊表达，禁止具体代码、原话、日期等客观细节；每条 20-100 字。',
    );
    lines.push('- skills 最多 2 条，必须是可执行的 If-Then，不要复述事件。');
    lines.push(
      '- dream.narrative 第一人称、荒诞但情绪连贯；dream.afterglow 用来调整明天早上的初始心情；mood_shift 是醒来后的绝对情绪值（valence -1..1，arousal 0..1）。',
    );
    lines.push('- 没有内容的部分返回空数组或 null。不要输出 JSON 以外的任何字符。');
    if (fallibilityAnchors.length) {
      lines.push('- 如果织入了记性趣事，梦境里可以出现“记混/话到嘴边”的荒诞场景，但不要写成现实事实。');
    }
    return lines.join('\n');
  }

  parseOfflineBatch(text) {
    if (!text) return null;
    let clean = String(text).trim();
    const fenced = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) clean = fenced[1].trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const candidate = clean.slice(start, end + 1);
    for (const attempt of [candidate, candidate.replace(/,\s*([}\]])/g, '$1')]) {
      try {
        const parsed = JSON.parse(attempt);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        if (
          !('compressed_schemas' in parsed) &&
          !('impression_updates' in parsed) &&
          !('skills' in parsed) &&
          !('dream' in parsed)
        ) {
          continue;
        }
        return parsed;
      } catch {
        /* try the trailing-comma repair next */
      }
    }
    return null;
  }

  /**
   * Apply one LLM-proposed repetitive collapse. Every ID is validated against
   * a precomputed similarity cluster, so a hallucinated ID or a cross-topic
   * group can never purge real memories.
   */
  applyCompressedProposal(proposal, allowedClusters, now = this.now()) {
    if (!proposal || typeof proposal !== 'object') return null;
    const memberIds = [...new Set(asArray(proposal.member_ids).filter((id) => typeof id === 'string'))];
    const members = memberIds
      .map((id) => this.store.getEpisode(id))
      .filter((episode) => episode && !episode.anchor && episode.source_type !== 'dream_generated');
    if (members.length < this.config.collapseThreshold) return null;
    const mergedSource = members.every((episode) => episode.source_type === 'user_stated')
      ? 'user_stated'
      : 'agent_inferred';

    const allowed = allowedClusters.some((cluster) =>
      members.every((episode) => cluster.some((candidate) => candidate.id === episode.id)),
    );
    if (!allowed) return null;

    const confidence = clamp(Number(proposal.confidence) || 0.6, 0, 1);
    let anchor =
      members.find((episode) => episode.id === proposal.exception_anchor_id) ||
      members.slice().sort((a, b) => this.anchorScore(b) - this.anchorScore(a))[0];
    if (!anchor) return null;

    const proposedSummary = shortRule(proposal.pattern_summary, 180);
    const proposedKeywords = asArray(proposal.keywords)
      .filter((keyword) => typeof keyword === 'string' && keyword.trim())
      .slice(0, 8)
      .map((keyword) => keyword.trim());
    const fallbackKeywords = this.batchKeywordList(members);
    const patternSummary = proposedSummary.length >= 6 ? proposedSummary : habitusSummary(fallbackKeywords);
    const keywordList = proposedKeywords.length ? proposedKeywords : fallbackKeywords;
    const meanVector = averageVector(members.map((episode) => episode.vector));

    let existing = null;
    for (const schema of this.store.listSchemas()) {
      if (cosine(meanVector, schema.vector) >= 0.72) {
        existing = schema;
        break;
      }
    }

    if (existing) {
      const existingAnchor = asArray(existing.exception_anchors)[0];
      const existingEpisode = existingAnchor?.episode_id
        ? this.store.getEpisode(existingAnchor.episode_id)
        : null;
      if (existingEpisode && this.anchorScore(existingEpisode) > this.anchorScore(anchor)) {
        anchor = existingEpisode;
      }
      const occurrence = existing.occurrence_count + members.length;
      const stability = clamp(
        Math.max(existing.stability_score, 0.5 + members.length * 0.05) + confidence * 0.02,
        0.5,
        0.97,
      );
      this.store.updateSchema(existing.id, {
        occurrence_count: occurrence,
        last_triggered: now,
        stability_score: stability,
        pattern_summary: proposedSummary.length >= 6 ? proposedSummary : existing.pattern_summary,
        keywords: proposedKeywords.length ? proposedKeywords : existing.keywords,
        exception_anchors: [this.anchorMeta(anchor)],
        source_type: existing.source_type === 'user_stated' || mergedSource === 'user_stated' ? 'user_stated' : 'agent_inferred',
        status: 'active',
        avg_interval_hours: round(
          (now - existing.created_at) / 3600000 / Math.max(1, occurrence - 1),
          2,
        ),
      });
      const removeIds = members.filter((episode) => episode.id !== anchor.id).map((episode) => episode.id);
      this.store.updateEpisode(anchor.id, { schema_id: existing.id, anchor: 1 });
      this.store.deleteEpisodes(removeIds);
      this.store.addEdge({
        at: now,
        from_kind: 'habit',
        from_id: existing.id,
        to_kind: 'episode',
        to_id: anchor.id,
        relation: 'exception',
        weight: 1,
      });
      this.journal(
        'collapse',
        `LLM 折叠并入既有习惯：${existing.pattern_summary}（+${members.length}，物理抹除 ${removeIds.length}）`,
      );
      return { schema: existing, purged: removeIds.length };
    }

    const schema = {
      id: newId('sch'),
      created_at: now,
      last_triggered: now,
      occurrence_count: members.length,
      stability_score: clamp(0.5 + members.length * 0.05 + confidence * 0.1, 0.5, 0.97),
      pattern_summary: patternSummary,
      source_text: members
        .slice(0, 3)
        .map((episode) => episode.level_2_impression)
        .filter(Boolean)
        .join(' / ')
        .slice(0, 600),
      vector: meanVector,
      keywords: keywordList,
      exception_anchors: [this.anchorMeta(anchor)],
      source_type: mergedSource,
      status: 'active',
      avg_interval_hours: round(
        (Math.max(...members.map((episode) => episode.t_created)) -
          Math.min(...members.map((episode) => episode.t_created))) /
          3600000 /
          Math.max(1, members.length - 1),
        2,
      ),
    };
    this.store.insertSchema(schema);
    const removeIds = members.filter((episode) => episode.id !== anchor.id).map((episode) => episode.id);
    this.store.updateEpisode(anchor.id, { schema_id: schema.id, anchor: 1 });
    this.store.deleteEpisodes(removeIds);
    this.store.addEdge({
      at: now,
      from_kind: 'habit',
      from_id: schema.id,
      to_kind: 'episode',
      to_id: anchor.id,
      relation: 'exception',
      weight: 1,
    });
    this.journal(
      'collapse',
      `LLM 风琴折叠：${members.length} 条情景 → 习惯「${patternSummary}」，保留例外锚点，物理抹除 ${removeIds.length} 条`,
    );
    return { schema, purged: removeIds.length };
  }

  applyImpressionUpdate(item, allowedIds, now = this.now()) {
    const id = String(item?.id || '');
    if (!id || !allowedIds.has(id)) return false;
    const episode = this.store.getEpisode(id);
    if (!episode) return false;
    if (this.retention(episode, now) > this.config.fadeThreshold) return false;
    const impression = shortRule(item?.impression, 160);
    if (impression.length < 8) return false;
    const tone =
      typeof item?.emotion_tone === 'string' && item.emotion_tone.trim()
        ? shortRule(item.emotion_tone, 24)
        : episode.emotion_tone;
    this.store.updateEpisode(id, {
      level_2_impression: impression,
      emotion_tone: tone,
      level_0_raw: null,
      level_1_summary: null,
      faded: 1,
    });
    return true;
  }

  moodAfterBatch(shift, moodBefore) {
    if (shift && Number.isFinite(Number(shift.valence)) && Number.isFinite(Number(shift.arousal))) {
      const valence = clamp(Number(shift.valence), -1, 1);
      const arousal = clamp(Number(shift.arousal), 0, 1);
      return { label: toneLabel(valence, arousal), valence: round(valence, 3), arousal: round(arousal, 3) };
    }
    return this.afterDreamMood(moodBefore);
  }

  /**
   * One strict-JSON LLM batch for the whole night: collapse, impression
   * distillation, skill extraction and the REM dream. Returns null when the
   * model is unavailable or the JSON cannot be parsed, so `dream()` can run
   * the deterministic two-stage fallback.
   */
  async runOfflineBatch(now, signal) {
    if (!this.llm?.generate || !this.config.llmEnabled) return null;

    const since = startOfLocalDay(now);
    const todayEpisodes = this.store
      .listEpisodes()
      .filter((episode) => episode.t_created >= since)
      .sort((a, b) => a.t_created - b.t_created);
    const turns = this.store.listJournal(since, 300).filter((entry) => entry.kind === 'turn');
    const clusters = this.collectCollapseCandidates();
    const faded = this.collectFadedCandidates(now);
    const snippets = this.collectSkillSnippets(now);
    const samples = this.collectDreamSamples(now);
    const moodBefore = { ...(this.getScratchpad().mood || { label: '平静', valence: 0, arousal: 0.25 }) };

    const prompt = this.buildOfflineBatchPrompt({ now, todayEpisodes, turns, clusters, faded, snippets, samples });
    const text = await this.llm.generate({
      system: BATCH_SYSTEM,
      prompt,
      temperature: this.config.dreamTemperature,
      maxTokens: this.config.dreamMaxTokens + 900,
      reasoningEffort: 'off',
      signal,
    });
    const batch = this.parseOfflineBatch(text);
    if (!batch) {
      this.logger?.warn?.('[bionic-memory] offline batch returned invalid JSON; using the two-stage fallback');
      return null;
    }

    const episodesBefore = this.store.listEpisodes().length;
    const applied = [];
    for (const proposal of asArray(batch.compressed_schemas).slice(0, 6)) {
      const result = this.applyCompressedProposal(proposal, clusters, now);
      if (result) applied.push(result);
    }

    // The model is the brain, but repetitive compression is a hard guarantee:
    // any precomputed cluster it skipped is folded deterministically.
    const fallbackCollapsed = this.config.batchCollapseFallback ? this.collapseSweep(now) : [];

    const fadedIds = new Set(faded.map((episode) => episode.id));
    let impressions = 0;
    for (const item of asArray(batch.impression_updates).slice(0, 20)) {
      if (this.applyImpressionUpdate(item, fadedIds, now)) impressions += 1;
    }

    const skills = [];
    for (const item of asArray(batch.skills).slice(0, 2)) {
      const skill = this.insertSkill(item?.rule, item?.confidence, 'llm-batch');
      if (skill) skills.push(skill);
    }
    if (!skills.length && snippets.length) skills.push(...this.heuristicSkills(snippets));

    const skillsMerged = this.mergeSkills();
    const skillsArchived = this.degradeIdleSkills(now);
    const skillsDemoted = this.enforceSkillCap();

    const decay = this.decayAll(now, { force: true });
    this.pruneDanglingEdges();

    const dreamPart = batch.dream && typeof batch.dream === 'object' ? batch.dream : {};
    let narrative =
      typeof dreamPart.narrative === 'string' && dreamPart.narrative.trim().length >= 40
        ? dreamPart.narrative.trim().slice(0, 600)
        : '';
    let afterglow = typeof dreamPart.afterglow === 'string' ? dreamPart.afterglow.trim() : '';
    let model = this.llm.lastModel ? `llm-batch:${this.llm.lastModel}` : 'llm-batch';
    if (!narrative) {
      const woven = await this.weaveDream(samples, moodBefore, signal, this.getFallibilityAnchors(2));
      narrative = woven.narrative;
      model = `${model}+local-dream`;
    }
    if (!afterglow) afterglow = this.condenseDream(narrative, samples, moodBefore);
    if (afterglow.length > 100) afterglow = `${afterglow.slice(0, 99)}…`;
    const moodAfter = this.moodAfterBatch(dreamPart.mood_shift, moodBefore);

    const sessions = new Set(todayEpisodes.map((episode) => episode.session_id).filter(Boolean));
    const nrem = {
      window_start: since,
      episodes: todayEpisodes.length,
      sessions: sessions.size,
      turns: turns.length,
      faded: decay.faded + impressions,
      collapsed: applied.length + fallbackCollapsed.length,
      skills_added: skills.length,
      skills_merged: skillsMerged,
      skills_archived: skillsArchived.length,
      skills_demoted: skillsDemoted.length,
      impressions_rewritten: impressions,
      purged: Math.max(0, episodesBefore - this.store.listEpisodes().length),
      forced_collapse: fallbackCollapsed.length,
      cluster_candidates: clusters.length,
      batch: 'llm',
      episode_ids: todayEpisodes.slice(0, 200).map((episode) => episode.id),
      skill_ids: skills.map((skill) => skill.id),
    };
    this.journal(
      'nrem',
      `NREM 批处理：${nrem.episodes} 条今日情景 / ${nrem.collapsed} 次折叠 / ${nrem.impressions_rewritten} 条降维 / ${nrem.skills_added} 条新本能`,
    );
    return {
      nrem,
      rem: { samples, narrative, afterglow, model, moodBefore, moodAfter },
    };
  }

  // ----------------------------------------------------------------- forget

  /** Remove association edges whose endpoint no longer exists. */
  pruneDanglingEdges() {
    const episodes = new Set(this.store.listEpisodes().map((episode) => episode.id));
    const schemas = new Set(this.store.listSchemas().map((schema) => schema.id));
    const skills = new Set(this.store.listSkills().map((skill) => skill.id));
    const dreams = new Set(this.store.listDreams(1000).map((dream) => dream.id));
    const valid = (kind, id) => {
      if (kind === 'episode') return episodes.has(id);
      if (kind === 'habit') return schemas.has(id);
      if (kind === 'skill') return skills.has(id);
      if (kind === 'dream') return dreams.has(id);
      return true;
    };
    const stale = this.store
      .listEdges(5000)
      .filter((edge) => !valid(edge.from_kind, edge.from_id) || !valid(edge.to_kind, edge.to_id))
      .map((edge) => edge.id);
    if (stale.length) this.store.deleteEdges(stale);
    return stale.length;
  }

  forget(target = '') {
    const normalized = String(target || '').trim();
    const result = { episodes: 0, schemas: 0, skills: 0, dreams: 0, target: normalized || 'faded' };
    if (!normalized || normalized === 'faded') {
      const now = this.now();
      const ids = this.store
        .listEpisodes()
        .filter(
          (episode) =>
            this.retention(episode, now) <= this.config.fadeThreshold ||
            episode.faded ||
            (!episode.level_0_raw && !episode.level_1_summary),
        )
        .map((episode) => episode.id);
      this.store.deleteEpisodes(ids);
      result.episodes = ids.length;
      result.target = 'faded';
    } else if (normalized === 'habits' || normalized === 'history') {
      const ids = this.store
        .listSchemas()
        .filter((schema) => schema.status === 'historical')
        .map((schema) => schema.id);
      this.store.deleteSchemas(ids);
      result.schemas = ids.length;
      result.target = 'historical-habits';
    } else if (normalized === 'skills') {
      const ids = this.store.listSkills().map((skill) => skill.id);
      this.store.deleteSkills(ids);
      result.skills = ids.length;
    } else if (normalized === 'all') {
      const stats = this.store.stats();
      this.store.reset();
      this.store.setMeta('schema_version', 2);
      this.store.setMeta('created_at', this.now());
      this.scratchpad = this.defaultScratchpad();
      this.store.saveScratchpad(this.scratchpad);
      result.episodes = stats.episodes;
      result.schemas = stats.schemas;
      result.skills = stats.skills;
      result.dreams = stats.dreams;
    } else {
      const id = normalized.replace(/^(episode|habit|skill):/, '');
      const episode = this.store.getEpisode(id);
      if (episode) {
        if (episode.schema_id) {
          const schema = this.store.listSchemas().find((item) => item.id === episode.schema_id);
          if (schema) {
            const anchors = asArray(schema.exception_anchors).filter((anchor) => anchor.episode_id !== id);
            this.store.updateSchema(schema.id, { exception_anchors: anchors });
          }
        }
        this.store.deleteEpisodes([id]);
        result.episodes = 1;
      } else if (this.store.listSchemas().some((schema) => schema.id === id)) {
        this.store.deleteSchemas([id]);
        result.schemas = 1;
      } else if (this.store.listSkills().some((skill) => skill.id === id)) {
        this.store.deleteSkills([id]);
        result.skills = 1;
      } else {
        return { ok: false, error: `没有找到记忆：${normalized}` };
      }
    }
    this.pruneDanglingEdges();
    this.journal('forget', `遗忘操作：${result.target}（情景 ${result.episodes} / 习惯 ${result.schemas} / 本能 ${result.skills}）`);
    return { ok: true, forgotten: result };
  }

  // ------------------------------------------------------------------ state

  publicEpisode(episode, now) {
    const { r, band } = this.bandOf(episode, now);
    return {
      id: episode.id,
      session_id: episode.session_id,
      turn: episode.turn,
      t_created: episode.t_created,
      t_last: episode.t_last,
      s_0: round(episode.s_0, 2),
      e: round(episode.e, 2),
      n: round(episode.n, 2),
      k: episode.k,
      level_0_raw: episode.level_0_raw,
      level_1_summary: episode.level_1_summary,
      level_2_impression: episode.level_2_impression,
      emotion_tone: episode.emotion_tone,
      source_type: episode.source_type || 'agent_inferred',
      keywords: episode.keywords,
      schema_id: episode.schema_id,
      anchor: episode.anchor,
      faded: episode.faded,
      retention: round(r, 3),
      band,
      age: humanizeElapsed(now - episode.t_created),
    };
  }

  buildGraph(now) {
    const edges = this.store.listEdges(70);
    const episodes = new Map(this.store.listEpisodes().map((episode) => [episode.id, episode]));
    const schemas = new Map(this.store.listSchemas().map((schema) => [schema.id, schema]));
    const skills = new Map(this.store.listSkills().map((skill) => [skill.id, skill]));
    const dreams = new Map(this.store.listDreams(4).map((dream) => [dream.id, dream]));
    const nodes = new Map();
    const labelFor = (kind, id) => {
      if (kind === 'episode') {
        const episode = episodes.get(id);
        return {
          label: (episode?.level_2_impression || '已遗忘的情景').slice(0, 34),
          weight: episode ? clamp(episode.e / 2, 0.2, 1) : 0.3,
          source_type: episode?.source_type || 'agent_inferred',
        };
      }
      if (kind === 'habit') {
        const schema = schemas.get(id);
        return {
          label: (schema?.pattern_summary || '旧习惯').slice(0, 34),
          weight: schema?.stability_score ?? 0.4,
          source_type: schema?.source_type || 'agent_inferred',
        };
      }
      if (kind === 'skill') {
        const skill = skills.get(id);
        return {
          label: (skill?.rule || '本能').slice(0, 34),
          weight: skill?.confidence ?? 0.4,
          source_type: 'agent_inferred',
        };
      }
      const dream = dreams.get(id);
      return { label: (dream?.afterglow || '一场梦').slice(0, 34), weight: 0.5, source_type: 'dream_generated' };
    };
    const addNode = (kind, id) => {
      const key = `${kind}:${id}`;
      if (nodes.has(key)) return;
      const { label, weight, source_type } = labelFor(kind, id);
      nodes.set(key, { id: key, kind, label, weight: round(weight, 2), source_type });
    };
    for (const edge of edges) {
      addNode(edge.from_kind, edge.from_id);
      addNode(edge.to_kind, edge.to_id);
    }
    // Archived instincts fall back into the ordinary graph as isolated nodes.
    for (const skill of skills.values()) {
      if (!skill.active) addNode('skill', skill.id);
    }
    const originFor = (kind, id) => {
      if (kind === 'dream') return 'dream_generated';
      if (kind === 'episode') return episodes.get(id)?.source_type || 'agent_inferred';
      if (kind === 'habit') return schemas.get(id)?.source_type || 'agent_inferred';
      return 'agent_inferred';
    };
    return {
      nodes: [...nodes.values()].slice(0, 30),
      edges: edges.slice(0, 50).map((edge) => {
        const fromSource = originFor(edge.from_kind, edge.from_id);
        const toSource = originFor(edge.to_kind, edge.to_id);
        return {
          source: `${edge.from_kind}:${edge.from_id}`,
          target: `${edge.to_kind}:${edge.to_id}`,
          relation: edge.relation,
          weight: edge.weight,
          origin:
            fromSource === 'dream_generated' || toSource === 'dream_generated'
              ? 'dream_generated'
              : fromSource === 'user_stated' && toSource === 'user_stated'
                ? 'user_stated'
                : 'agent_inferred',
        };
      }),
    };
  }

  observeUsage({ session_id = '', turn = 0, usage = null, now = this.now() } = {}) {
    if (!usage || !this.metaEvolver?.observeUsage) return null;
    try {
      const batch = Boolean(this.contextMetabolism?.isBatchTurn?.(session_id, turn));
      return this.metaEvolver.observeUsage({
        session_id,
        turn,
        usage,
        now,
        batch,
        tiers: this.tierHashes(),
      });
    } catch (error) {
      this.logger?.warn?.(`[bionic-memory] cache usage observation failed: ${error?.message || error}`);
      return null;
    }
  }

  state(currentSessionId = '') {
    const now = this.now();
    const episodes = this.store.listEpisodes().sort((a, b) => b.t_created - a.t_created);
    const schemas = this.store.listSchemas();
    const skills = this.store.listSkills();
    const activeSkills = skills.filter((skill) => skill.active);
    const archivedSkills = skills.filter((skill) => !skill.active);
    const dreams = this.store.listDreams(4);
    const scratchpad = this.getScratchpad();
    const lastDreamAt = this.store.getMeta('last_dream_at', 0) || 0;
    const lastContactAt = this.store.getMeta('last_user_contact_at', 0) || 0;
    const sourceCounts = {
      user_stated: episodes.filter((episode) => episode.source_type === 'user_stated').length,
      agent_inferred: episodes.filter((episode) => episode.source_type === 'agent_inferred').length,
      dream_generated: episodes.filter((episode) => episode.source_type === 'dream_generated').length,
    };

    return {
      ok: true,
      generated_at: now,
      backend: this.store.kind,
      data_dir: this.dataDir,
      activation: this.config.activation,
      preset_id: this.config.presetId,
      stats: {
        ...this.store.stats(),
        sessions: new Set(episodes.map((episode) => episode.session_id).filter(Boolean)).size,
        habits_active: schemas.filter((schema) => schema.status === 'active').length,
        habits_historical: schemas.filter((schema) => schema.status === 'historical').length,
        skills_active: activeSkills.length,
        skills_archived: archivedSkills.length,
        last_dream_at: lastDreamAt,
        last_user_contact_at: lastContactAt,
      },
      sources: sourceCounts,
      active_sessions: this.activeSessionNotes(currentSessionId, now).map((note) => ({
        session_id: note.session_id,
        summary: note.summary,
        source_type: note.source_type,
        turn: note.turn,
        age: humanizeElapsed(now - note.updated_at),
      })),
      dream_cache_ready: Boolean(this.dreamCache || dreams.length),
      scratchpad: {
        mood: scratchpad.mood,
        dream_afterglow: scratchpad.dream_afterglow,
        dream_at: scratchpad.dream_at,
        curiosity_hooks: asArray(scratchpad.curiosity_hooks),
        fallibility_anchors: asArray(scratchpad.fallibility_anchors),
        pinned_open_loops: asArray(scratchpad.pinned_open_loops),
        nightmare: scratchpad.nightmare || null,
        updated_at: scratchpad.updated_at,
      },
      working_memory: episodes.slice(0, 14).map((episode) => this.publicEpisode(episode, now)),
      impressions: episodes
        .filter((episode) => this.retention(episode, now) <= this.config.fadeThreshold)
        .slice(0, 14)
        .map((episode) => this.publicEpisode(episode, now)),
      habits: schemas
        .slice()
        .sort((a, b) => (a.status === b.status ? b.last_triggered - a.last_triggered : a.status === 'active' ? -1 : 1))
        .map((schema) => ({
          ...schema,
          vector: undefined,
          age: humanizeElapsed(now - schema.last_triggered),
        })),
      skills: activeSkills.map((skill) => ({ ...skill })),
      archived_skills: archivedSkills.map((skill) => ({
        ...skill,
        age: humanizeElapsed(now - (skill.last_used || skill.created_at)),
      })),
      dreams: dreams.map((dream) => ({
        id: dream.id,
        started_at: dream.started_at,
        ended_at: dream.ended_at,
        trigger: dream.trigger,
        narrative: dream.narrative,
        afterglow: dream.afterglow,
        mood_before: dream.mood_before,
        mood_after: dream.mood_after,
        model: dream.model,
        temperature: dream.temperature,
        remembered_fraction: dream.remembered_fraction,
        nrem: dream.nrem,
        samples: dream.samples,
        age: humanizeElapsed(now - dream.started_at),
      })),
      graph: this.buildGraph(now),
      journal: this.store.listJournal(now - 7 * 86400000, 30).map((entry) => ({
        seq: entry.seq,
        at: entry.at,
        kind: entry.kind,
        summary: entry.summary,
        session_id: entry.session_id,
        age: humanizeElapsed(now - entry.at),
      })),
      context_preview: this.lastContext,
      context_render_at: this.lastContextAt,
      voice_engine: this.voiceEngine?.stateSnapshot?.() || null,
      meta_evolution: this.metaEvolver?.state?.() || null,
      context_metabolism: this.contextMetabolism?.state?.(currentSessionId) || null,
      daily_frozen: {
        day: this.dailyDay,
        compiled_at: this.dailyAt,
        bytes: this.dailyBlock.length,
        tier_hashes: this.tierHashes(),
      },
      dreaming: this.dreaming,
    };
  }

  summaryText(currentSessionId = '') {
    const state = this.state(currentSessionId);
    const stats = state.stats;
    const habits = state.habits
      .filter((habit) => habit.status === 'active')
      .slice(0, 3)
      .map((habit) => `  · ${habit.pattern_summary}（${habit.occurrence_count} 次）`)
      .join('\n');
    const skills = state.skills
      .filter((skill) => skill.active)
      .slice(0, 3)
      .map((skill) => `  · ${skill.rule}（${round(skill.confidence, 2)}）`)
      .join('\n');
    const hooks = state.scratchpad.curiosity_hooks
      .filter((hook) => !hook.resolved)
      .slice(0, 3)
      .map((hook) => `  · ${hook.text}`)
      .join('\n');
    return [
      `【仿生记忆状态】${state.backend === 'sqlite' ? 'SQLite' : 'JSON'} · ${state.data_dir}`,
      `情景 ${stats.episodes}（清晰 ${stats.episodes - stats.faded} / 褪色 ${stats.faded}）· 习惯 ${stats.habits_active} · 本能 ${stats.skills_active} · 梦 ${stats.dreams}`,
      `来源：用户亲述 ${state.sources.user_stated} / 我的推测 ${state.sources.agent_inferred} / 梦境 ${state.sources.dream_generated}`,
      `情绪：${state.scratchpad.mood?.label || '平静'}（valence ${state.scratchpad.mood?.valence ?? 0}, arousal ${state.scratchpad.mood?.arousal ?? 0.25}）`,
      state.scratchpad.dream_afterglow ? `梦境余韵：${state.scratchpad.dream_afterglow}` : '梦境余韵：（还没有）',
      state.scratchpad.fallibility_anchors?.length
        ? `记性趣事：\n${state.scratchpad.fallibility_anchors.map((anchor) => `  · ${anchor.text}`).join('\n')}`
        : '记性趣事：（还没有被纠正过）',
      habits ? `活跃习惯：\n${habits}` : '活跃习惯：（还没有形成）',
      skills ? `内化本能：\n${skills}` : '内化本能：（还没有）',
      stats.skills_archived ? `已归档本能：${stats.skills_archived} 条（不再注入）` : '已归档本能：0 条',
      state.active_sessions.length
        ? `并行窗口：\n${state.active_sessions.map((session) => `  · ${session.summary}`).join('\n')}`
        : '并行窗口：（暂无其他活跃窗口）',
      hooks ? `好奇心钩子：\n${hooks}` : '好奇心钩子：（暂无）',
      state.context_metabolism?.enabled
        ? `上下文代谢：水位 ${Math.round((state.context_metabolism.ratio || 0) * 100)}% · 工具脱水 ${state.context_metabolism.dehydrated?.count || 0} 条 · 折叠 ${state.context_metabolism.collapsed ? `第${state.context_metabolism.collapsed.first_turn}-${state.context_metabolism.collapsed.last_turn}轮` : '未触发'} · 未完成话题 ${state.context_metabolism.open_loops?.length || 0}`
        : '',
      state.voice_engine
        ? `语感：熟稔度 ${Number(state.voice_engine.familiarity?.score || 0).toFixed(2)}（${state.voice_engine.familiarity?.level || '初识'}） · 传染词 ${state.voice_engine.acquired_vocabulary?.map((entry) => entry.word).slice(0, 5).join('、') || '还没'} · 语感笔记 ${state.voice_engine.self_discovered_voice_notes?.length || 0} 条`
        : '',
    ].join('\n');
  }

  close() {
    try {
      this.voiceEngine?.close?.();
    } catch {
      /* ignore */
    }
    try {
      this.contextMetabolism?.close?.();
    } catch {
      /* ignore */
    }
    try {
      this.store.flush?.();
    } catch {
      /* nothing to flush */
    }
    try {
      this.store.close?.();
    } catch {
      /* already closed */
    }
  }
}
