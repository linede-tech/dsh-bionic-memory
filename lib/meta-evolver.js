/**
 * meta-evolver — meta-cognition, self-tuning, prompt evolution and
 * proposal-only self-coding for dsh-bionic-memory.
 *
 * Safety model:
 *   • every mutation is snapshotted in .dsh/bionic-memory (Git when available);
 *   • Tier 1 config and Tier 2 prompt changes run a dry-run and a 3-day trial;
 *   • Tier 3 never auto-applies code: it writes reviewable proposals under
 *     proposals/ and only /evolve approve may apply one, after a source backup
 *     and dry-run tests;
 *   • any failed apply is rolled back and recorded as a "nightmare" in the
 *     subconscious scratchpad.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  PRAISE_RE,
  clamp,
  formatDateTime,
  isoDate,
  keywords,
  sentiment,
  shortRule,
  startOfLocalDay,
  textSimilarity,
} from './text.js';

const TUNED_FIELDS = [
  'defaultS0',
  's0Multiplier',
  'similarityThreshold',
  'fallibilityChanceMin',
  'fallibilityChanceMax',
  'contextCharBudget',
  'dreamTemperature',
];

const FRICTION_RE =
  /记错|记混|记串|你忘了|又忘|我说过(?:很多|好几)?次|说过多少遍|怎么又|不耐烦|失望|烦死|崩溃|听不懂|不是这样|不对|你搞错|弄错|重复|纠正你|你记性|没记住|没印象|不记得|你怎么回事|别再说|闭嘴|stop forgetting|i told you|you forgot|again|wrong|mixed up/gi;

const PROMPT_REQUIRED = [
  '<system_identity_and_cognitive_rules>',
  '</system_identity_and_cognitive_rules>',
  '记忆来源防伪',
  '受控记忆失真',
  '安全豁免红线',
];

const PROMPT_BLOCK_OPEN = '<evolved_expression_guidance';
const PROMPT_BLOCK_CLOSE = '</evolved_expression_guidance>';

const SKILL_GUIDE_FALLBACK = `cordis-plugin-development（内嵌摘要）：
- 在 workspace 内编写 bundle：package.json 的 dsh.bundle.patch 指向 cordis.patch.yml；不要直接改 profile 的 package.json / cordis.patch.yml。
- Host 插件导出 name/inject/apply(ctx, config)；Client 插件在 package.json 的 dsh.client 声明，并由 window.__ModuleLoader__.load 挂载。
- 只用 cordis_inspect_* 查证 API；安装/重载使用 plugin_manager 的 install_bundle（绝对目录）。
- 任何自改代码都必须先快照、先做语法检查与测试，再请求用户审批；不要自动执行不可逆操作。
- 保留现有 XML 标签、工具/命令契约与测试；优先新增独立扩展模块而不是重写核心。`;

function readJson(file, fallback = null) {
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

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(text), 'utf8');
}

function hash(text) {
  return createHash('sha256').update(String(text || '')).digest('hex');
}

function parseJsonLoose(text) {
  if (!text) return null;
  let clean = String(text).trim();
  const fenced = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) clean = fenced[1].trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(clean.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeGuidance(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim())
    .filter((item) => item.length >= 6 && item.length <= 140)
    .slice(0, 4);
}

function safeRelative(base, relative) {
  const root = path.resolve(base);
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
  return target;
}

function fileExtension(relative) {
  return path.extname(relative).toLowerCase();
}

function allowedProposalPath(relative) {
  if (!relative || path.isAbsolute(relative) || relative.includes('..')) return false;
  const normalized = relative.replace(/\\/g, '/');
  const ext = fileExtension(normalized);
  if (!['.js', '.mjs', '.cjs', '.ts', '.json', '.md'].includes(ext)) return false;
  return (
    normalized === 'index.js'
    || normalized === 'README.md'
    || normalized.startsWith('lib/')
    || normalized.startsWith('meta-evolver/')
    || normalized.startsWith('test/')
    || normalized.startsWith('docs/')
  );
}

function copyFileIfExists(source, target) {
  if (!fs.existsSync(source)) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return true;
}

export class MetaEvolver {
  constructor({ engine, store, config, dataDir, logger, llm, packageDir, basePrompt, reload }) {
    this.engine = engine;
    this.store = store;
    this.config = config;
    this.dataDir = dataDir;
    this.logger = logger;
    this.llm = llm;
    this.packageDir = packageDir;
    this.basePrompt = String(basePrompt || '').trim();
    this.reload = typeof reload === 'function' ? reload : null;
    this.clock = typeof engine?.now === 'function' ? () => engine.now() : () => Date.now();

    this.telemetryFile = path.join(dataDir, 'telemetry.json');
    this.configFile = path.join(dataDir, 'config.json');
    this.evolutionFile = path.join(dataDir, 'meta-evolution.json');
    this.promptFile = path.join(dataDir, 'prompt-template.md');
    this.proposalsDir = path.join(dataDir, 'proposals');
    this.snapshotsDir = path.join(dataDir, 'snapshots');
    this.pendingApplyFile = path.join(dataDir, 'pending-apply.json');

    this.telemetry = null;
    this.evolution = null;
    this.activePromptText = this.basePrompt;
    this.activeGuidance = [];
    this.loaded = false;
    this.lastNightmare = null;
  }

  now() {
    return this.clock();
  }

  log(level, message) {
    try {
      this.logger?.[level]?.(`[bionic-memory:meta] ${message}`);
    } catch {
      /* logging is best-effort */
    }
  }

  // --------------------------------------------------------------- lifecycle

  init() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(this.proposalsDir, { recursive: true });
    fs.mkdirSync(this.snapshotsDir, { recursive: true });
    this.telemetry = this.loadTelemetry();
    this.evolution = this.loadEvolution();
    this.saveTelemetry();
    this.saveEvolution();
    this.applyConfigOverrides();
    this.loadPrompt();
    this.lastNightmare = this.evolution.last_nightmare || this.engine?.getScratchpad?.()?.nightmare || null;
    this.loaded = true;
    // A proposal that was being hot-applied when the previous process ended is
    // validated on the new boot before it is accepted.
    Promise.resolve()
      .then(() => this.finishPendingApply())
      .catch((error) => this.log('warn', `pending-apply check failed: ${error?.message || error}`));
    return this;
  }

  loadTelemetry() {
    const stored = readJson(this.telemetryFile, null);
    return {
      version: 1,
      updated_at: 0,
      totals: {
        turns: 0,
        injected: 0,
        referenced: 0,
        friction: 0,
        resonance: 0,
        context_chars: 0,
        turn_chars: 0,
      },
      cache: {
        rounds: 0,
        batch_rounds: 0,
        hits: 0,
        misses: 0,
        saved_tokens: 0,
        last_ratio: 0,
        last_hits: 0,
        last_misses: 0,
        last_at: 0,
        last_batch: false,
        low_streak: 0,
        streak_tier0_changed: false,
        streak_tier1_changed: false,
        streak_tierTools_changed: false,
        tier0_changed: false,
        tier1_changed: false,
        tierTools_changed: false,
        last_tiers: null,
      },
      days: {},
      sessions: [],
      examples: { friction: [], resonance: [] },
      ...(stored && typeof stored === 'object' ? stored : {}),
    };
  }

  saveTelemetry() {
    this.telemetry.updated_at = this.now();
    writeJson(this.telemetryFile, this.telemetry);
  }

  loadEvolution() {
    const stored = readJson(this.evolutionFile, null);
    return {
      version: 1,
      updated_at: 0,
      sessions_since_prompt: 0,
      last_prompt_at: 0,
      last_code_proposal_at: 0,
      last_tier1_at: 0,
      prompt_version: 0,
      prompt_guidance: [],
      prompt_base_hash: hash(this.basePrompt),
      history: [],
      pending_proposals: [],
      last_nightmare: null,
      last_snapshot: '',
      resonance_rewards: 0,
      cache_alert: null,
      ...(stored && typeof stored === 'object' ? stored : {}),
    };
  }

  saveEvolution() {
    this.evolution.updated_at = this.now();
    writeJson(this.evolutionFile, this.evolution);
  }

  // ------------------------------------------------------------ config tuning

  applyConfigOverrides() {
    const stored = readJson(this.configFile, null);
    const values = stored?.values && typeof stored.values === 'object' ? stored.values : {};
    for (const field of TUNED_FIELDS) {
      const value = Number(values[field]);
      if (Number.isFinite(value)) this.setConfigValue(field, value);
    }
    // Keep the fallibility chance pair ordered even if the file was edited.
    if (this.config.fallibilityChanceMax < this.config.fallibilityChanceMin) {
      this.config.fallibilityChanceMax = this.config.fallibilityChanceMin;
    }
  }

  setConfigValue(field, value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    if (field === 'defaultS0') this.config.defaultS0 = clamp(numeric, 12, 168);
    if (field === 's0Multiplier') this.config.s0Multiplier = clamp(numeric, 0.5, 3);
    if (field === 'similarityThreshold') this.config.similarityThreshold = clamp(numeric, 0, 0.6);
    if (field === 'fallibilityChanceMin') this.config.fallibilityChanceMin = clamp(numeric, 0.02, 0.6);
    if (field === 'fallibilityChanceMax') this.config.fallibilityChanceMax = clamp(numeric, 0.02, 0.8);
    if (field === 'contextCharBudget') this.config.contextCharBudget = clamp(numeric, 1200, 8000);
    if (field === 'dreamTemperature') this.config.dreamTemperature = clamp(numeric, 0.5, 1.8);
  }

  currentTunedValues() {
    return {
      defaultS0: this.config.defaultS0,
      s0Multiplier: this.config.s0Multiplier,
      similarityThreshold: this.config.similarityThreshold,
      fallibilityChanceMin: this.config.fallibilityChanceMin,
      fallibilityChanceMax: this.config.fallibilityChanceMax,
      contextCharBudget: this.config.contextCharBudget,
      dreamTemperature: this.config.dreamTemperature,
    };
  }

  writeConfigFile(values = this.currentTunedValues()) {
    writeJson(this.configFile, {
      version: 1,
      updated_at: this.now(),
      source: 'meta-evolver',
      values: Object.fromEntries(
        TUNED_FIELDS.filter((field) => Number.isFinite(Number(values[field]))).map((field) => [field, Number(values[field])]),
      ),
    });
  }

  dryRunConfig() {
    const stored = readJson(this.configFile, null);
    if (!stored || typeof stored.values !== 'object') throw new Error('config.json is not parseable');
    const values = stored.values;
    for (const field of TUNED_FIELDS) {
      const value = Number(values[field]);
      if (!Number.isFinite(value)) throw new Error(`invalid tuned value for ${field}`);
    }
    if (values.fallibilityChanceMin > values.fallibilityChanceMax) throw new Error('confusion rate range is inverted');
    if (values.contextCharBudget < 1200 || values.contextCharBudget > 8000) throw new Error('contextCharBudget out of bounds');
    if (values.similarityThreshold < 0 || values.similarityThreshold > 0.6) throw new Error('similarityThreshold out of bounds');
    if (values.defaultS0 < 12 || values.defaultS0 > 168) throw new Error('defaultS0 out of bounds');
    if (values.s0Multiplier < 0.5 || values.s0Multiplier > 3) throw new Error('s0Multiplier out of bounds');
    // Exercise the retention math with the effective S0.
    const effectiveS0 = values.defaultS0 * values.s0Multiplier;
    const r = Math.exp(-24 / Math.max(0.001, effectiveS0 * 1 * (1 + 0.3 * 0)));
    if (!Number.isFinite(r) || r <= 0 || r > 1) throw new Error('retention dry-run failed');
    return true;
  }

  // ---------------------------------------------------------------- telemetry

  ensureDay(now = this.now()) {
    const key = isoDate(now);
    if (!this.telemetry.days[key]) {
      this.telemetry.days[key] = {
        day: key,
        day_start: startOfLocalDay(now),
        turns: 0,
        injected: 0,
        referenced: 0,
        friction: 0,
        resonance: 0,
        context_chars: 0,
        turn_chars: 0,
        cache_hits: 0,
        cache_misses: 0,
        cache_saved_tokens: 0,
        cache_rounds: 0,
        cache_batch_rounds: 0,
      };
    }
    return this.telemetry.days[key];
  }

  computeMetrics(day) {
    const turns = Number(day?.turns) || 0;
    const injected = Number(day?.injected) || 0;
    const referenced = Number(day?.referenced) || 0;
    const friction = Number(day?.friction) || 0;
    const resonance = Number(day?.resonance) || 0;
    const contextChars = Number(day?.context_chars) || 0;
    const turnChars = Number(day?.turn_chars) || 0;
    const cacheHits = Number(day?.cache_hits) || 0;
    const cacheMisses = Number(day?.cache_misses) || 0;
    const cacheTotal = cacheHits + cacheMisses;
    return {
      turns,
      injected,
      referenced,
      friction,
      resonance,
      memory_utility_rate: injected ? referenced / injected : 0,
      user_friction_count: friction,
      friction_rate: turns ? friction / turns : 0,
      resonance_score: turns ? resonance / turns : 0,
      token_overhead: turnChars ? contextChars / turnChars : 0,
      context_chars: contextChars,
      turn_chars: turnChars,
      cache_hits: cacheHits,
      cache_misses: cacheMisses,
      cache_hit_ratio: cacheTotal ? cacheHits / cacheTotal : 0,
      cache_saved_tokens: Number(day?.cache_saved_tokens) || 0,
      cache_rounds: Number(day?.cache_rounds) || 0,
      cache_batch_rounds: Number(day?.cache_batch_rounds) || 0,
    };
  }

  emptyMetrics() {
    return this.computeMetrics(null);
  }

  metricsForDay(now = this.now()) {
    return this.computeMetrics(this.telemetry.days[isoDate(now)]);
  }

  metricsRange(from, to) {
    const start = startOfLocalDay(from);
    const end = startOfLocalDay(to) + 86400000 - 1;
    const aggregate = {
      turns: 0,
      injected: 0,
      referenced: 0,
      friction: 0,
      resonance: 0,
      context_chars: 0,
      turn_chars: 0,
      cache_hits: 0,
      cache_misses: 0,
      cache_saved_tokens: 0,
      cache_rounds: 0,
      cache_batch_rounds: 0,
    };
    for (const day of Object.values(this.telemetry.days)) {
      if (!day || day.day_start < start || day.day_start > end) continue;
      aggregate.turns += day.turns || 0;
      aggregate.injected += day.injected || 0;
      aggregate.referenced += day.referenced || 0;
      aggregate.friction += day.friction || 0;
      aggregate.resonance += day.resonance || 0;
      aggregate.context_chars += day.context_chars || 0;
      aggregate.turn_chars += day.turn_chars || 0;
      aggregate.cache_hits += day.cache_hits || 0;
      aggregate.cache_misses += day.cache_misses || 0;
      aggregate.cache_saved_tokens += day.cache_saved_tokens || 0;
      aggregate.cache_rounds += day.cache_rounds || 0;
      aggregate.cache_batch_rounds += day.cache_batch_rounds || 0;
    }
    return this.computeMetrics(aggregate);
  }

  observeTurn({ session_id = '', turn = 0, user_text = '', assistant_text = '', now = this.now(), injection = null } = {}) {
    if (!this.loaded) return null;
    const user = String(user_text || '');
    const assistant = String(assistant_text || '');
    if (!user && !assistant) return null;
    const day = this.ensureDay(now);

    const frictionMatches = user.match(FRICTION_RE) || [];
    const friction = Math.min(3, frictionMatches.length);
    const injectionFresh = injection && now - (injection.at || 0) <= 30 * 60 * 1000;
    const snippets = injectionFresh ? injection.snippets || [] : [];
    const utilityHits = snippets.filter((snippet) => {
      const text = String(snippet.text || '');
      if (text && textSimilarity(assistant, text) >= 0.2) return true;
      return (snippet.keywords || []).some(
        (keyword) => typeof keyword === 'string' && keyword.length >= 2 && assistant.includes(keyword),
      );
    }).length;
    const memoryInteraction = Boolean(
      injectionFresh
      && (injection.dreamResidue || injection.habitCount > 0 || injection.distortionType || injection.fallibilityAnchor),
    );
    const positive = PRAISE_RE.test(user) || sentiment(user).valence > 0.2;
    const longTurn = user.length + assistant.length >= 180;
    const resonance = memoryInteraction && (positive || longTurn) ? 1 : 0;

    const turnChars = user.length + assistant.length;
    const contextChars = injectionFresh ? Number(injection.contextChars) || 0 : 0;

    day.turns += 1;
    day.injected += snippets.length;
    day.referenced += utilityHits;
    day.friction += friction;
    day.resonance += resonance;
    day.context_chars += contextChars;
    day.turn_chars += turnChars;
    this.telemetry.totals.turns += 1;
    this.telemetry.totals.injected += snippets.length;
    this.telemetry.totals.referenced += utilityHits;
    this.telemetry.totals.friction += friction;
    this.telemetry.totals.resonance += resonance;
    this.telemetry.totals.context_chars += contextChars;
    this.telemetry.totals.turn_chars += turnChars;

    if (friction > 0) {
      this.telemetry.examples.friction = [
        { at: now, user: shortRule(user, 220) },
        ...this.telemetry.examples.friction,
      ].slice(0, 3);
    }
    if (resonance > 0) {
      this.telemetry.examples.resonance = [
        { at: now, user: shortRule(user, 180), assistant: shortRule(assistant, 220) },
        ...this.telemetry.examples.resonance,
      ].slice(0, 3);
    }
    const id = String(session_id || '');
    if (id && !this.telemetry.sessions.includes(id)) {
      this.telemetry.sessions.push(id);
      this.telemetry.sessions = this.telemetry.sessions.slice(-200);
      this.evolution.sessions_since_prompt = (this.evolution.sessions_since_prompt || 0) + 1;
      this.saveEvolution();
    }
    this.saveTelemetry();
    return this.computeMetrics(day);
  }

  observeUsage({ session_id = '', turn = 0, usage = null, now = this.now(), batch = false, tiers = null } = {}) {
    if (!this.loaded || !usage) return null;
    const hits = Number(
      usage.prompt_cache_hit_tokens ?? usage.cacheReadTokens ?? usage.cachedInputTokens ?? usage.cache_read_input_tokens ?? 0,
    ) || 0;
    const inputTokens = Number(usage.inputTokens ?? usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
    let misses = Number(usage.prompt_cache_miss_tokens ?? usage.cacheMissTokens ?? 0) || 0;
    if (!misses && inputTokens > hits) misses = inputTokens - hits;
    if (!hits && !misses) return null;
    const total = hits + misses;
    const ratio = total ? hits / total : 0;
    const day = this.ensureDay(now);
    const cache = this.telemetry.cache;
    cache.rounds += 1;
    cache.hits += hits;
    cache.misses += misses;
    cache.saved_tokens += hits;
    cache.last_ratio = ratio;
    cache.last_hits = hits;
    cache.last_misses = misses;
    cache.last_at = now;
    cache.last_batch = Boolean(batch);
    day.cache_hits += hits;
    day.cache_misses += misses;
    day.cache_saved_tokens += hits;
    day.cache_rounds += 1;
    const previousTiers = cache.last_tiers;
    cache.tier0_changed = Boolean(tiers && previousTiers && tiers.tier0 !== previousTiers.tier0);
    cache.tier1_changed = Boolean(tiers && previousTiers && tiers.tier1 !== previousTiers.tier1);
    cache.tierTools_changed = Boolean(
      tiers && previousTiers && String(tiers.tierTools || '') !== String(previousTiers.tierTools || ''),
    );
    if (tiers) cache.last_tiers = tiers;
    if (batch) {
      cache.batch_rounds += 1;
      day.cache_batch_rounds += 1;
    } else {
      if (ratio < 0.7) {
        cache.low_streak += 1;
        cache.streak_tier0_changed = Boolean(cache.streak_tier0_changed || cache.tier0_changed);
        cache.streak_tier1_changed = Boolean(cache.streak_tier1_changed || cache.tier1_changed);
        cache.streak_tierTools_changed = Boolean(cache.streak_tierTools_changed || cache.tierTools_changed);
      } else {
        cache.low_streak = 0;
        cache.streak_tier0_changed = false;
        cache.streak_tier1_changed = false;
        cache.streak_tierTools_changed = false;
      }
    }
    if (!batch && cache.low_streak >= 3) {
      const hint = cache.streak_tier0_changed
        ? 'Tier 0 静态规则发生变化：检查 system-prompt section 是否被动态时间戳/UUID/召回内容污染。'
        : cache.streak_tier1_changed
          ? 'Tier 1 每日冻结块发生变化：可能刚重编译，或每日块被动态字段污染。'
          : cache.streak_tierTools_changed
            ? 'Tier 0 工具 Schema 的集合或键序发生变化：检查路由工具是否按字典序稳定排序。'
            : '连续低命中：检查工具 Schema 顺序、模型路由是否变化，以及是否有动态字段混入 Tier 0/Tier 1。';
      const alert = {
        at: now,
        ratio: Math.round(ratio * 1000) / 1000,
        low_streak: cache.low_streak,
        tier0_changed: cache.streak_tier0_changed,
        tier1_changed: cache.streak_tier1_changed,
        tierTools_changed: cache.streak_tierTools_changed,
        hint,
        active: true,
        batch_excluded: true,
      };
      this.evolution.cache_alert = alert;
      this.journal('cache_alert', `KV 缓存连续 ${cache.low_streak} 轮低于 70%（最近 ${Math.round(ratio * 100)}%）：${hint}`);
    } else if (ratio >= 0.7 && this.evolution.cache_alert?.active) {
      this.evolution.cache_alert = {
        ...this.evolution.cache_alert,
        active: false,
        resolved_at: now,
      };
    }
    this.saveTelemetry();
    this.saveEvolution();
    return {
      ratio,
      hits,
      misses,
      saved_tokens: hits,
      low_streak: cache.low_streak,
      batch: Boolean(batch),
      alert: this.evolution.cache_alert?.active ? this.evolution.cache_alert : null,
    };
  }

  cacheState() {
    const cache = this.telemetry.cache || {};
    const day = this.metricsForDay();
    const total = (Number(cache.hits) || 0) + (Number(cache.misses) || 0);
    return {
      hit_ratio: total ? (Number(cache.hits) || 0) / total : 0,
      saved_tokens: Number(cache.saved_tokens) || 0,
      rounds: Number(cache.rounds) || 0,
      batch_rounds: Number(cache.batch_rounds) || 0,
      last_ratio: Number(cache.last_ratio) || 0,
      last_hits: Number(cache.last_hits) || 0,
      last_misses: Number(cache.last_misses) || 0,
      last_at: Number(cache.last_at) || 0,
      last_batch: Boolean(cache.last_batch),
      low_streak: Number(cache.low_streak) || 0,
      today_hit_ratio: day.cache_hit_ratio,
      today_saved_tokens: day.cache_saved_tokens,
      today_rounds: day.cache_rounds,
      today_batch_rounds: day.cache_batch_rounds,
      tier0_changed: Boolean(cache.tier0_changed),
      tier1_changed: Boolean(cache.tier1_changed),
      tierTools_changed: Boolean(cache.tierTools_changed),
      alert: this.evolution.cache_alert?.active ? this.evolution.cache_alert : null,
    };
  }

  // ------------------------------------------------------------------ prompt

  extractGuidance(text) {
    const source = String(text || '');
    const start = source.indexOf(PROMPT_BLOCK_OPEN);
    if (start < 0) return { guidance: [], text: source };
    const close = source.indexOf(PROMPT_BLOCK_CLOSE, start);
    if (close < 0) return { guidance: [], text: source };
    const block = source.slice(start, close + PROMPT_BLOCK_CLOSE.length);
    const guidance = normalizeGuidance(
      block
        .split('\n')
        .slice(1)
        .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
        .filter((line) => line && !line.includes(PROMPT_BLOCK_CLOSE)),
    );
    return {
      guidance,
      text: `${source.slice(0, start)}${source.slice(close + PROMPT_BLOCK_CLOSE.length)}`,
    };
  }

  buildPrompt(guidance, version = this.evolution?.prompt_version || 0) {
    const base = String(this.basePrompt || '').trim();
    if (!base) return '';
    const stripped = this.extractGuidance(base).text.trimEnd();
    const items = normalizeGuidance(guidance);
    if (!items.length) return stripped;
    const marker = '</system_identity_and_cognitive_rules>';
    const at = stripped.lastIndexOf(marker);
    const block = [
      `<evolved_expression_guidance version="${version}" evolved_at="${formatDateTime(this.now())}">`,
      ...items.map((item) => `  - ${item}`),
      '</evolved_expression_guidance>',
    ].join('\n');
    if (at < 0) return `${stripped}\n${block}\n`;
    return `${stripped.slice(0, at).trimEnd()}\n${block}\n${stripped.slice(at)}`;
  }

  validatePrompt(text) {
    const value = String(text || '');
    if (!value || value.length < 800 || value.length > 16000) throw new Error('prompt length out of bounds');
    for (const required of PROMPT_REQUIRED) {
      if (!value.includes(required)) throw new Error(`prompt lost required marker: ${required}`);
    }
    const opens = (value.match(/<system_identity_and_cognitive_rules>/g) || []).length;
    const closes = (value.match(/<\/system_identity_and_cognitive_rules>/g) || []).length;
    if (opens !== 1 || closes !== 1) throw new Error('prompt XML structure is unbalanced');
    if (/<script|javascript:/i.test(value)) throw new Error('prompt contains unsafe marker');
    return true;
  }

  loadPrompt() {
    this.activeGuidance = [];
    this.activePromptText = this.basePrompt;
    try {
      if (fs.existsSync(this.promptFile)) {
        const working = fs.readFileSync(this.promptFile, 'utf8');
        const extracted = this.extractGuidance(working);
        this.activeGuidance = normalizeGuidance(extracted.guidance);
        const rebuilt = this.buildPrompt(this.activeGuidance, this.evolution.prompt_version || 0);
        if (rebuilt) {
          this.activePromptText = rebuilt;
          this.validatePrompt(rebuilt);
          if (rebuilt !== working) writeText(this.promptFile, rebuilt);
        }
      }
    } catch (error) {
      this.log('warn', `prompt override ignored: ${error?.message || error}`);
      this.activePromptText = this.basePrompt;
      this.activeGuidance = [];
    }
    if (!this.activePromptText) this.activePromptText = this.basePrompt;
    this.evolution.prompt_base_hash = hash(this.basePrompt);
  }

  activePrompt() {
    return this.activePromptText || this.basePrompt;
  }

  deterministicGuidance(metrics) {
    const items = [];
    if (metrics.user_friction_count > 0 || metrics.friction_rate >= 0.25) {
      items.push('当用户重复解释或显得不耐烦时，先复述你理解到的关键需求，再给答案；不要用“我明白了”“好的”这类空话收尾。');
      items.push('发现自己记错时，先承认具体错在哪里，再改正；不要用长篇解释掩盖记忆的不确定。');
    }
    if (metrics.memory_utility_rate > 0 && metrics.memory_utility_rate < 0.35) {
      items.push('旧记忆只在能推进当前话题时轻轻带一句；不要为了展示记性而主动复述无关的旧事。');
    }
    if (metrics.resonance_score >= 0.5) {
      items.push('保留具体的细节、停顿和一点点自嘲；不要把所有感受都总结成抽象结论。');
    }
    if (metrics.token_overhead > 0.45) {
      items.push('引用记忆时只取一个最小细节，不要把整段回忆铺开；让对话留白。');
    }
    if (!items.length) {
      items.push('保持短句、具体细节和自然的停顿；不确定的记忆先说不确定，不要补全成确定的事实。');
      items.push('对用户的情绪先回应，再处理信息；不要把每次对话都变成总结报告。');
    }
    return items.slice(0, 4);
  }

  async generateGuidance(metrics) {
    const fallback = this.deterministicGuidance(metrics);
    if (!this.llm?.generate || !this.config.llmEnabled) return { guidance: fallback, source: 'deterministic' };
    const frictionExamples = (this.telemetry.examples.friction || []).slice(0, 3);
    const resonanceExamples = (this.telemetry.examples.resonance || []).slice(0, 3);
    const system =
      '你是这个人格的元认知编辑器。只修改表达方式和关系距离，不修改记忆事实、不删除安全铁律、不改变 XML 标签结构。只输出严格 JSON：{"guidance":["..."],"rationale":"..."}。';
    const prompt = [
      '当前人格提示词：',
      this.activePrompt(),
      '',
      `近 7 天遥测：${JSON.stringify(metrics)}`,
      `高摩擦样本：${JSON.stringify(frictionExamples)}`,
      `高共鸣样本：${JSON.stringify(resonanceExamples)}`,
      '',
      '请写 2-4 条简洁的中文表达指导，解决口癖重复、关系距离或记忆引用方式的问题。',
      '每条 20-120 字，不要出现 < 或 >，不要写具体记忆事实，不要删掉任何安全规则。',
    ].join('\n');
    try {
      const text = await this.llm.generate({
        system,
        prompt,
        maxTokens: 700,
        temperature: 0.7,
        reasoningEffort: 'off',
      });
      const parsed = parseJsonLoose(text);
      const guidance = normalizeGuidance(parsed?.guidance);
      if (!guidance.length) return { guidance: fallback, source: 'deterministic-fallback' };
      return { guidance, rationale: String(parsed?.rationale || '').slice(0, 400), source: 'llm' };
    } catch (error) {
      this.log('warn', `guidance generation failed: ${error?.message || error}`);
      return { guidance: fallback, source: 'deterministic-fallback' };
    }
  }

  async mutatePrompt({ force = false } = {}) {
    const metrics = this.metricsRange(this.now() - 7 * 86400000, this.now());
    if (!force && !this.promptMutationDue()) {
      return { changed: false, skipped: 'not-due', metrics };
    }
    const snapshot = this.snapshot('tier2-prompt-before');
    const beforePrompt = this.activePrompt();
    const beforeGuidance = [...this.activeGuidance];
    const beforeVersion = this.evolution.prompt_version || 0;
    const generated = await this.generateGuidance(metrics);
    const version = beforeVersion + 1;
    const nextPrompt = this.buildPrompt(generated.guidance, version);
    try {
      this.validatePrompt(nextPrompt);
    } catch (error) {
      this.restoreSnapshot(snapshot);
      this.noteNightmare(`提示词进化未通过自检，已回滚：${error?.message || error}`);
      return { changed: false, error: String(error?.message || error), snapshot };
    }
    writeText(this.promptFile, nextPrompt);
    this.activePromptText = nextPrompt;
    this.activeGuidance = generated.guidance;
    this.evolution.prompt_version = version;
    this.evolution.prompt_guidance = generated.guidance;
    this.evolution.sessions_since_prompt = 0;
    this.evolution.last_prompt_at = this.now();
    this.evolution.last_nightmare = this.evolution.last_nightmare || null;
    const trial = this.recordEvolution({
      tier: 2,
      status: 'trial',
      summary: `表达指导进化 v${version}：${generated.guidance[0] || ''}`,
      changes: {
        prompt: { from: beforePrompt, to: nextPrompt },
        guidance: generated.guidance,
        guidanceBefore: beforeGuidance,
        versionBefore: beforeVersion,
      },
      baseline: metrics,
      snapshot,
      trialUntil: this.now() + this.config.metaEvolutionTrialDays * 86400000,
      meta: { source: generated.source, rationale: generated.rationale || '' },
    });
    this.saveEvolution();
    return {
      changed: true,
      tier: 2,
      trial,
      snapshot,
      guidance: generated.guidance,
      source: generated.source,
      summary: `表达指导已更新到 v${version}，进入 ${this.config.metaEvolutionTrialDays} 天试用期`,
    };
  }

  promptMutationDue() {
    if (!this.evolution.last_prompt_at) return (this.evolution.sessions_since_prompt || 0) >= this.config.metaEvolutionPromptSessions;
    return (
      (this.evolution.sessions_since_prompt || 0) >= this.config.metaEvolutionPromptSessions
      || this.now() - this.evolution.last_prompt_at >= this.config.metaEvolutionPromptDays * 86400000
    );
  }

  restorePrompt(beforePrompt, beforeGuidance, beforeVersion) {
    try {
      this.activePromptText = beforePrompt || this.basePrompt;
      this.activeGuidance = Array.isArray(beforeGuidance) ? beforeGuidance : this.extractGuidance(this.activePromptText).guidance;
      this.evolution.prompt_version = beforeVersion || 0;
      this.evolution.prompt_guidance = this.activeGuidance;
      if (this.activePromptText && this.activePromptText !== this.basePrompt) {
        writeText(this.promptFile, this.activePromptText);
      } else {
        try {
          fs.rmSync(this.promptFile, { force: true });
        } catch {
          /* ignore */
        }
      }
    } catch (error) {
      this.log('warn', `prompt restore failed: ${error?.message || error}`);
    }
  }

  // ---------------------------------------------------------------- snapshots

  ensureRepo() {
    try {
      writeText(
        path.join(this.dataDir, '.gitignore'),
        ['memory.db', '*.db-wal', '*.db-shm', 'snapshots/', 'pending-apply.json', 'context-archive/', ''].join('\n'),
      );
    } catch {
      /* best effort */
    }
    if (fs.existsSync(path.join(this.dataDir, '.git'))) return true;
    try {
      execFileSync('git', ['init'], { cwd: this.dataDir, stdio: 'ignore', timeout: 10000 });
      return true;
    } catch (error) {
      this.log('warn', `git init failed, using file snapshots: ${error?.message || error}`);
      return false;
    }
  }

  snapshot(label = 'snapshot') {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const id = `snap-${stamp}`;
    const backup = path.join(this.snapshotsDir, id);
    const files = [
      'config.json',
      'prompt-template.md',
      'meta-evolution.json',
      'telemetry.json',
      'proposals',
      '.gitignore',
    ];
    fs.mkdirSync(backup, { recursive: true });
    for (const relative of files) {
      const source = path.join(this.dataDir, relative);
      if (!fs.existsSync(source)) continue;
      const target = path.join(backup, relative);
      try {
        fs.cpSync(source, target, { recursive: true });
      } catch {
        try {
          copyFileIfExists(source, target);
        } catch {
          /* best effort */
        }
      }
    }
    const manifest = { id, label, at: this.now(), files };
    writeJson(path.join(backup, 'manifest.json'), manifest);
    let git = null;
    try {
      if (this.ensureRepo()) {
        execFileSync('git', ['add', '-A'], { cwd: this.dataDir, stdio: 'ignore', timeout: 20000 });
        execFileSync(
          'git',
          [
            '-c',
            'user.name=bionic-memory',
            '-c',
            'user.email=bionic-memory@local',
            'commit',
            '--allow-empty',
            '-m',
            `${label} ${new Date(this.now()).toISOString()}`,
          ],
          { cwd: this.dataDir, stdio: 'ignore', timeout: 20000 },
        );
        git = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: this.dataDir, encoding: 'utf8', timeout: 10000 }).trim();
      }
    } catch (error) {
      this.log('warn', `git snapshot failed: ${error?.message || error}`);
    }
    const record = { id, at: this.now(), label, dir: backup, git };
    this.evolution.last_snapshot = record;
    this.saveEvolution();
    return record;
  }

  restoreSnapshot(snapshot) {
    if (!snapshot) return false;
    try {
      if (snapshot.git) {
        execFileSync('git', ['checkout', snapshot.git, '--', '.'], {
          cwd: this.dataDir,
          stdio: 'ignore',
          timeout: 20000,
        });
        this.telemetry = this.loadTelemetry();
        this.evolution = this.loadEvolution();
        this.applyConfigOverrides();
        this.loadPrompt();
        this.saveEvolution();
        return true;
      }
      if (snapshot.dir && fs.existsSync(snapshot.dir)) {
        for (const relative of ['config.json', 'prompt-template.md', 'meta-evolution.json', 'telemetry.json']) {
          const source = path.join(snapshot.dir, relative);
          const target = path.join(this.dataDir, relative);
          if (fs.existsSync(source)) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(source, target);
          }
        }
        this.telemetry = this.loadTelemetry();
        this.evolution = this.loadEvolution();
        this.applyConfigOverrides();
        this.loadPrompt();
        this.saveEvolution();
        return true;
      }
    } catch (error) {
      this.log('warn', `snapshot restore failed: ${error?.message || error}`);
    }
    return false;
  }

  // --------------------------------------------------------------- evolution

  recordEvolution({
    tier,
    status,
    summary,
    changes = {},
    baseline = null,
    snapshot = null,
    trialUntil = 0,
    sourceBackup = null,
    proposalId = '',
    meta = {},
  }) {
    const record = {
      id: `evo-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      at: this.now(),
      tier,
      status,
      summary: shortRule(summary, 320),
      changes,
      baseline,
      snapshot,
      trial_until: trialUntil,
      source_backup: sourceBackup,
      proposal_id: proposalId,
      ...meta,
    };
    this.evolution.history = [record, ...(this.evolution.history || [])].slice(0, 80);
    this.saveEvolution();
    return record;
  }

  activeTrials() {
    return (this.evolution.history || []).filter((record) => record.status === 'trial');
  }

  frictionWorsened(record) {
    if (!record?.at) return false;
    const trialEnd = Math.min(record.trial_until || this.now(), this.now());
    const trial = this.metricsRange(record.at, trialEnd);
    const baselineEnd = record.at - 1;
    const baselineStart = record.at - 7 * 86400000;
    const baseline = this.metricsRange(baselineStart, baselineEnd);
    if (trial.turns < 2 || trial.user_friction_count < 2) return false;
    const trialDays = Math.max(1, (trialEnd - record.at) / 86400000);
    const baselineDays = 7;
    const trialPerDay = trial.user_friction_count / trialDays;
    const baselinePerDay = baseline.user_friction_count / baselineDays;
    const rateWorse =
      trial.friction_rate > Math.max(0.15, (baseline.turns >= 3 ? baseline.friction_rate : 0) * 1.15 + 0.02);
    return trialPerDay > baselinePerDay * 1.2 || rateWorse;
  }

  async checkTrials() {
    const results = [];
    for (const record of this.activeTrials()) {
      if (!record.trial_until || record.trial_until > this.now()) continue;
      if (this.frictionWorsened(record)) {
        const reverted = this.revertEvolution(record, '试用期摩擦升高');
        results.push({ ...record, status: reverted ? 'rolled_back' : 'trial', action: 'rollback' });
      } else {
        record.status = 'stable';
        record.stabilized_at = this.now();
        this.saveEvolution();
        results.push({ ...record, action: 'stabilize' });
      }
    }
    return results;
  }

  revertEvolution(record, reason = '') {
    let ok = false;
    if (record.tier === 1 && record.changes?.config) {
      for (const [field, change] of Object.entries(record.changes.config)) {
        this.setConfigValue(field, change.from);
      }
      this.writeConfigFile();
      try {
        this.dryRunConfig();
        ok = true;
      } catch (error) {
        this.noteNightmare(`参数回滚失败：${error?.message || error}`);
        return false;
      }
    } else if (record.tier === 2) {
      const before = record.changes?.prompt?.from;
      const beforeGuidance = record.changes?.guidanceBefore;
      const beforeVersion = record.changes?.versionBefore;
      if (before) {
        this.restorePrompt(before, beforeGuidance, beforeVersion);
        ok = true;
      }
    } else if (record.tier === 3 && record.source_backup) {
      if (this.restoreSourceBackup(record.source_backup) && this.reload) {
        Promise.resolve()
          .then(() => this.reload())
          .catch((error) => this.log('warn', `reload after rollback failed: ${error?.message || error}`));
        ok = true;
      }
    }
    if (ok) {
      record.status = 'rolled_back';
      record.rolled_back_at = this.now();
      record.rollback_reason = String(reason || '').slice(0, 300);
      this.noteNightmare(`这次进化没有通过试用期，已撤销：${record.summary}`);
      this.saveEvolution();
    }
    return ok;
  }

  // ------------------------------------------------------------------- tier 1

  async tuneHomeostasis({ force = false } = {}) {
    const now = this.now();
    if (!force) {
      const last = this.evolution.last_tier1_at || 0;
      if (last && isoDate(last) === isoDate(now)) return { changed: false, skipped: 'already-tuned-today' };
    }
    const today = this.metricsForDay(now);
    const baseline = this.metricsRange(now - 8 * 86400000, now - 86400000);
    const before = this.currentTunedValues();
    const changes = {};

    const frictionElevated =
      today.user_friction_count > 0
      && (today.friction_rate > baseline.friction_rate + 0.04 || today.user_friction_count >= 2);
    if (frictionElevated) {
      const nextScale = clamp(
        before.s0Multiplier * 1.12,
        before.s0Multiplier * 0.85,
        before.s0Multiplier * 1.15,
      );
      if (nextScale > before.s0Multiplier + 0.001) {
        changes.s0Multiplier = { from: before.s0Multiplier, to: round4(nextScale) };
        const min = clamp(before.fallibilityChanceMin * 0.85, 0.02, before.fallibilityChanceMin);
        const max = clamp(before.fallibilityChanceMax * 0.85, min, before.fallibilityChanceMax);
        changes.fallibilityChanceMin = { from: before.fallibilityChanceMin, to: round4(min) };
        changes.fallibilityChanceMax = { from: before.fallibilityChanceMax, to: round4(max) };
      }
    }

    const utilityLow = today.injected >= 3 && today.memory_utility_rate < 0.3;
    if (utilityLow) {
      const nextThreshold = clamp(
        before.similarityThreshold > 0 ? before.similarityThreshold * 1.1 : 0.01,
        0.01,
        0.4,
      );
      if (nextThreshold > before.similarityThreshold) {
        changes.similarityThreshold = { from: before.similarityThreshold, to: round4(nextThreshold) };
      }
    }

    const overheadHigh = today.token_overhead > 0.5;
    if (overheadHigh) {
      const nextBudget = clamp(
        before.contextCharBudget * 0.9,
        before.contextCharBudget * 0.85,
        before.contextCharBudget * 1.15,
      );
      if (nextBudget < before.contextCharBudget) {
        changes.contextCharBudget = { from: before.contextCharBudget, to: Math.round(nextBudget) };
      }
    }

    if (today.resonance_score >= 0.6 && today.turns >= 3) {
      this.evolution.resonance_rewards = (this.evolution.resonance_rewards || 0) + 1;
      // Reward: keep dream divergence and affect weight exactly where they are.
      changes.resonance_reward = { from: 0, to: 1, note: 'keep dream temperature / affect weight' };
    }

    if (!Object.keys(changes).filter((key) => key !== 'resonance_reward').length) {
      this.evolution.last_tier1_at = now;
      this.saveEvolution();
      return { changed: false, metrics: today, baseline, changes, skipped: 'no-tuning-needed' };
    }

    const snapshot = this.snapshot('tier1-config-before');
    for (const [field, change] of Object.entries(changes)) {
      if (field === 'resonance_reward') continue;
      this.setConfigValue(field, change.to);
    }
    this.writeConfigFile();
    try {
      this.dryRunConfig();
    } catch (error) {
      for (const [field, change] of Object.entries(changes)) {
        if (field === 'resonance_reward') continue;
        this.setConfigValue(field, change.from);
      }
      this.writeConfigFile();
      this.noteNightmare(`参数自调未通过干跑测试，已回滚：${error?.message || error}`);
      return { changed: false, error: String(error?.message || error), snapshot };
    }
    this.evolution.last_tier1_at = now;
    const realChanges = Object.fromEntries(Object.entries(changes).filter(([key]) => key !== 'resonance_reward'));
    const trial = this.recordEvolution({
      tier: 1,
      status: 'trial',
      summary: `夜间自稳态：${Object.entries(realChanges).map(([key, change]) => `${key} ${change.from}→${change.to}`).join('；')}`,
      changes: { config: realChanges },
      baseline,
      snapshot,
      trialUntil: now + this.config.metaEvolutionTrialDays * 86400000,
    });
    this.saveEvolution();
    return {
      changed: true,
      tier: 1,
      trial,
      snapshot,
      changes: realChanges,
      metrics: today,
      baseline,
      summary: `夜间自稳态完成：${Object.keys(realChanges).join('、')}`,
    };
  }

  // ------------------------------------------------------------------- tier 2

  // ------------------------------------------------------------------- tier 3

  readSkillGuide() {
    const candidates = [
      process.env.DSH_CORDIS_SKILL_PATH,
      process.resourcesPath
        ? path.join(
            process.resourcesPath,
            'app.asar',
            'dsh',
            'node_modules',
            '@deepseek-ai',
            'dsh-agent-preset',
            'skills',
            'cordis-plugin-development',
            'SKILL.md',
          )
        : '',
    ].filter(Boolean);
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          const text = fs.readFileSync(candidate, 'utf8');
          if (text.length > 100) return text.slice(0, 12000);
        }
      } catch {
        /* asar may not be readable here; use the embedded guide */
      }
    }
    return SKILL_GUIDE_FALLBACK;
  }

  readSourceDigest() {
    const files = [
      'package.json',
      'cordis.patch.yml',
      'prompt-template.md',
      'lib/config.js',
      'lib/meta-evolver.js',
    ];
    const keyFiles = ['index.js', 'lib/engine.js'];
    const parts = [];
    for (const relative of files) {
      const file = path.join(this.packageDir, relative);
      try {
        if (fs.existsSync(file)) {
          parts.push(`### ${relative}\n${fs.readFileSync(file, 'utf8').slice(0, 14000)}`);
        }
      } catch {
        /* ignore */
      }
    }
    for (const relative of keyFiles) {
      const file = path.join(this.packageDir, relative);
      try {
        if (fs.existsSync(file)) {
          const text = fs.readFileSync(file, 'utf8');
          const signatures = text
            .split('\n')
            .filter((line) => /^(export |  [a-zA-Z_$][\w$]*\(|  async [a-zA-Z_$][\w$]*\()/.test(line))
            .slice(0, 220)
            .join('\n');
          parts.push(`### ${relative}（结构摘要）\n${signatures}\n\n${text.slice(0, 5000)}`);
        }
      } catch {
        /* ignore */
      }
    }
    return parts.join('\n\n').slice(0, 42000);
  }

  async proposeArchitecture({ force = false, reason = '' } = {}) {
    const now = this.now();
    const metrics = this.metricsRange(now - 3 * 86400000, now);
    const bottleneck =
      (metrics.turns >= 8 && metrics.memory_utility_rate < 0.35 && metrics.token_overhead > 0.4)
      || (metrics.friction_rate >= 0.25 && metrics.user_friction_count >= 2)
      || (force && metrics.turns >= 2)
      || (now - (this.evolution.last_code_proposal_at || 0) >= this.config.metaEvolutionCodeDays * 86400000);
    if (!bottleneck) return { changed: false, skipped: 'no-bottleneck', metrics };
    if (!this.llm?.generate || !this.config.llmEnabled) {
      return { changed: false, skipped: 'no-model', metrics };
    }
    const skill = this.readSkillGuide();
    const digest = this.readSourceDigest();
    const system =
      '你是 dsh-bionic-memory 的元进化架构师。你在使用 cordis-plugin-development 技能。只提出可审阅的代码提案，绝不声称已经合入或已运行。只输出严格 JSON。';
    const prompt = [
      '## cordis-plugin-development 技能',
      skill,
      '',
      '## 最近的遥测',
      JSON.stringify(metrics),
      `主诉：${reason || '自动睡眠反思'}`,
      '',
      '## 插件源码摘要',
      digest,
      '',
      '## 任务',
      '找出一个真实的检索/聚类/数据结构/记忆维度瓶颈，提出一个小而完整的扩展。',
      '输出严格 JSON：{"summary":"...","bottleneck":"...","risk":"low|medium|high","files":[{"path":"lib/xxx.js","language":"ts|js","content":"..."}],"tests":["test/xxx.mjs"],"rationale":"..."}',
      '约束：最多 3 个文件；路径只能在 lib/、meta-evolver/、test/、index.js；每个文件 <= 30000 字符；必须是可审阅的补丁/扩展，不要执行安装或改 profile；TypeScript 提案要同时给出可运行的 .js 版本或明确标注需要构建。',
    ].join('\n');
    let parsed = null;
    try {
      const text = await this.llm.generate({
        system,
        prompt,
        maxTokens: 2400,
        temperature: 0.8,
        reasoningEffort: 'off',
      });
      parsed = parseJsonLoose(text);
    } catch (error) {
      this.log('warn', `code proposal generation failed: ${error?.message || error}`);
      return { changed: false, error: String(error?.message || error), metrics };
    }
    const proposal = this.normalizeProposal(parsed, metrics, reason);
    if (!proposal) return { changed: false, skipped: 'invalid-proposal', metrics };
    const dir = this.writeProposal(proposal);
    this.evolution.last_code_proposal_at = now;
    this.evolution.pending_proposals = [
      {
        id: proposal.id,
        at: now,
        summary: proposal.summary,
        bottleneck: proposal.bottleneck,
        risk: proposal.risk,
        dir,
        files: proposal.files.map((file) => file.path),
      },
      ...(this.evolution.pending_proposals || []),
    ].slice(0, 10);
    this.saveEvolution();
    this.engine?.addCuriosity?.(
      `有一个代码进化提案在等用户审阅（${proposal.summary}），只可以用 /evolve approve 合入，不能自动执行。`,
      `meta:proposal:${proposal.id}`,
    );
    this.journal('proposal', `生成代码进化提案：${proposal.summary}`, proposal.bottleneck);
    return { changed: true, proposal, dir, metrics, summary: `已生成提案：${proposal.summary}` };
  }

  normalizeProposal(parsed, metrics, reason) {
    if (!parsed || typeof parsed !== 'object') return null;
    const summary = shortRule(parsed.summary || '', 220);
    const bottleneck = shortRule(parsed.bottleneck || reason || '', 400);
    if (!summary || !bottleneck) return null;
    const files = [];
    for (const item of Array.isArray(parsed.files) ? parsed.files.slice(0, 3) : []) {
      const relative = String(item?.path || '').replace(/\\/g, '/');
      const content = String(item?.content || '');
      if (!allowedProposalPath(relative)) continue;
      if (content.length < 20 || content.length > 30000) continue;
      files.push({ path: relative, language: String(item?.language || 'js'), content });
    }
    if (!files.length) return null;
    const id = `proposal-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    return {
      id,
      at: this.now(),
      summary,
      bottleneck,
      risk: ['low', 'medium', 'high'].includes(parsed.risk) ? parsed.risk : 'medium',
      files,
      tests: (Array.isArray(parsed.tests) ? parsed.tests : []).map(String).slice(0, 3),
      rationale: shortRule(parsed.rationale || '', 1000),
      metrics,
    };
  }

  writeProposal(proposal) {
    const dir = path.join(this.proposalsDir, proposal.id);
    fs.mkdirSync(dir, { recursive: true });
    const manifest = {
      id: proposal.id,
      at: proposal.at,
      summary: proposal.summary,
      bottleneck: proposal.bottleneck,
      risk: proposal.risk,
      rationale: proposal.rationale,
      files: [],
      tests: proposal.tests,
    };
    for (const file of proposal.files) {
      const target = path.join(dir, 'files', file.path);
      writeText(target, file.content);
      manifest.files.push({ path: file.path, language: file.language, bytes: Buffer.byteLength(file.content) });
    }
    writeJson(path.join(dir, 'manifest.json'), manifest);
    return dir;
  }

  loadProposal(id = '') {
    const pending = this.evolution.pending_proposals || [];
    const entry = id ? pending.find((item) => item.id === id) : pending[0];
    if (!entry) return null;
    const manifest = readJson(path.join(entry.dir, 'manifest.json'), null);
    if (!manifest) return null;
    const files = [];
    for (const file of manifest.files || []) {
      const source = path.join(entry.dir, 'files', file.path);
      try {
        if (fs.existsSync(source)) files.push({ ...file, content: fs.readFileSync(source, 'utf8') });
      } catch {
        /* skip unreadable */
      }
    }
    return { entry, manifest, files };
  }

  sourceBackup(files) {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const dir = path.join(this.snapshotsDir, `source-${stamp}`);
    fs.mkdirSync(dir, { recursive: true });
    const record = { id: `src-${stamp}`, at: this.now(), dir, files: [] };
    for (const file of files) {
      const target = safeRelative(this.packageDir, file.path);
      if (!target) continue;
      const relative = path.relative(this.packageDir, target);
      const backupFile = path.join(dir, relative);
      const existed = fs.existsSync(target);
      if (existed) copyFileIfExists(target, backupFile);
      record.files.push({ path: relative, existed });
    }
    writeJson(path.join(dir, 'manifest.json'), record);
    return record;
  }

  restoreSourceBackup(backup) {
    if (!backup || !backup.dir) return false;
    try {
      for (const file of backup.files || []) {
        const target = safeRelative(this.packageDir, file.path);
        if (!target) continue;
        if (file.existed) {
          const source = path.join(backup.dir, file.path);
          if (fs.existsSync(source)) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(source, target);
          }
        } else {
          try {
            fs.rmSync(target, { force: true });
          } catch {
            /* ignore */
          }
        }
      }
      return true;
    } catch (error) {
      this.log('warn', `source restore failed: ${error?.message || error}`);
      return false;
    }
  }

  bumpPackageVersion() {
    const file = path.join(this.packageDir, 'package.json');
    const pkg = readJson(file, null);
    if (!pkg) throw new Error('package.json is not readable');
    const before = String(pkg.version || '0.0.0');
    const parts = before.split('.').map((part) => Number(part) || 0);
    while (parts.length < 3) parts.push(0);
    parts[2] += 1;
    pkg.version = parts.join('.');
    writeJson(file, pkg);
    return { before, after: pkg.version };
  }

  restorePackageVersion(version) {
    const file = path.join(this.packageDir, 'package.json');
    const pkg = readJson(file, null);
    if (!pkg || !version) return;
    pkg.version = version;
    writeJson(file, pkg);
  }

  runCommand(command, args, timeout = 60000) {
    return execFileSync(command, args, {
      cwd: this.packageDir,
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  dryRunProposal(proposal, extraTests = []) {
    for (const file of proposal.files) {
      const target = safeRelative(this.packageDir, file.path);
      if (!target) throw new Error(`unsafe proposal path: ${file.path}`);
      if (['.js', '.mjs', '.cjs'].includes(fileExtension(file.path))) {
        this.runCommand(process.execPath, ['--check', target], 30000);
      }
      if (fileExtension(file.path) === '.json') {
        JSON.parse(fs.readFileSync(target, 'utf8'));
      }
    }
    const defaults = [
      'test/smoke.mjs',
      'test/fallibility-smoke.mjs',
      'test/mechanisms-smoke.mjs',
      'test/batch-smoke.mjs',
      'test/meta-evolver-smoke.mjs',
      'test/context-metabolism-smoke.mjs',
      'test/cache-prefix-smoke.mjs',
      'test/voice-engine-smoke.mjs',
    ];
    const tests = [...new Set([...defaults, ...extraTests.filter((test) => test.startsWith('test/'))])];
    for (const test of tests) {
      const target = path.join(this.packageDir, test);
      if (!fs.existsSync(target)) continue;
      this.runCommand(process.execPath, [target], 90000);
    }
    return true;
  }

  async approveProposal(id = '') {
    const loaded = this.loadProposal(id);
    if (!loaded) return { ok: false, error: '没有待审批的代码提案' };
    const { entry, manifest, files } = loaded;
    if (!files.length) return { ok: false, error: '提案没有可应用的文件' };
    const sourceBackup = this.sourceBackup(files);
    const snapshot = this.snapshot('tier3-code-before');
    let versionBefore = '';
    try {
      const version = this.bumpPackageVersion();
      versionBefore = version.before;
      for (const file of files) {
        const target = safeRelative(this.packageDir, file.path);
        if (!target) throw new Error(`unsafe path: ${file.path}`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.content, 'utf8');
      }
      this.dryRunProposal({ files }, manifest.tests || []);
    } catch (error) {
      this.restoreSourceBackup(sourceBackup);
      if (versionBefore) this.restorePackageVersion(versionBefore);
      this.noteNightmare(`代码提案未通过干跑测试，已回滚：${error?.message || error}`);
      entry.status = 'failed';
      this.saveEvolution();
      return { ok: false, error: String(error?.message || error), sourceBackup, snapshot };
    }

    const record = this.recordEvolution({
      tier: 3,
      status: 'applied',
      summary: `代码进化：${manifest.summary}`,
      changes: { code: { files: manifest.files, versionBefore } },
      baseline: this.metricsRange(this.now() - 7 * 86400000, this.now()),
      snapshot,
      sourceBackup,
      proposalId: entry.id,
      trialUntil: this.now() + this.config.metaEvolutionTrialDays * 86400000,
      meta: { package_version_before: versionBefore, risk: manifest.risk },
    });
    entry.status = 'applied';
    this.saveEvolution();
    const pendingApply = {
      at: this.now(),
      proposal_id: entry.id,
      record_id: record.id,
      source_backup: sourceBackup,
      version_before: versionBefore,
      files: manifest.files,
    };
    writeJson(this.pendingApplyFile, pendingApply);
    let reloadResult = null;
    if (this.reload) {
      try {
        reloadResult = await this.reload();
      } catch (error) {
        reloadResult = { ok: false, error: String(error?.message || error) };
      }
    }
    if (!this.reload || reloadResult?.ok === false) {
      this.restoreSourceBackup(sourceBackup);
      this.restorePackageVersion(versionBefore);
      try {
        fs.rmSync(this.pendingApplyFile, { force: true });
      } catch {
        /* ignore */
      }
      record.status = 'rolled_back';
      record.rolled_back_at = this.now();
      record.rollback_reason = 'reload unavailable';
      this.saveEvolution();
      this.noteNightmare(`代码进化未能热重载，已回滚：${reloadResult?.error || 'reload callback unavailable'}`);
      return {
        ok: false,
        error: reloadResult?.error || 'Host reload service is unavailable; files were rolled back',
        sourceBackup,
        snapshot,
      };
    }
    return {
      ok: true,
      proposal: entry,
      record,
      sourceBackup,
      snapshot,
      reload: reloadResult,
      summary: `已合入 ${manifest.summary}；正在热重载，随后进入 ${this.config.metaEvolutionTrialDays} 天试用期`,
    };
  }

  async finishPendingApply() {
    const pending = readJson(this.pendingApplyFile, null);
    if (!pending) return null;
    const record = (this.evolution.history || []).find((item) => item.id === pending.record_id);
    try {
      const manifest = readJson(path.join(this.proposalsDir, pending.proposal_id, 'manifest.json'), null);
      const files = (manifest?.files || []).map((file) => ({ ...file, content: '' }));
      // The code is already on disk and the plugin booted. Run the same
      // dry-run suite against the booted source before accepting it.
      const proposal = { files: files.map((file) => ({ path: file.path, language: file.language })) };
      this.dryRunProposal(proposal, manifest?.tests || []);
      if (record) {
        record.status = 'trial';
        record.trial_until = this.now() + this.config.metaEvolutionTrialDays * 86400000;
        this.saveEvolution();
      }
      const proposalEntry = (this.evolution.pending_proposals || []).find((item) => item.id === pending.proposal_id);
      if (proposalEntry) proposalEntry.status = 'applied';
      this.saveEvolution();
      try {
        fs.rmSync(this.pendingApplyFile, { force: true });
      } catch {
        /* ignore */
      }
      this.log('info', `pending code proposal ${pending.proposal_id} passed boot dry-run`);
      return { ok: true };
    } catch (error) {
      this.restoreSourceBackup(pending.source_backup);
      if (pending.version_before) this.restorePackageVersion(pending.version_before);
      try {
        fs.rmSync(this.pendingApplyFile, { force: true });
      } catch {
        /* ignore */
      }
      if (record) {
        record.status = 'rolled_back';
        record.rolled_back_at = this.now();
        record.rollback_reason = 'boot dry-run failed';
        this.saveEvolution();
      }
      this.noteNightmare(`代码提案在新进程启动后自检失败，已回滚：${error?.message || error}`);
      if (this.reload) {
        try {
          await this.reload();
        } catch (reloadError) {
          this.log('warn', `reload after boot rollback failed: ${reloadError?.message || reloadError}`);
        }
      }
      return { ok: false, error: String(error?.message || error) };
    }
  }

  // ------------------------------------------------------------------ rollback

  async rollbackLast() {
    const history = this.evolution.history || [];
    const record = history.find((item) => item.snapshot || item.source_backup);
    if (!record) return { ok: false, error: '还没有可回退的进化快照' };
    let codeReverted = false;
    if (record.tier === 3 && record.source_backup) {
      codeReverted = this.restoreSourceBackup(record.source_backup);
      if (record.package_version_before) this.restorePackageVersion(record.package_version_before);
    }
    const restored = this.restoreSnapshot(record.snapshot);
    record.status = 'rolled_back';
    record.rolled_back_at = this.now();
    record.rollback_reason = 'manual rollback';
    this.saveEvolution();
    this.noteNightmare(`用户手动回退了进化：${record.summary}`);
    if (codeReverted && this.reload) {
      try {
        await this.reload();
      } catch (error) {
        this.log('warn', `manual rollback reload failed: ${error?.message || error}`);
      }
    }
    return {
      ok: restored || codeReverted,
      record,
      restored,
      codeReverted,
      summary: `已回退：${record.summary}`,
    };
  }

  // -------------------------------------------------------------------- cycle

  async afterDream({ dream, trigger } = {}) {
    if (!this.loaded) return null;
    const trials = await this.checkTrials();
    const tier1 = await this.tuneHomeostasis({ force: false });
    const tier2 = await this.mutatePrompt({ force: false });
    const tier3 = await this.proposeArchitecture({ force: false, reason: '睡眠反思' });
    const summary = [
      trials.length ? `试用期结算 ${trials.length}` : '',
      tier1.changed ? tier1.summary : '',
      tier2.changed ? tier2.summary : '',
      tier3.changed ? tier3.summary : '',
    ].filter(Boolean).join('；');
    if (summary) this.journal('meta_evolution', summary);
    return { trials, tier1, tier2, tier3, summary, dream: dream?.id || '' };
  }

  async runCycle({ force = true, trigger = 'manual', reason = '手动进化' } = {}) {
    if (!this.loaded) return { ok: false, error: 'meta-evolver is not initialized' };
    const trials = await this.checkTrials();
    const tier1 = await this.tuneHomeostasis({ force });
    const tier2 = await this.mutatePrompt({ force });
    const tier3 = await this.proposeArchitecture({ force, reason });
    const pieces = [
      tier1.changed ? tier1.summary : tier1.skipped || '参数无需调整',
      tier2.changed ? tier2.summary : tier2.skipped || '提示词未到进化窗口',
      tier3.changed ? tier3.summary : tier3.skipped || '未发现代码瓶颈',
    ];
    return {
      ok: true,
      trigger,
      trials,
      tier1,
      tier2,
      tier3,
      summary: pieces.join('；'),
    };
  }

  // ------------------------------------------------------------------ context

  contextLines() {
    const lines = [];
    const pending = (this.evolution.pending_proposals || []).filter((item) => item.status !== 'applied' && item.status !== 'failed');
    const trials = this.activeTrials();
    const history = (this.evolution.history || []).slice(0, 3);
    const nightmare = this.evolution.last_nightmare;
    const alert = this.evolution.cache_alert?.active ? this.evolution.cache_alert : null;
    if (!pending.length && !trials.length && !nightmare && !history.length && !alert) return lines;
    lines.push('  <meta_evolution>');
    if (alert) {
      lines.push(
        `    <cache_alert ratio="${Math.round((alert.ratio || 0) * 100)}%" low_streak="${alert.low_streak || 0}">${xmlEscape(alert.hint || '')}</cache_alert>`,
      );
    }
    if (pending.length) {
      lines.push(`    <pending_proposals count="${pending.length}">有代码进化提案待审阅；只用 /evolve approve 合入，不要自动执行。</pending_proposals>`);
      for (const proposal of pending.slice(0, 2)) {
        lines.push(`    <proposal id="${proposal.id}" risk="${proposal.risk}">${xmlEscape(proposal.summary)}</proposal>`);
      }
    }
    if (trials.length) {
      for (const trial of trials.slice(0, 3)) {
        lines.push(
          `    <trial tier="${trial.tier}" until="${formatDateTime(trial.trial_until || 0)}">${xmlEscape(trial.summary)}</trial>`,
        );
      }
    }
    if (nightmare) {
      lines.push(`    <last_nightmare>${xmlEscape(nightmare.text || '')}</last_nightmare>`);
    }
    if (history.length) {
      for (const record of history.slice(0, 2)) {
        lines.push(
          `    <evolution tier="${record.tier}" status="${record.status}">${xmlEscape(record.summary)}</evolution>`,
        );
      }
    }
    lines.push('  </meta_evolution>');
    return lines;
  }

  state() {
    return {
      enabled: Boolean(this.loaded),
      metrics: this.metricsForDay(),
      metrics_7d: this.metricsRange(this.now() - 7 * 86400000, this.now()),
      params: this.currentTunedValues(),
      trials: this.activeTrials().map((record) => ({
        id: record.id,
        tier: record.tier,
        summary: record.summary,
        trial_until: record.trial_until,
      })),
      pending_proposals: (this.evolution.pending_proposals || []).filter(
        (item) => item.status !== 'applied' && item.status !== 'failed',
      ),
      history: (this.evolution.history || []).slice(0, 8).map((record) => ({
        id: record.id,
        at: record.at,
        tier: record.tier,
        status: record.status,
        summary: record.summary,
      })),
      prompt_version: this.evolution.prompt_version,
      nightmare: this.evolution.last_nightmare,
      cache: this.cacheState(),
      config_path: this.configFile,
      prompt_path: this.promptFile,
      last_snapshot: this.evolution.last_snapshot,
    };
  }

  statusText() {
    const flags = this.metricsForDay();
    const week = this.metricsRange(this.now() - 7 * 86400000, this.now());
    const lines = [
      '【元认知进化引擎】',
      `今日遥测：${flags.turns} 轮 · 记忆效用 ${(flags.memory_utility_rate * 100).toFixed(0)}% · 摩擦 ${flags.user_friction_count} · 共鸣 ${(flags.resonance_score * 100).toFixed(0)}% · Token/上下文占比 ${(flags.token_overhead * 100).toFixed(0)}%`,
      `近 7 天：${week.turns} 轮 · 记忆效用 ${(week.memory_utility_rate * 100).toFixed(0)}% · 摩擦 ${week.user_friction_count} · 共鸣 ${(week.resonance_score * 100).toFixed(0)}%`,
      `当前参数：S0 ${round2(this.currentTunedValues().defaultS0 * this.currentTunedValues().s0Multiplier)}（${this.currentTunedValues().defaultS0}×${this.currentTunedValues().s0Multiplier}）· similarity_threshold ${this.currentTunedValues().similarityThreshold} · confusion_rate ${this.currentTunedValues().fallibilityChanceMin}~${this.currentTunedValues().fallibilityChanceMax} · contextBudget ${this.currentTunedValues().contextCharBudget} · dreamTemp ${this.currentTunedValues().dreamTemperature}`,
      `提示词：v${this.evolution.prompt_version}${this.activeGuidance.length ? `（${this.activeGuidance.length} 条进化表达指导）` : ''}`,
      `KV 缓存：今日命中 ${(flags.cache_hit_ratio * 100).toFixed(0)}% · 省下 ${flags.cache_saved_tokens} tokens · ${flags.cache_rounds} 轮${flags.cache_batch_rounds ? `（其中阶梯折叠 ${flags.cache_batch_rounds} 轮已排除低命中告警）` : ''} · 连续低命中 ${this.telemetry.cache?.low_streak || 0}`,
    ];
    const trials = this.activeTrials();
    lines.push(
      trials.length
        ? `试用中：${trials.map((trial) => `T${trial.tier} ${trial.summary}`).join('；')}`
        : '试用中：无',
    );
    const pending = (this.evolution.pending_proposals || []).filter(
      (item) => item.status !== 'applied' && item.status !== 'failed',
    );
    lines.push(
      pending.length
        ? `待审批代码提案：${pending.map((item) => `${item.id}（${item.summary}）`).join('；')} → /evolve approve`
        : '待审批代码提案：无',
    );
    if (this.evolution.last_nightmare) {
      lines.push(`最近一次走火入魔未遂：${this.evolution.last_nightmare.text}`);
    }
    if (this.evolution.cache_alert?.active) {
      lines.push(
        `缓存告警：连续 ${this.evolution.cache_alert.low_streak} 轮低于 70%（最近 ${Math.round((this.evolution.cache_alert.ratio || 0) * 100)}%）→ ${this.evolution.cache_alert.hint}`,
      );
    }
    const history = (this.evolution.history || []).slice(0, 5);
    if (history.length) {
      lines.push('最近进化：');
      for (const record of history) {
        lines.push(`  · T${record.tier} [${record.status}] ${record.summary}`);
      }
    }
    lines.push(`文件：${this.configFile} · ${this.promptFile} · ${this.proposalsDir}`);
    return lines.join('\n');
  }

  journal(kind, summary, detail = '') {
    try {
      this.engine?.journal?.(kind, summary, detail);
    } catch {
      /* ignore */
    }
  }

  noteNightmare(text, detail = '') {
    const nightmare = {
      at: this.now(),
      text: shortRule(text, 500),
      detail: shortRule(detail, 1200),
    };
    this.evolution.last_nightmare = nightmare;
    this.lastNightmare = nightmare;
    try {
      this.engine?.saveScratchpad?.({ nightmare });
    } catch {
      /* ignore */
    }
    this.saveEvolution();
    this.journal('nightmare', `做噩梦/走火入魔未遂：${nightmare.text}`, nightmare.detail);
  }
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function xmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
