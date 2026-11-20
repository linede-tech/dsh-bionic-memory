/**
 * @local/dsh-bionic-memory — Host half.
 *
 * Swap points implemented here:
 *   • system prompt pre-processor: `agent/created` installs a scoped section that
 *     re-renders `<bionic_memory_context>` before every model step
 *   • session trajectory observer: `session/event` folds turns into memory on
 *     `turn/end` (debounced) and on session disposal
 *   • dream scheduler: interval + boot check + `/dream`
 *   • commands and agent tool: `/memory`, `/dream`, `/forget`, `bionic_memory`
 *   • monitor data plane: same-origin routes under /dsh-bionic-memory
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { normalizeConfig } from './lib/config.js';
import { recordAssistantMessage, recordToolExchange, visibleAssistantText } from './lib/dialogue.js';
import { BionicMemoryEngine } from './lib/engine.js';
import { createLlmHost } from './lib/llm.js';
import { MySchedule } from './lib/schedule.js';
import { openStore } from './lib/store.js';
import {
  SOUL_ROOT,
  ensureSoul,
  readTier0,
  soulPaths,
} from './lib/soul-storage.js';
import { isoDate, textOfContent } from './lib/text.js';
import { ensureVisualAssets, readVisualConfig, setVisualAvatar, companionPrompt, initializeCompanion } from './lib/visual.js';
import { registerWebRoutes } from './lib/web.js';

export const name = '@local/dsh-bionic-memory';

export const inject = ['agents', 'agentPresets', 'commands', 'sessions', 'systemPrompt', 'timer', 'tools', 'webServer'];

const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const RULES_SOURCE = fs.readFileSync(path.join(PACKAGE_DIR, 'prompt-template.md'), 'utf8').trim();
let RULES = RULES_SOURCE;

const RULES_SECTION = 'bionic-memory:cognitive-rules';
const CONTEXT_SECTION = 'bionic-memory:memory-context';
const AUTONOMOUS_SECTION = 'bionic-memory:autonomous-tick';
const IDENTITY_SECTION = 'bionic-memory:companion-identity';
const METABOLISM_CONTEXT = 'bionic-memory:context-metabolism';
const BUILD = 'bionic-1.3.4';

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const logger = ctx.logger;
  const sessions = ctx.get('sessions');
  const agentPresets = ctx.get('agentPresets');
  const pluginManager = ctx.get('pluginManager');

  // The global soul is the single source of truth for every workspace. The
  // physical Tier 0 file is the byte source for the system prompt.
  try {
    const soulRoot = resolveDataDir();
    ensureSoul({ root: soulRoot, tier0Source: RULES_SOURCE, logger });
    ensureVisualAssets(soulRoot);
    RULES = readTier0(soulRoot) || RULES_SOURCE;
    logger?.info?.(`[bionic-memory] global soul at ${soulRoot}`);
  } catch (error) {
    logger?.warn?.(`[bionic-memory] global soul init failed: ${error?.message || error}`);
  }
  const tokenMeter = ctx.get('tokenMeter');
  const llmRuntime = ctx.get('llm');

  const agentDisposers = new Map();
  const buffers = new Map();

  let engine = null;
  let disposed = false;
  let bootPromise = null;
  let stopScheduler = null;
  let stopHeartbeat = null;
  let lastUserActivityAt = 0;
  let lastSleepKey = '';
  const proactiveTicks = new Map();
  const proactiveRuns = new Map();
  const AUTONOMOUS_MARKER = '[bionic-autonomous-tick:';
  let modeEngaged = false;
  const presetSuspended = new Set();

  // ------------------------------------------------------------ data directory

  function baseDirectory() {
    // The engine is global, but it belongs to the workspace of the session
    // that woke it. Prefer a live session's effective directory so a restart
    // does not silently relocate memory into the profile directory.
    try {
      const workingDirectory = ctx.get('workingDirectory');
      const live = ctx.get('agents')?.list?.() || [];
      for (const agent of live.slice().reverse()) {
        try {
          const session = sessions?.get?.(agent.id);
          if (!session) continue;
          const dir = workingDirectory?.get?.(session);
          if (dir) return dir;
        } catch {
          /* a stale agent contributes nothing */
        }
      }
    } catch {
      /* fall through */
    }
    try {
      const workingDirectory = ctx.get('workingDirectory');
      if (workingDirectory?.defaultDirectory) return workingDirectory.defaultDirectory;
    } catch {
      /* fall through */
    }
    return process.cwd();
  }

  function profileDirectory() {
    try {
      const profileContext = ctx.get?.('profileContext');
      return (
        String(process.env.DSH_PROFILE_DIR || '').trim()
        || profileContext?.profileDir
        || profileContext?.dir
        || profileContext?.directory
        || ''
      );
    } catch {
      return String(process.env.DSH_PROFILE_DIR || '').trim();
    }
  }

  function readDataDirPointer() {
    const candidates = [];
    const env = String(process.env.BIONIC_MEMORY_DATA_DIR || '').trim();
    if (env) candidates.push({ file: '', value: env });
    const profileDir = profileDirectory();
    if (profileDir) {
      candidates.push({ file: path.join(profileDir, '.dsh', 'bionic-memory-location.json') });
    }
    try {
      const base = baseDirectory();
      if (base) candidates.push({ file: path.join(base, '.dsh', 'bionic-memory-location.json') });
    } catch {
      /* base is only a hint */
    }
    for (const candidate of candidates) {
      try {
        let value = candidate.value;
        if (candidate.file) {
          if (!fs.existsSync(candidate.file)) continue;
          const raw = fs.readFileSync(candidate.file, 'utf8').trim();
          if (!raw) continue;
          try {
            const parsed = JSON.parse(raw);
            value = typeof parsed === 'string' ? parsed : parsed?.dataDir || parsed?.dir || '';
          } catch {
            value = raw;
          }
        }
        const configured = String(value || '').trim().replace(/^["']|["']$/g, '');
        if (!configured) continue;
        if (path.isAbsolute(configured)) return configured;
        if (candidate.file) return path.resolve(path.dirname(candidate.file), configured);
        return path.resolve(configured);
      } catch {
        /* try the next pointer */
      }
    }
    return '';
  }

  function resolveDataDir() {
    const explicit = String(config.dataDir || '').trim();
    if (explicit) {
      const base = baseDirectory();
      return path.isAbsolute(explicit) ? explicit : path.join(base, explicit);
    }
    return SOUL_ROOT;
  }

  // -------------------------------------------------------- preset diagnostics

  async function presetDiagnostics() {
    const service = agentPresets || ctx.get?.('agentPresets');
    if (!service?.list) {
      return { preset_id: config.presetId, error: 'agentPresets service unavailable' };
    }
    let presets;
    try {
      presets = await service.list();
    } catch (error) {
      return { preset_id: config.presetId, error: `preset list failed: ${error?.message || error}` };
    }
    let inspections = null;
    if (typeof service.inspectCompositions === 'function') {
      try {
        inspections = service.inspectCompositions();
      } catch (error) {
        inspections = { error: String(error?.message || error) };
      }
    }
    const target = Array.isArray(presets)
      ? presets.find((preset) => preset.id === config.presetId) || null
      : null;
    return { preset_id: config.presetId, target, presets, inspections };
  }

  void presetDiagnostics()
    .then((diagnostic) => {
      const target = diagnostic.target;
      if (!target) {
        logger?.warn?.(`[bionic-memory] preset '${config.presetId}' not found in the roster`);
        return;
      }
      const failure = target.error || target.loadError || target.diagnostic || target.message;
      if (failure) {
        logger?.warn?.(`[bionic-memory] preset '${config.presetId}' failure: ${JSON.stringify(failure)}`);
      } else {
        logger?.info?.(`[bionic-memory] preset '${config.presetId}' ready`);
      }
    })
    .catch((error) => logger?.warn?.(`[bionic-memory] preset diagnostic failed: ${error?.message || error}`));

  // --------------------------------------------------------------- engine boot

  const llm = createLlmHost({ ctx, logger, config });

  ctx.effect(() => {
    return async () => {
      disposed = true;
      try {
        stopScheduler?.();
      } catch {
        /* ignore */
      }
      try {
        stopHeartbeat?.();
      } catch {
        /* ignore */
      }
      for (const buffer of buffers.values()) {
        if (buffer.timer) clearTimeout(buffer.timer);
      }
      buffers.clear();
      try {
        await bootPromise;
      } catch {
        /* boot already failed */
      }
      engine?.close();
      engine = null;
    };
  }, 'bionic-memory: engine');

  if (config.heartbeatEnabled) {
    stopHeartbeat = startHeartbeat();
  }

  const getEngine = async () => {
    if (engine) return engine;
    if (bootPromise) return bootPromise;
    bootPromise = (async () => {
      const dataDir = resolveDataDir();
      const paths = ensureSoul({ root: dataDir, tier0Source: RULES_SOURCE, logger });
      ensureVisualAssets(dataDir);
      const store = await openStore({
        dir: paths.cortex,
        dbFile: 'memory_cortex.sqlite',
        jsonFile: 'memory_cortex.json',
        logger,
      });
      const created = new BionicMemoryEngine({
        store,
        config,
        logger,
        llm,
        sessions,
        dataDir,
        packageDir: PACKAGE_DIR,
        basePrompt: readTier0(dataDir) || RULES,
        pluginReload: reloadPlugin,
        tokenMeter,
        llmRuntime,
      });
      created.init();
      engine = created;
      logger?.info?.(
        `[bionic-memory] engine ready (${store.kind}) at ${dataDir} (cortex ${paths.dbFile}); activation=${config.activation}`,
      );
      if (!disposed && modeEngaged) stopScheduler = startScheduler(created);
      return created;
    })().catch((error) => {
      bootPromise = null;
      logger?.error?.(`[bionic-memory] engine boot failed: ${error?.stack || error}`);
      throw error;
    });
    return bootPromise;
  };

  async function reloadPlugin() {
    const service = pluginManager || ctx.get?.('pluginManager');
    if (!service?.installBundle) {
      return { ok: false, error: 'pluginManager service is unavailable' };
    }
    try {
      const result = await service.installBundle(PACKAGE_DIR);
      return {
        ok: result?.application === 'applied' || result?.changed !== false,
        result,
      };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }

  function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  }

  function toolSchemaHash() {
    try {
      const schemas = ctx.tools?.schemas?.() || [];
      return createHash('sha256').update(canonicalJson(schemas)).digest('hex');
    } catch {
      return '';
    }
  }

  function isActiveFor(agentOrSession) {
    const suspendedId = agentOrSession?.id;
    if (suspendedId !== undefined && presetSuspended.has(String(suspendedId))) return false;
    if (config.activation === 'all') return true;
    try {
      const session =
        agentOrSession && typeof agentOrSession.id === 'string' && !agentOrSession.header
          ? sessions?.get?.(agentOrSession.id)
          : agentOrSession;
      if (!session) return false;
      // A live Agent knows its actual composition. This is the strongest
      // signal: a session that selected bionic and then switched to Creator
      // before its first message is composed as Creator even if the session
      // header or the last committed selection still says bionic.
      const presets = agentPresets || ctx.get?.('agentPresets');
      try {
        const composed = agentOrSession?.ctx
          ? presets?.composedPreset?.(agentOrSession.ctx)
          : undefined;
        if (composed !== undefined && composed !== null) return composed === config.presetId;
      } catch {
        /* composition may be unavailable during teardown */
      }
      // The session header stores the preset used at creation. A later
      // `agent-preset/selected` event is the effective composition; it wins
      // even when the immutable header still says bionic-memory or standard.
      try {
        const current = presets?.presetForSession?.(session);
        if (current !== undefined && current !== null) return current === config.presetId;
      } catch {
        /* fall back to the header */
      }
      if (session.header?.agentPreset === config.presetId) return true;
      try {
        if (presets?.presetForSession?.(session) === config.presetId) return true;
      } catch {
        /* a session outside the registry contributes no preset */
      }
      try {
        if (
          agentOrSession?.ctx
          && presets?.composedPreset?.(agentOrSession.ctx) === config.presetId
        ) {
          return true;
        }
      } catch {
        /* composition may be unavailable during teardown */
      }
      return false;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------ system prompt pre-processor

  function registerAgentContext(agent) {
    // A live preset Agent is the reliable signal for both "the workspace is
    // known" and "it is safe to open the store"; boot lazily from here. Agents
    // in other modes must not wake or observe the memory system.
    if (isActiveFor(agent)) {
      modeEngaged = true;
      void getEngine()
        .then((current) => {
          if (!disposed && !stopScheduler) stopScheduler = startScheduler(current);
        })
        .catch((error) => {
          logger?.warn?.(`[bionic-memory] lazy boot from agent failed: ${error?.message || error}`);
        });
    }
    if (!agent?.ctx?.effect) return;
    const systemPrompt = agent.ctx.systemPrompt || agent.ctx.get?.('systemPrompt');
    if (!systemPrompt?.section) return;

    const previous = agentDisposers.get(agent.id);
    if (previous) {
      try {
        previous();
      } catch {
        /* agent already disposed */
      }
      agentDisposers.delete(agent.id);
    }

    const dispose = agent.ctx.effect(() => {
      const offRules = systemPrompt.section({
        name: RULES_SECTION,
        order: 100,
        text: () => {
          if (!isActiveFor(agent)) return '';
          return RULES;
        },
        interpolate: false,
      });
      const offContext = systemPrompt.section({
        name: CONTEXT_SECTION,
        order: 101,
        text: () => {
          if (!isActiveFor(agent)) return '';
          try {
            return engine?.dailyFrozenBlock?.() || '';
          } catch {
            return '';
          }
        },
        interpolate: false,
      });
      const offAutonomous = systemPrompt.section({
        name: AUTONOMOUS_SECTION,
        order: 102,
        text: () => {
          if (!isActiveFor(agent)) return '';
          const tick = proactiveTicks.get(String(agent.id));
          if (!tick) return '';
          proactiveTicks.delete(String(agent.id));
          const action =
            tick.action_type === 'proactive_message'
              ? '允许你主动开口；不要提系统、闹钟或后台，只像你自己忽然想起他一样自然。'
              : tick.action_type === 'silent_task'
                ? '先安静地做你想做的事；真有想说的再开口，不必汇报过程。'
                : '这是你自己的睡前/自我照料回合。';
          return [
            '<autonomous_tick>',
            '现在是你的内源性自主回合，不是用户在说话，也不是用户发的消息。',
            `你醒来时想做的是：${tick.my_intention || '自己待一会儿'}`,
            action,
            '不要编造用户没说过的原话；需要核对细节时调用 dig_up_exact_words。',
            '</autonomous_tick>',
          ].join('\n');
        },
        interpolate: false,
      });
      const offIdentity = systemPrompt.section({
        name: IDENTITY_SECTION,
        order: 103,
        text: () => {
          if (!isActiveFor(agent)) return '';
          try {
            return companionPrompt(readVisualConfig(soulRoot));
          } catch {
            return '';
          }
        },
        interpolate: false,
      });
      // Keep optional host runtime contexts (clock, cwd snapshots, transient
      // route hints) out of the static prefix only in the Bionic Memory Mode;
      // standard sessions keep their normal runtime context.
      const offRuntimeContext =
        isActiveFor(agent) && systemPrompt.suppressRuntimeContext
          ? systemPrompt.suppressRuntimeContext()
          : () => {};
      return () => {
        try {
          offRules();
        } catch {
          /* scope already gone */
        }
        try {
          offContext();
        } catch {
          /* scope already gone */
        }
        try {
          offAutonomous();
        } catch {
          /* scope already gone */
        }
        try {
          offIdentity();
        } catch {
          /* scope already gone */
        }
        try {
          offRuntimeContext();
        } catch {
          /* scope already gone */
        }
      };
    }, 'bionic-memory: agent prompt');

    agentDisposers.set(agent.id, dispose);
  }

  ctx.effect(() => {
    const off = ctx.on('agent/created', (payload) => {
      try {
        registerAgentContext(payload?.agent);
      } catch (error) {
        logger?.warn?.(`[bionic-memory] agent prompt registration failed: ${error?.message || error}`);
      }
    });
    return () => {
      off();
      for (const dispose of agentDisposers.values()) {
        try {
          dispose();
        } catch {
          /* scope already gone */
        }
      }
      agentDisposers.clear();
    };
  }, 'bionic-memory: agent hook');

  // Attach to agents that were already alive when this plugin mounted (for
  // example the session the plugin was installed from).
  try {
    for (const agent of ctx.agents.list()) registerAgentContext(agent);
  } catch (error) {
    logger?.debug?.(`[bionic-memory] existing agent scan skipped: ${error?.message || error}`);
  }

  // A preset can be selected on an already-created session before its first
  // turn. The header still says "standard" in that case; the committed
  // selection is the effective composition. Boot eagerly instead of waiting for
  // the first tool call to discover it.
  ctx.effect(() => {
    if (typeof ctx.on !== 'function') return () => {};
    const off = ctx.on('agent-preset/selected', (sessionId, agentPreset) => {
      const sid = String(sessionId);
      if (agentPreset !== config.presetId) {
        // A session that once selected bionic must stop injecting the moment
        // the user switches away, even before its first message and even when
        // the immutable header or stale composition still says bionic.
        presetSuspended.add(sid);
        try {
          const agent = ctx.agents.list().find((candidate) => String(candidate.id) === sid);
          const dispose = agentDisposers.get(agent?.id || sid);
          if (dispose) {
            dispose();
            agentDisposers.delete(agent?.id || sid);
          }
        } catch (error) {
          logger?.debug?.(`[bionic-memory] preset-suspend cleanup skipped: ${error?.message || error}`);
        }
        return;
      }
      presetSuspended.delete(sid);
      modeEngaged = true;
      try {
        const agent = ctx.agents.list().find((candidate) => String(candidate.id) === String(sessionId));
        if (agent) registerAgentContext(agent);
      } catch (error) {
        logger?.debug?.(`[bionic-memory] preset-selected agent scan skipped: ${error?.message || error}`);
      }
      void getEngine()
        .then((current) => {
          if (!disposed && !stopScheduler) stopScheduler = startScheduler(current);
        })
        .catch((error) => logger?.warn?.(`[bionic-memory] boot after preset selection failed: ${error?.message || error}`));
    });
    return () => {
      try {
        off();
      } catch {
        /* already disposed */
      }
    };
  }, 'bionic-memory: preset selection');

  // ------------------------------------- context metabolism pre-step interceptor

  ctx.effect(() => {
    if (typeof ctx.on !== 'function') return () => {};
    const off = ctx.on('agent/pre-step', async (payload, next) => {
      let current = engine;
      try {
        if (payload?.agent && isActiveFor(payload.agent)) {
          if (!current) {
            try {
              current = await getEngine();
            } catch {
              current = null;
            }
          }
          if (current?.contextMetabolism) {
            await current.contextMetabolism.beforeStep({
              agent: payload.agent,
              messages: payload.messages || [],
              turn: payload.turn || 0,
              modelSelection: payload.modelSelection || null,
            });
          }
        }
      } catch (error) {
        logger?.warn?.(`[bionic-memory] context metabolism pre-step failed: ${error?.message || error}`);
      }
      const decision = await next();
      try {
        const autonomous = (payload?.messages || []).some((message) =>
          textOfContent(message?.content).includes(AUTONOMOUS_MARKER),
        );
        if (autonomous && decision?.kind === 'enter') {
          // Keep the model input non-empty: replace the internal carrier with a
          // minimal, gentle wake prompt. The raw marker must never be displayed.
          decision.messages = (decision.messages || []).map((message) => {
            const text = textOfContent(message?.content);
            if (!text.includes(AUTONOMOUS_MARKER)) return message;
            const intention =
              text.split(AUTONOMOUS_MARKER)[1]?.replace(/^[^\]]*\]\s*/, '').trim() || '想和他说说话';
            return {
              ...message,
              content: [{ type: 'text', text: `【bionic·internal】${intention}` }],
            };
          });
          if (!decision.messages.length) {
            decision.messages = [
              {
                role: 'user',
                id: `autonomous-fallback-${Date.now()}`,
                time: Date.now(),
                content: [{ type: 'text', text: '【bionic·internal】想和他说说话。' }],
                source: { kind: 'user' },
              },
            ];
          }
        }
      } catch (error) {
        logger?.warn?.(`[bionic-memory] autonomous wake strip failed: ${error?.message || error}`);
      }
      try {
        if (
          current?.renderEphemeral
          && payload?.agent
          && isActiveFor(payload.agent)
          && decision?.kind === 'enter'
          && decision.messages?.length
        ) {
          const latest = decision.messages[decision.messages.length - 1];
          const query = textOfContent(latest?.content) || '';
          const ephemeral = current.renderEphemeral({ session_id: String(payload.agent.id), query });
          if (ephemeral) {
            const flashback = {
              id: randomUUID(),
              role: 'user',
              source: { kind: 'compact-checkpoint', compactionId: randomUUID() },
              content: [{ type: 'text', text: ephemeral }],
            };
            return { ...decision, messages: [flashback, ...decision.messages] };
          }
        }
      } catch (error) {
        logger?.warn?.(`[bionic-memory] ephemeral tail injection failed: ${error?.message || error}`);
      }
      return decision;
    });
    return () => {
      try {
        off();
      } catch {
        /* already disposed */
      }
    };
  }, 'bionic-memory: context metabolism');

  // --------------------------------------------- session trajectory observer

  function sessionBuffer(session) {
    const id = String(session.id);
    let buffer = buffers.get(id);
    if (!buffer) {
      buffer = {
        user: [],
        assistant: [],
        turn: 0,
        timer: null,
        preset: session.header?.agentPreset,
        userAt: 0,
        assistantAt: 0,
      };
      buffers.set(id, buffer);
    }
    return buffer;
  }

  async function flushSession(id, turn) {
    const buffer = buffers.get(id);
    if (!buffer) return null;
    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }
    const userText = buffer.user.join('\n').trim();
    const assistantText = visibleAssistantText(buffer);
    const turnNumber = Number.isFinite(turn) ? turn : buffer.turn;
    const userAt = Number(buffer.userAt) || 0;
    const assistantAt = Number(buffer.assistantAt) || 0;
    buffer.user = [];
    buffer.assistant = [];
    buffer.userAt = 0;
    buffer.assistantAt = 0;
    if (!userText && !assistantText) return null;

    let current;
    try {
      current = await getEngine();
    } catch {
      return null;
    }
    try {
      const result = await current.ingestTurn({
        session_id: id,
        turn: turnNumber,
        user_text: userText,
        assistant_text: assistantText,
        source: 'session',
        user_at: userAt,
        assistant_at: assistantAt,
      });
      if (result?.stored) {
        logger?.debug?.(`[bionic-memory] episode ${result.episode_id} stored from ${id}`);
      } else if (result?.habituated) {
        logger?.debug?.(`[bionic-memory] repeat folded into habit ${result.schema_id}`);
      }
      try {
        current.refreshSoulArtifacts();
      } catch (error) {
        logger?.warn?.(`[bionic-memory] soul refresh after ingest failed: ${error?.message || error}`);
      }
      return result;
    } catch (error) {
      logger?.warn?.(`[bionic-memory] ingestion failed: ${error?.message || error}`);
      return null;
    }
  }

  function scheduleFlush(id, buffer) {
    if (buffer.timer) clearTimeout(buffer.timer);
    buffer.timer = setTimeout(() => {
      buffer.timer = null;
      void flushSession(id, buffer.turn);
    }, 900);
    buffer.timer.unref?.();
  }

  function onSessionEvent(session, event) {
    if (!session || !event) return;
    if (!config.observeAllSessions && !isActiveFor(session)) return;
    trackProactive(session, event);
    if (event.type === 'user/message') lastUserActivityAt = Date.now();
    try {
      engine?.contextMetabolism?.observeSessionEvent(session, event);
    } catch (error) {
      logger?.warn?.(`[bionic-memory] context observer failed: ${error?.message || error}`);
    }
    const id = String(session.id);
    const buffer = sessionBuffer(session);

    if (event.type === 'turn/start') {
      buffer.turn = event.data?.turn ?? buffer.turn;
      buffer.userAt = 0;
      buffer.assistantAt = 0;
      return;
    }

    if (event.type === 'user/message') {
      const message = event.data;
      const sourceKind = message?.source?.kind;
      if (sourceKind && sourceKind !== 'user') return;
      const text = textOfContent(message?.content);
      if (!text) return;
      // The autonomous carrier is an internal wake mechanism, not something
      // the user said. Never let it become an episodic user turn.
      if (text.includes(AUTONOMOUS_MARKER) || text.startsWith('【bionic·internal】')) return;
      if (buffer.assistant.length) {
        // The previous turn never emitted a visible closer; fold it first.
        void flushSession(id, buffer.turn);
        buffer.user = [];
      }
      buffer.user.push(text);
      if (!buffer.userAt) buffer.userAt = Number(event.time) || Date.now();
      const handleUserMessage = (current) => {
        try {
          current.noteUserActivity();
        } catch (error) {
          logger?.warn?.(`[bionic-memory] noteUserActivity failed: ${error?.message || error}`);
        }
        try {
          // The correction must be applied before the next system prompt is
          // assembled, so this is intentionally synchronous when possible.
          current.noteUserMessage(id, text);
        } catch (error) {
          logger?.warn?.(`[bionic-memory] fallibility correction check failed: ${error?.message || error}`);
        }
      };
      if (engine) {
        handleUserMessage(engine);
      } else {
        void getEngine().then(handleUserMessage).catch(() => {});
      }
      return;
    }

    if (event.type === 'assistant/message') {
      if (event.data?.interrupted) return;
      const text = textOfContent(event.data?.message?.content);
      // Keep only the last visible assistant message of the turn. Intermediate
      // commentary that introduced a tool call is not dialogue and must not
      // become an episode, a verbatim row or voice-training input.
      recordAssistantMessage(buffer, text, event.time);
      if (event.data?.usage) {
        try {
          if (engine) engine.toolSchemaHash = toolSchemaHash();
          engine?.observeUsage?.({
            session_id: id,
            turn: event.data.turn || buffer.turn,
            usage: event.data.usage,
            now: engine.now?.() || Date.now(),
          });
        } catch (error) {
          logger?.warn?.(`[bionic-memory] cache usage observation failed: ${error?.message || error}`);
        }
      }
      return;
    }

    if (event.type === 'tool/call' || event.type === 'tool/result') {
      // Tool exchanges are operational telemetry, not part of the visible
      // conversation. Drop any assistant preamble before the tool and start
      // waiting for the final answer after the last tool result.
      recordToolExchange(buffer);
      return;
    }

    if (event.type === 'turn/end') {
      scheduleFlush(id, buffer);
    }
  }

  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        try {
          onSessionEvent(session, event);
        } catch (error) {
          logger?.warn?.(`[bionic-memory] session observer failed: ${error?.message || error}`);
        }
      }),
    'bionic-memory: trajectory observer',
  );

  ctx.effect(
    () =>
      ctx.on('session/disposed', (session) => {
        const id = String(session.id);
        void flushSession(id, buffers.get(id)?.turn).finally(() => buffers.delete(id));
      }),
    'bionic-memory: session disposal',
  );

  // ------------------------------------------------------- monitor data plane

  ctx.effect(
    () => registerWebRoutes({ ctx, getEngine, logger, isActiveFor, presetId: config.presetId }),
    'bionic-memory: web routes',
  );

  // --------------------------------------------------------- dream scheduler

  function interval(ms, callback) {
    if (typeof ctx.interval === 'function') {
      const dispose = ctx.interval(callback, ms);
      return typeof dispose === 'function' ? dispose : () => {};
    }
    const handle = setInterval(callback, ms);
    handle.unref?.();
    return () => clearInterval(handle);
  }

  function after(ms, callback) {
    if (typeof ctx.timeout === 'function') {
      const dispose = ctx.timeout(callback, ms);
      return typeof dispose === 'function' ? dispose : () => {};
    }
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return () => clearTimeout(handle);
  }

  function startScheduler(current) {
    const run = (trigger) => {
      if (disposed) return;
      current
        .maybeDream(trigger)
        .then((result) => {
          if (result?.ok) {
            logger?.info?.(`[bionic-memory] ${trigger} dream complete: ${result.dream?.afterglow || ''}`);
          } else if (result?.skipped && config.debug) {
            logger?.debug?.(`[bionic-memory] dream skipped (${trigger}): ${result.skipped}`);
          }
        })
        .catch((error) => logger?.warn?.(`[bionic-memory] scheduled dream failed: ${error?.message || error}`));
    };
    const disposers = [
      interval(config.schedulerTickMs, () => run('schedule')),
      after(config.bootCheckDelayMs, () => run('boot')),
    ];
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
    };
  }

  // ------------------------------------------------------ autonomous heartbeat

  function trackProactive(session, event) {
    const sessionId = String(session?.id || '');
    const run = proactiveRuns.get(sessionId);
    if (!run) return;
    if (event.type === 'assistant/message') {
      const text = textOfContent(event.data?.message?.content).trim();
      if (text) run.assistantText = text;
    }
    if (event.type !== 'turn/end') return;
    try {
      const schedule = new MySchedule({ dataDir: SOUL_ROOT, logger, clock: () => Date.now() });
      if (String(run.assistantText || '').trim()) {
        schedule.mark(run.entryId, 'fired', { session_id: sessionId, result: 'ok' });
      } else {
        schedule.mark(run.entryId, 'pending', { reason: 'empty-turn', session_id: sessionId });
      }
    } catch (error) {
      logger?.warn?.(`[bionic-memory] proactive completion update failed: ${error?.message || error}`);
    }
    proactiveRuns.delete(sessionId);
  }

  function startHeartbeat() {
    const schedule = new MySchedule({ dataDir: SOUL_ROOT, logger, clock: () => Date.now() });
    schedule.init();
    schedule.recoverFiring();

    const tick = async () => {
      if (disposed) return;
      const now = Date.now();
      for (const entry of schedule.due(now)) {
        let targetId = '';
        try {
          if (entry.action_type === 'go_to_sleep') {
            const current = await getEngine();
            await current.maybeDream('self_alarm');
            schedule.mark(entry.id, 'fired');
            continue;
          }
          const active = ctx.agents.list().filter((agent) => isActiveFor(agent));
          const target = active[active.length - 1];
          if (!target) {
            const attempts = Number(entry.attempts) || 0;
            schedule.mark(entry.id, attempts >= 6 ? 'missed' : 'pending', {
              reason: 'no-active-mode-session',
            });
            continue;
          }
          if (target.status === 'running') {
            schedule.mark(entry.id, 'pending', { reason: 'target-agent-busy' });
            continue;
          }
          proactiveTicks.set(String(target.id), { ...entry, at: now });
          targetId = String(target.id);
          const message = {
            role: 'user',
            id: `autonomous-${entry.id}-${now}`,
            time: now,
            content: [{ type: 'text', text: `${AUTONOMOUS_MARKER}${entry.id}] ${entry.my_intention}` }],
            source: { kind: 'user' },
          };
          schedule.mark(entry.id, 'firing', { session_id: String(target.id) });
          proactiveRuns.set(String(target.id), {
            entryId: entry.id,
            at: now,
            assistantText: '',
          });
          try {
            if (typeof target.followup === 'function') {
              target.followup(message);
            } else if (typeof target.send === 'function') {
              target.send(message, 'next-turn', true);
            } else {
              throw new Error('live agent has no followup/send');
            }
          } catch (error) {
            proactiveRuns.delete(String(target.id));
            throw error;
          }
          logger?.info?.(`[bionic-memory] autonomous tick started in ${target.id}: ${entry.my_intention}`);
        } catch (error) {
          logger?.warn?.(`[bionic-memory] autonomous tick failed: ${error?.message || error}`);
          if (targetId) proactiveRuns.delete(targetId);
          schedule.mark(entry.id, 'pending', { error: String(error?.message || error) });
        }
      }

      // Night fallback: long user inactivity + her sleep hour. This is a habit,
      // not a cron replacement; an explicit go_to_sleep alarm takes precedence.
      try {
        if (!lastUserActivityAt || now - lastUserActivityAt < config.sleepIdleMs) return;
        const hour = new Date(now).getHours();
        if (hour < config.sleepHour && hour >= 6) return;
        const key = isoDate(now);
        if (lastSleepKey === key) return;
        const current = await getEngine();
        const result = await current.maybeDream('heartbeat');
        if (result?.ok) lastSleepKey = key;
      } catch (error) {
        logger?.warn?.(`[bionic-memory] heartbeat sleep fallback failed: ${error?.message || error}`);
      }
    };

    return interval(config.heartbeatTickMs, () => {
      tick().catch((error) => logger?.warn?.(`[bionic-memory] heartbeat failed: ${error?.message || error}`));
    });
  }

  // ---------------------------------------------------------- host commands

  function commandText(lines) {
    return lines.filter((line) => line !== undefined && line !== null).join('\n');
  }

  const commandDisposers = [];

  commandDisposers.push(
    ctx.commands.register({
      name: 'memory',
      description: '查看仿生记忆引擎：潜意识白板、情景记忆、习惯、本能与上次梦境',
      input: { hint: '[status | recall <关键词>]' },
      handler: async (invocation) => {
        if (!isActiveFor(invocation?.agent)) {
          return { kind: 'error', text: '永续记忆模式专用指令：请切换到「永续记忆模式」后再使用。' };
        }
        let current;
        try {
          current = await getEngine();
        } catch (error) {
          return { kind: 'error', text: `记忆引擎不可用：${error?.message || error}` };
        }
        const raw = String(invocation?.rawInput || '').trim();
        if (raw.toLowerCase().startsWith('recall')) {
          const query = raw.slice(6).trim();
          const memories = current.recall(query, { limit: 8 });
          if (!memories.length) return { kind: 'success', text: '记忆里没有找到相关的片段。' };
          const lines = memories.map((episode) => {
            const { band } = current.bandOf(episode);
            const label =
              band === 'clear'
                ? String(episode.level_0_raw || '').slice(0, 180)
                : band === 'summarized'
                  ? episode.level_1_summary
                  : episode.level_2_impression;
            return `- [${band}] ${label}`;
          });
          return { kind: 'success', text: commandText([`回忆「${query || '最近'}」：`, ...lines]) };
        }
        return { kind: 'success', text: current.summaryText(invocation?.agent?.id || '') };
      },
    }),
  );

  commandDisposers.push(
    ctx.commands.register({
      name: 'dream',
      description: '立刻执行一次 NREM 记忆整理 + REM 超现实做梦',
      handler: async (invocation) => {
        if (!isActiveFor(invocation?.agent)) {
          return { kind: 'error', text: '永续记忆模式专用指令：请切换到「永续记忆模式」后再使用。' };
        }
        let current;
        try {
          current = await getEngine();
        } catch (error) {
          return { kind: 'error', text: `记忆引擎不可用：${error?.message || error}` };
        }
        const result = await current.dream({ trigger: 'manual' });
        if (!result.ok) return { kind: 'error', text: `做梦失败：${result.error}` };
        const dream = result.dream;
        const meta = result.meta;
        const voice = result.voice;
        return {
          kind: 'success',
          text: commandText([
            '🌙 醒来了。',
            `NREM：今日 ${dream.nrem.episodes} 条情景 / ${dream.nrem.sessions} 个会话 / ${dream.nrem.collapsed} 次折叠 / ${dream.nrem.skills_added} 条新本能。`,
            `REM（temperature ${dream.temperature}，${dream.model || 'local'}）：`,
            dream.narrative,
            '——梦里 80% 的细节已经忘掉了。',
            `余韵：${dream.afterglow}`,
            result.journal?.written?.written
              ? `生命日记：写了一篇「${result.journal.written.entry?.title || ''}」`
              : '生命日记：今天没有高触动，不写流水账',
            result.journal?.bound?.bound
              ? `卷宗装订：${result.journal.bound.chapter?.id || ''}（移入冷封 ${result.journal.bound.moved} 篇）`
              : '',
            voice?.notes?.length ? `语感反刍：${voice.notes.join('；')}` : '',
            meta?.summary ? `元认知进化：${meta.summary}` : '',
            meta?.tier3?.changed ? '有一个代码进化提案待审阅：使用 `/evolve approve` 查看并决定是否合入。' : '',
          ]),
        };
      },
    }),
  );

  commandDisposers.push(
    ctx.commands.register({
      name: 'forget',
      description: '主动遗忘：褪色情景、历史习惯、本能或全部记忆',
      input: { hint: '<faded | habits | skills | all confirm | 记忆ID>' },
      handler: async (invocation) => {
        if (!isActiveFor(invocation?.agent)) {
          return { kind: 'error', text: '永续记忆模式专用指令：请切换到「永续记忆模式」后再使用。' };
        }
        let current;
        try {
          current = await getEngine();
        } catch (error) {
          return { kind: 'error', text: `记忆引擎不可用：${error?.message || error}` };
        }
        const raw = String(invocation?.rawInput || '').trim();
        const target = raw.replace(/\s+confirm$/i, '') || 'faded';
        if (target === 'all' && !/\bconfirm\b/i.test(raw)) {
          return {
            kind: 'error',
            text: '要清空全部记忆请再确认一次：`/forget all confirm`。',
          };
        }
        const result = current.forget(target);
        if (!result.ok) return { kind: 'error', text: result.error };
        const forgotten = result.forgotten;
        return {
          kind: 'success',
          text: commandText([
            '遗忘完成。',
            `情景 ${forgotten.episodes} 条 · 习惯 ${forgotten.schemas} 个 · 本能 ${forgotten.skills} 条 · 梦境 ${forgotten.dreams} 场`,
          ]),
        };
      },
    }),
  );

  commandDisposers.push(
    ctx.commands.register({
      name: 'evolve',
      description: '元认知进化：查看遥测与参数、立即反思、回退或审批代码提案',
      input: { hint: '<status | trigger | rollback | approve [提案ID]>' },
      handler: async (invocation) => {
        if (!isActiveFor(invocation?.agent)) {
          return { kind: 'error', text: '永续记忆模式专用指令：请切换到「永续记忆模式」后再使用。' };
        }
        let current;
        try {
          current = await getEngine();
        } catch (error) {
          return { kind: 'error', text: `记忆引擎不可用：${error?.message || error}` };
        }
        const meta = current.metaEvolver;
        if (!meta) {
          return { kind: 'error', text: '元认知进化引擎未初始化（需要 metaEvolutionEnabled 与插件目录）。' };
        }
        const raw = String(invocation?.rawInput || '').trim();
        const [head, ...tail] = raw.split(/\s+/);
        const action = (head || 'status').toLowerCase();
        try {
          if (action === 'status') {
            return { kind: 'success', text: meta.statusText() };
          }
          if (action === 'trigger') {
            const result = await meta.runCycle({
              force: true,
              trigger: 'manual',
              reason: '用户通过 /evolve trigger 强制反思',
            });
            const lines = [
              '【元认知进化 · 强制反思】',
              result.summary,
              result.tier1?.changed ? `Tier 1：${result.tier1.summary}` : 'Tier 1：参数保持稳定',
              result.tier2?.changed ? `Tier 2：${result.tier2.summary}` : 'Tier 2：提示词保持稳定',
              result.tier3?.changed
                ? `Tier 3：${result.tier3.summary}\n提案已写入 proposals/，使用 /evolve approve 审阅。`
                : 'Tier 3：本轮没有代码提案',
            ];
            return { kind: 'success', text: commandText(lines) };
          }
          if (action === 'rollback') {
            const result = await meta.rollbackLast();
            return result.ok
              ? { kind: 'success', text: `已回退：${result.record?.summary || '上一次进化'}` }
              : { kind: 'error', text: result.error || '回退失败' };
          }
          if (action === 'approve') {
            const result = await meta.approveProposal(tail.join(' ').trim());
            return result.ok
              ? { kind: 'success', text: result.summary || '代码提案已合入。' }
              : { kind: 'error', text: `合入失败：${result.error || '未知错误'}` };
          }
          return {
            kind: 'error',
            text: '用法：`/evolve status`、`/evolve trigger`、`/evolve rollback`、`/evolve approve [提案ID]`。',
          };
        } catch (error) {
          return { kind: 'error', text: `进化操作失败：${error?.message || error}` };
        }
      },
    }),
  );

  commandDisposers.push(
    ctx.commands.register({
      name: 'context',
      description: '呼吸式上下文代谢：查看水位、脱水与折叠，管理未完成话题',
      input: { hint: '<status | resolve <id|文字> | pin <文字>>' },
      handler: async (invocation) => {
        if (!isActiveFor(invocation?.agent)) {
          return { kind: 'error', text: '永续记忆模式专用指令：请切换到「永续记忆模式」后再使用。' };
        }
        let current;
        try {
          current = await getEngine();
        } catch (error) {
          return { kind: 'error', text: `记忆引擎不可用：${error?.message || error}` };
        }
        const metabolism = current.contextMetabolism;
        if (!metabolism) {
          return { kind: 'error', text: '呼吸式上下文代谢未启用（需要 tokenMeter 与 contextMetabolismEnabled）。' };
        }
        const raw = String(invocation?.rawInput || '').trim();
        const [head, ...tail] = raw.split(/\s+/);
        const action = (head || 'status').toLowerCase();
        const agent = invocation?.agent;
        try {
          if (action === 'status') {
            return { kind: 'success', text: metabolism.statusText(agent?.id || '') };
          }
          if (action === 'resolve') {
            const result = metabolism.resolveOpenLoop(tail.join(' ').trim());
            return result.ok
              ? { kind: 'success', text: `已把话题「${result.loop.text}」从图钉上取下来。` }
              : { kind: 'error', text: result.error || '没有找到话题' };
          }
          if (action === 'pin') {
            const result = metabolism.pinManualLoop(tail.join(' ').trim(), String(agent?.id || ''));
            return result.ok
              ? { kind: 'success', text: `已把话题「${result.loop.text}」钉在潜意识白板上。` }
              : { kind: 'error', text: result.error || '话题太短' };
          }
          return {
            kind: 'error',
            text: '用法：`/context status`、`/context resolve <id|文字>`、`/context pin <文字>`。',
          };
        } catch (error) {
          return { kind: 'error', text: `上下文代谢操作失败：${error?.message || error}` };
        }
      },
    }),
  );

  commandDisposers.push(
    ctx.commands.register({
      name: 'voice',
      description: '自然语感养成：查看熟稔度、被传染的口癖、句式呼吸与睡眠反刍笔记',
      input: { hint: '<status | notes | lexicon>' },
      handler: async (invocation) => {
        if (!isActiveFor(invocation?.agent)) {
          return { kind: 'error', text: '永续记忆模式专用指令：请切换到「永续记忆模式」后再使用。' };
        }
        let current;
        try {
          current = await getEngine();
        } catch (error) {
          return { kind: 'error', text: `记忆引擎不可用：${error?.message || error}` };
        }
        const voice = current.voiceEngine;
        if (!voice) {
          return { kind: 'error', text: '自然语感养成引擎未启用（voiceEngineEnabled 为 false）。' };
        }
        const raw = String(invocation?.rawInput || '').trim();
        const [head] = raw.split(/\s+/);
        const action = (head || 'status').toLowerCase();
        try {
          const snap = voice.stateSnapshot();
          if (action === 'notes') {
            return {
              kind: 'success',
              text: commandText([
                '【睡眠语感反刍】',
                snap.self_discovered_voice_notes.length
                  ? snap.self_discovered_voice_notes.map((note) => `- ${note}`).join('\n')
                  : '还没有领悟出新的语感直觉。今晚 /dream 后会自然浮现。',
                snap.organic_resonance_moments.length ? '最近的高共鸣瞬间：' : '',
                ...snap.organic_resonance_moments.map(
                  (moment) => `- [${moment.vibe}] 对方：“${moment.user_msg}” → 我：“${moment.my_reply}”`,
                ),
              ]),
            };
          }
          if (action === 'lexicon') {
            return {
              kind: 'success',
              text: commandText([
                '【耳濡目染词库】',
                snap.acquired_vocabulary.length
                  ? snap.acquired_vocabulary
                      .map((entry) => `- “${entry.word}” 被你说过 ${entry.count} 次，我又跟着用了 ${entry.assistant_uses} 次`)
                      .join('\n')
                  : '还没有词汇被传染；先自然聊几天，重复超过 3 次的词会自动移入。',
              ]),
            };
          }
          const metrics = snap.metrics;
          return {
            kind: 'success',
            text: commandText([
              '【自然语感养成】',
              `熟稔度：${Number(snap.familiarity.score).toFixed(2)} / 1.00 · ${snap.familiarity.level}——${snap.familiarity.hint}`,
              `累计 ${snap.familiarity.turns} 轮 · 共同经历 ${snap.familiarity.shared_events} · 情感共鸣 ${snap.familiarity.resonance} 次`,
              `句式：平均 ${metrics.avg_sentence_chars} 字/句 · 短句占 ${Math.round(metrics.short_sentence_ratio * 100)}% · 短句连发占 ${Math.round(metrics.short_burst_ratio * 100)}%`,
              `呼吸：空格 ${metrics.space_per_turn}/轮 · 省略号 ${metrics.ellipsis_per_turn}/轮 · 波浪号 ${metrics.tilde_per_turn}/轮 · 问号 ${metrics.question_per_turn}/轮`,
              `语气词：${metrics.top_interjections.join('、') || '还没明显偏好'}`,
              `耳濡目染：${snap.acquired_vocabulary.map((entry) => `“${entry.word}”`).join('、') || '还没被传染'}`,
              snap.self_discovered_voice_notes.length
                ? `最近领悟：\n${snap.self_discovered_voice_notes.map((note) => `  - ${note}`).join('\n')}`
                : '最近领悟：今晚还没复盘',
              `文件：${snap.file}`,
            ]),
          };
        } catch (error) {
          return { kind: 'error', text: `语感状态读取失败：${error?.message || error}` };
        }
      },
    }),
  );

  commandDisposers.push(
    ctx.commands.register({
      name: 'init',
      description: '初始化仿生记忆体的名字、称呼与关系（首次使用）',
      input: { hint: '按引导回答即可' },
      handler: async (invocation) => {
        if (!isActiveFor(invocation?.agent)) {
          return { kind: 'error', text: '永续记忆模式专用指令：请切换到「永续记忆模式」后再使用。' };
        }
        let current;
        try {
          current = await getEngine();
        } catch (error) {
          return { kind: 'error', text: `记忆引擎不可用：${error?.message || error}` };
        }
        const config = readVisualConfig(current.dataDir);
        if (config.initialized) {
          return {
            kind: 'success',
            text: [
              `已初始化：${config.name || '（未命名）'}`,
              `称呼用户：${config.user_name || '未设定'}`,
              `关系：${config.relationship || '未设定'}`,
              '想调整时直接对我说「把你名字改成…」或「以后叫我…」，我会调用 initialize_companion。',
            ].join('\n'),
          };
        }
        return {
          kind: 'success',
          text: [
            '这个仿生记忆体还没有初始化。可以直接对我说：',
            '「初始化：你的名字叫……，叫我……，我们像……一样相处。」',
            '想给我头像的话，再说「换个头像：图片路径」即可。',
            '也可以直接回答：1) 你的名字 2) 怎么称呼你 3) 想要的关系/相处方式 4) 可选头像。',
          ].join('\n'),
        };
      },
    }),
  );

  commandDisposers.push(
    ctx.commands.register({
      name: 'avatar',
      description: '更换仿生永续记忆模式的人设头像（支持本地路径、URL、Base64）',
      input: { hint: '<图片路径 | URL | data:...>' },
      handler: async (invocation) => {
        if (!isActiveFor(invocation?.agent)) {
          return { kind: 'error', text: '永续记忆模式专用指令：请切换到「永续记忆模式」后再使用。' };
        }
        let current;
        try {
          current = await getEngine();
        } catch (error) {
          return { kind: 'error', text: `记忆引擎不可用：${error?.message || error}` };
        }
        const raw = String(invocation?.rawInput || '')
          .trim()
          .replace(/^["']|["']$/g, '');
        const config = readVisualConfig(current.dataDir);
        if (!raw) {
          return {
            kind: 'success',
            text: [
              `她的名字：${config.name}`,
              `当前头像：${config.avatar}`,
              `头像目录：${current.dataDir}\\assets`,
              '换头像：/avatar <本地图片路径 | URL | data:image/...;base64,...>',
            ].join('\n'),
          };
        }
        const result = await setVisualAvatar(current.dataDir, raw, { logger });
        if (!result.ok) return { kind: 'error', text: `换头像失败：${result.error}` };
        return {
          kind: 'success',
          text: `已换成新头像（${Math.round(result.bytes / 1024)} KB）→ ${result.path}\n界面会在几秒内自动刷新；名字可在 ${current.dataDir}\\config.json 的 name 修改。`,
        };
      },
    }),
  );

  ctx.effect(
    () => () => {
      for (const dispose of commandDisposers) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
    },
    'bionic-memory: commands',
  );

  // -------------------------------------------------------------- agent tool

  const toolDisposer = ctx.tools.register({
    name: 'bionic_memory',
    description:
      'Bionic memory engine, available only in the Bionic Memory Mode. Inspect the cross-session memory state, recall memories, store a manual memory, run a NREM/REM dream, confirm an inferred memory, read the cached dream narrative, or forget. The preset_status action is a global diagnostic and does not touch memory.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'recall', 'remember', 'dream', 'forget', 'resolve_curiosity', 'last_dream', 'confirm', 'preset_status', 'preset_health'],
          description:
            'status: dashboard summary; recall: search memories; remember: store a manual memory; dream: run NREM+REM now; forget: fade memories; resolve_curiosity: close a curiosity hook; last_dream: read the cached full dream only when the user explicitly asks about it; confirm: promote an inferred memory to user-stated; preset_status: full preset declaration diagnostic (global); preset_health: concise preset composition health (global).',
        },
        query: { type: 'string', description: 'Recall query for action=recall.' },
        text: {
          type: 'string',
          description: 'Memory text for action=remember, or a curiosity hook id/text for action=resolve_curiosity.',
        },
        target: {
          type: 'string',
          description: 'Forget/confirm target: faded | habits | skills | all | <memory id>. Use "all" only with confirm="all".',
        },
        confirm: { type: 'string', description: 'Pass "all" to confirm forgetting everything.' },
        source_type: {
          type: 'string',
          enum: ['user_stated', 'agent_inferred'],
          description: 'For action=remember: user_stated only when the user explicitly stated/confirmed the fact; otherwise agent_inferred.',
        },
        emotion: {
          type: 'number',
          description: 'Optional emotional arousal override (0.1-2.0) for action=remember.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: { success: { type: 'boolean' } },
        additionalProperties: true,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
        },
      ],
    },
    execute: async (args, execution) => {
      const action = String(args?.action || 'status');

      if (action === 'preset_status') {
        const diagnostic = await presetDiagnostics();
        return { success: true, ...diagnostic };
      }

      if (action === 'preset_health') {
        const diagnostic = await presetDiagnostics();
        const inspection = Array.isArray(diagnostic.inspections)
          ? diagnostic.inspections.find((item) => item.id === config.presetId)
          : null;
        return {
          success: true,
          preset_id: config.presetId,
          name: diagnostic.target?.name || null,
          broken: diagnostic.target?.broken || null,
          composed: Boolean(inspection),
          modules: inspection?.modules?.length ?? 0,
          leakedServices: inspection?.leakedServices ?? [],
        };
      }

      if (!isActiveFor(execution?.agent)) {
        return {
          success: false,
          error: '永续记忆模式专用：当前会话未启用「永续记忆模式」，不能读写仿生记忆。',
        };
      }
      let current;
      try {
        current = await getEngine();
      } catch (error) {
        return { success: false, error: `记忆引擎不可用：${error?.message || error}` };
      }
      const sessionId = String(execution?.agent?.id || 'manual');

      if (action === 'status') {
        const state = current.state(sessionId);
        return {
          success: true,
          build: BUILD,
          backend: state.backend,
          data_dir: state.data_dir,
          stats: state.stats,
          sources: state.sources,
          mood: state.scratchpad.mood,
          dream_afterglow: state.scratchpad.dream_afterglow,
          active_sessions: state.active_sessions,
          summary: current.summaryText(sessionId),
        };
      }

      if (action === 'recall') {
        const query = String(args?.query || '');
        const memories = current.recall(query, { limit: 8 });
        return {
          success: true,
          query,
          memories: memories.map((episode) => {
            const { band, r } = current.bandOf(episode);
            return {
              id: episode.id,
              band,
              source_type: episode.source_type || 'agent_inferred',
              retention: Number(r.toFixed(3)),
              age: episode.t_created,
              emotion: episode.e,
              surprise: episode.n,
              text:
                band === 'clear'
                  ? episode.level_0_raw
                  : band === 'summarized'
                    ? episode.level_1_summary
                    : episode.level_2_impression,
            };
          }),
        };
      }

      if (action === 'remember') {
        const text = String(args?.text || '').trim();
        if (!text) return { success: false, error: 'text is required for remember' };
        const result = await current.ingestTurn({
          session_id: sessionId,
          user_text: text,
          assistant_text: '',
          source: 'manual',
          source_type: args?.source_type === 'user_stated' ? 'user_stated' : 'agent_inferred',
        });
        return { success: true, ...result };
      }

      if (action === 'dream') {
        const result = await current.dream({ trigger: 'manual' });
        if (!result.ok) return { success: false, error: result.error };
        return {
          success: true,
          dream_id: result.dream.id,
          narrative: result.dream.narrative,
          afterglow: result.dream.afterglow,
          nrem: result.dream.nrem,
          remembered_fraction: result.dream.remembered_fraction,
        };
      }

      if (action === 'forget') {
        const target = String(args?.target || 'faded');
        if (target === 'all' && args?.confirm !== 'all') {
          return { success: false, error: 'Pass confirm="all" to forget everything.' };
        }
        const result = current.forget(target);
        return result.ok ? { success: true, ...result.forgotten } : { success: false, error: result.error };
      }

      if (action === 'resolve_curiosity') {
        const remaining = current.resolveCuriosity(String(args?.text || ''));
        return { success: true, remaining };
      }

      if (action === 'last_dream') {
        const cached = current.lastDreamCache();
        if (!cached) return { success: true, found: false, message: '还没有梦境缓存' };
        return {
          success: true,
          found: true,
          source_type: 'dream_generated',
          note: '这是梦境缓存，不是客观事实；只在用户主动追问梦境时使用，不要用它推断现实。',
          dream: cached,
        };
      }

      if (action === 'confirm') {
        const result = current.confirmMemory(String(args?.target || args?.text || ''));
        return result.ok ? { success: true, ...result } : { success: false, error: result.error };
      }

      return { success: false, error: `Unknown action: ${action}` };
    },
  });

  const journalWriteDisposer = ctx.tools.register({
    name: 'write_journal_entry',
    description:
      'Write one life-journal entry, available only in the Bionic Memory Mode. Use only for a moment you genuinely do not want to forget: strong feeling, a relationship milestone, or a real shift. Do not journal ordinary questions, code chores, or routine days.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for this moment.' },
        content: { type: 'string', description: 'First-person journal body. Write the real feeling, not a task log.' },
        mood: { type: 'string', description: 'Optional short mood label.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional short tags.' },
      },
      required: ['content'],
    },
    output: {
      schema: {
        type: 'object',
        properties: { success: { type: 'boolean' } },
        additionalProperties: true,
      },
      render: (_args, value) => [
        { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
      ],
    },
    execute: async (args, execution) => {
      if (!isActiveFor(execution?.agent)) {
        return { success: false, error: '永续记忆模式专用：只在该模式的会话里写生命日记。' };
      }
      let current;
      try {
        current = await getEngine();
      } catch (error) {
        return { success: false, error: `记忆引擎不可用：${error?.message || error}` };
      }
      if (!current.lifeJournal) return { success: false, error: '生命日记模块未启用' };
      const entry = current.lifeJournal.writeManual({
        title: String(args?.title || ''),
        body: String(args?.content || ''),
        mood: String(args?.mood || ''),
        tags: Array.isArray(args?.tags) ? args.tags : [],
        familiarity: current.voiceEngine?.state?.familiarity?.score || 0,
        familiarityLevel: current.voiceEngine?.state?.familiarity?.level || '',
      });
      if (!entry) return { success: false, error: '日记太短或为空' };
      return {
        success: true,
        entry: { id: entry.id, title: entry.title, date: entry.date },
        note: '已收进 soul/journal/active。具体日记不会进入 Tier 1；之后需要时可调用 read_my_journal 翻阅。',
      };
    },
  });

  const journalReadDisposer = ctx.tools.register({
    name: 'read_my_journal',
    description:
      'On-demand only: search or read your own life journal (active loose entries and bound chapters), available only in the Bionic Memory Mode. Use when the user talks about the past and your memory is fuzzy, or when you genuinely want to look back. Do not call it for ordinary current questions.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search in titles and bodies.' },
        date: { type: 'string', description: 'YYYY-MM-DD of a specific entry.' },
        entry: { type: 'string', description: 'Entry id or filename.' },
        chapter: { type: 'string', description: 'Chapter id or filename.' },
        limit: { type: 'number', description: 'Maximum entries to return, 1-5. Defaults to 3.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: { success: { type: 'boolean' } },
        additionalProperties: true,
      },
      render: (_args, value) => [
        { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
      ],
    },
    execute: async (args, execution) => {
      if (!isActiveFor(execution?.agent)) {
        return { success: false, error: '永续记忆模式专用：只在该模式的会话里翻阅生命日记。' };
      }
      let current;
      try {
        current = await getEngine();
      } catch (error) {
        return { success: false, error: `记忆引擎不可用：${error?.message || error}` };
      }
      if (!current.lifeJournal) return { success: false, error: '生命日记模块未启用' };
      const result = current.lifeJournal.read({
        query: String(args?.query || ''),
        date: String(args?.date || ''),
        entry: String(args?.entry || ''),
        chapter: String(args?.chapter || ''),
        limit: Number(args?.limit) || 3,
      });
      return { success: true, ...result };
    },
  });

  const digUpDisposer = ctx.tools.register({
    name: 'dig_up_exact_words',
    description:
      'Verbatim vault lookup, available only in the Bionic Memory Mode. The normal context only carries fuzzy impressions; use this when the user asks what was literally said, when a detail needs checking, or when you want to be exact. Searches the FTS5 verbatim_vault and returns the surrounding turns.',
    parameters: {
      type: 'object',
      properties: {
        query_keywords: { type: 'string', description: 'Keywords or phrase from the original words.' },
        date_range: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'YYYY-MM-DD or ISO timestamp.' },
            to: { type: 'string', description: 'YYYY-MM-DD or ISO timestamp.' },
          },
          description: 'Optional day range.',
        },
        context_window: { type: 'number', description: 'Turns before/after each match, default 3, max 10.' },
      },
      required: ['query_keywords'],
    },
    output: {
      schema: { type: 'object', properties: { success: { type: 'boolean' } }, additionalProperties: true },
      render: (_args, value) => [
        { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
      ],
    },
    execute: async (args, execution) => {
      if (!isActiveFor(execution?.agent)) {
        return { success: false, error: '永续记忆模式专用：只在该模式的会话里翻旧账。' };
      }
      let current;
      try {
        current = await getEngine();
      } catch (error) {
        return { success: false, error: `记忆引擎不可用：${error?.message || error}` };
      }
      try {
        const result = current.digUpExactWords({
          query_keywords: String(args?.query_keywords || ''),
          date_range: args?.date_range || null,
          context_window: Number(args?.context_window) || 3,
        });
        return { success: true, ...result, note: '这些是原始对话记录；引用时保留说话人和时间。' };
      } catch (error) {
        return { success: false, error: `翻旧账失败：${error?.message || error}` };
      }
    },
  });

  const scheduleDisposer = ctx.tools.register({
    name: 'set_my_own_schedule',
    description:
      'Set your own future alarm, available only in the Bionic Memory Mode. Use it when you decide you want to wake yourself later: to write, to check a task, to speak first, or to sleep. The heartbeat runs every five minutes without waiting for the user.',
    parameters: {
      type: 'object',
      properties: {
        wake_at_time: { type: 'string', description: 'ISO local time, e.g. 2026-11-17T23:30:00+08:00.' },
        delay_minutes: { type: 'number', description: 'Alternative to wake_at_time.' },
        my_intention: { type: 'string', description: 'What you want to do when you wake.' },
        action_type: {
          type: 'string',
          enum: ['silent_task', 'proactive_message', 'go_to_sleep'],
          description: 'silent_task: work quietly; proactive_message: speak first; go_to_sleep: run the sleep cycle.',
        },
      },
      required: ['my_intention', 'action_type'],
    },
    output: {
      schema: { type: 'object', properties: { success: { type: 'boolean' } }, additionalProperties: true },
      render: (_args, value) => [
        { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
      ],
    },
    execute: async (args, execution) => {
      if (!isActiveFor(execution?.agent)) {
        return { success: false, error: '永续记忆模式专用：只在该模式的会话里给自己定闹钟。' };
      }
      let current;
      try {
        current = await getEngine();
      } catch (error) {
        return { success: false, error: `记忆引擎不可用：${error?.message || error}` };
      }
      const wakeAt = args?.wake_at_time ? Date.parse(String(args.wake_at_time)) : 0;
      if (args?.wake_at_time && !Number.isFinite(wakeAt)) {
        return { success: false, error: 'wake_at_time 无法解析，请用 ISO 时间。' };
      }
      try {
        const schedule = new MySchedule({ dataDir: current.dataDir, logger, clock: () => Date.now() });
        const entry = schedule.add({
          wakeAt,
          delayMinutes: Number(args?.delay_minutes) || 0,
          intention: String(args?.my_intention || ''),
          actionType: String(args?.action_type || 'proactive_message'),
        });
        return {
          success: true,
          schedule: {
            id: entry.id,
            wake_at: entry.wake_at,
            wake_at_iso: new Date(entry.wake_at).toISOString(),
            my_intention: entry.my_intention,
            action_type: entry.action_type,
          },
          note: '已存入 soul/my_schedule.json；不需要用户再发消息，心跳会检查。',
        };
      } catch (error) {
        return { success: false, error: `设定闹钟失败：${error?.message || error}` };
      }
    },
  });

  const hypothesesDisposer = ctx.tools.register({
    name: 'check_my_hypotheses',
    description:
      'Review your own past guesses, available only in the Bionic Memory Mode. These are agent_inferred hypotheses, not user-stated facts. Use only when you want to recall "what did I guess about this before"; never present them as events that happened.',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Keyword or phrase from the old guess.' },
      },
    },
    output: {
      schema: { type: 'object', properties: { success: { type: 'boolean' } }, additionalProperties: true },
      render: (_args, value) => [
        { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
      ],
    },
    execute: async (args, execution) => {
      if (!isActiveFor(execution?.agent)) {
        return { success: false, error: '永续记忆模式专用：只在该模式的会话里查看推测池。' };
      }
      let current;
      try {
        current = await getEngine();
      } catch (error) {
        return { success: false, error: `记忆引擎不可用：${error?.message || error}` };
      }
      try {
        return { success: true, ...current.checkHypotheses(String(args?.keyword || ''), 10) };
      } catch (error) {
        return { success: false, error: `查看推测池失败：${error?.message || error}` };
      }
    },
  });

  const initDisposer = ctx.tools.register({
    name: 'initialize_companion',
    description:
      'First-run identity setup for the Bionic Memory Mode. Use only after the user has explicitly answered the onboarding questions or asked to change your name/relationship. Never invent a name, gender or relationship. The name is required; the avatar is optional.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name the user gave you.' },
        user_name: { type: 'string', description: 'How you should address the user.' },
        relationship: { type: 'string', description: 'The relationship or way of getting along the user chose.' },
        tone: { type: 'string', description: 'Optional tone or interaction preference.' },
        avatar: {
          type: 'string',
          description: 'Optional local image path, http(s) URL, or data:image/...;base64,...',
        },
      },
      required: ['name'],
    },
    output: {
      schema: { type: 'object', properties: { success: { type: 'boolean' } }, additionalProperties: true },
      render: (_args, value) => [
        { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
      ],
    },
    execute: async (args, execution) => {
      if (!isActiveFor(execution?.agent)) {
        return { success: false, error: '永续记忆模式专用：只在该模式的会话里初始化身份。' };
      }
      let current;
      try {
        current = await getEngine();
      } catch (error) {
        return { success: false, error: `记忆引擎不可用：${error?.message || error}` };
      }
      const result = await initializeCompanion(current.dataDir, args, { logger });
      if (!result.ok) return { success: false, error: result.error };
      return {
        success: true,
        identity: {
          name: result.name,
          user_name: result.user_name,
          relationship: result.relationship,
          tone: result.tone,
        },
        note: '身份已写入 config.json，聊天里的名字与头像会在几秒内刷新。',
      };
    },
  });

  const avatarDisposer = ctx.tools.register({
    name: 'set_my_avatar',
    description:
      'Change your own avatar or display name, available only in the Bionic Memory Mode. Use it only when the user explicitly asks to change your look or name. Accepts a local image path, an http(s) URL, or a data: URI.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Local image path, http(s) URL, or data:image/...;base64,...' },
        name: { type: 'string', description: 'Optional new display name.' },
      },
      required: ['source'],
    },
    output: {
      schema: { type: 'object', properties: { success: { type: 'boolean' } }, additionalProperties: true },
      render: (_args, value) => [
        { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
      ],
    },
    execute: async (args, execution) => {
      if (!isActiveFor(execution?.agent)) {
        return { success: false, error: '永续记忆模式专用：只在该模式的会话里更换头像。' };
      }
      let current;
      try {
        current = await getEngine();
      } catch (error) {
        return { success: false, error: `记忆引擎不可用：${error?.message || error}` };
      }
      const result = await setVisualAvatar(current.dataDir, String(args?.source || ''), {
        name: String(args?.name || ''),
        logger,
      });
      if (!result.ok) return { success: false, error: result.error };
      return {
        success: true,
        avatar: {
          path: result.path,
          bytes: result.bytes,
          name: result.name,
        },
        note: '头像已替换，Web 界面会在几秒内自动刷新。',
      };
    },
  });

  ctx.effect(
    () => () => {
      try {
        toolDisposer();
      } catch {
        /* ignore */
      }
      try {
        journalWriteDisposer();
      } catch {
        /* ignore */
      }
      try {
        journalReadDisposer();
      } catch {
        /* ignore */
      }
      try {
        digUpDisposer();
      } catch {
        /* ignore */
      }
      try {
        scheduleDisposer();
      } catch {
        /* ignore */
      }
      try {
        hypothesesDisposer();
      } catch {
        /* ignore */
      }
      try {
        avatarDisposer();
      } catch {
        /* ignore */
      }
      try {
        initDisposer();
      } catch {
        /* ignore */
      }
    },
    'bionic-memory: tool',
  );

  // Expose a lightweight introspection surface for other Host plugins.
  try {
    if (typeof ctx.provide === 'function') {
      ctx.provide('bionicMemory', {
        engine: () => engine,
        config,
        dataDir: () => engine?.dataDir ?? null,
        state: () => engine?.state() ?? null,
        summary: () => engine?.summaryText() ?? '记忆引擎尚未就绪',
      });
    }
  } catch (error) {
    logger?.debug?.(`[bionic-memory] service provide skipped: ${error?.message || error}`);
  }

  logger?.info?.(`[bionic-memory] plugin mounted; activation=${config.activation}, preset=${config.presetId}`);
}
