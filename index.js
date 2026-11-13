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
import { BionicMemoryEngine } from './lib/engine.js';
import { createLlmHost } from './lib/llm.js';
import { openStore } from './lib/store.js';
import { textOfContent } from './lib/text.js';
import { registerWebRoutes } from './lib/web.js';

export const name = '@local/dsh-bionic-memory';

export const inject = ['agents', 'agentPresets', 'commands', 'sessions', 'systemPrompt', 'timer', 'tools', 'webServer'];

const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const RULES = fs.readFileSync(path.join(PACKAGE_DIR, 'prompt-template.md'), 'utf8').trim();

const RULES_SECTION = 'bionic-memory:cognitive-rules';
const CONTEXT_SECTION = 'bionic-memory:memory-context';
const METABOLISM_CONTEXT = 'bionic-memory:context-metabolism';
const BUILD = 'bionic-0.5.3';

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const logger = ctx.logger;
  const sessions = ctx.get('sessions');
  const agentPresets = ctx.get('agentPresets');
  const pluginManager = ctx.get('pluginManager');
  const tokenMeter = ctx.get('tokenMeter');
  const llmRuntime = ctx.get('llm');

  const agentDisposers = new Map();
  const buffers = new Map();

  let engine = null;
  let disposed = false;
  let bootPromise = null;
  let stopScheduler = null;
  let modeEngaged = false;

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

  function resolveDataDir() {
    const base = baseDirectory();
    if (!config.dataDir) return path.join(base, '.dsh', 'bionic-memory');
    return path.isAbsolute(config.dataDir) ? config.dataDir : path.join(base, config.dataDir);
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

  const getEngine = async () => {
    if (engine) return engine;
    if (bootPromise) return bootPromise;
    bootPromise = (async () => {
      const dataDir = resolveDataDir();
      const store = await openStore({ dir: dataDir, logger });
      const created = new BionicMemoryEngine({
        store,
        config,
        logger,
        llm,
        sessions,
        dataDir,
        packageDir: PACKAGE_DIR,
        basePrompt: RULES,
        pluginReload: reloadPlugin,
        tokenMeter,
        llmRuntime,
      });
      created.init();
      engine = created;
      logger?.info?.(
        `[bionic-memory] engine ready (${store.kind}) at ${dataDir}; activation=${config.activation}`,
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
    if (config.activation === 'all') return true;
    try {
      const session =
        agentOrSession && typeof agentOrSession.id === 'string' && !agentOrSession.header
          ? sessions?.get?.(agentOrSession.id)
          : agentOrSession;
      if (!session) return false;
      // The session header stores the preset used at creation. A preset chosen
      // before the first turn is committed as an `agent-preset/selected` event
      // and is the effective composition; the header stays "standard". Always
      // consult the committed selection first, with the header as a fast path.
      if (session.header?.agentPreset === config.presetId) return true;
      const presets = agentPresets || ctx.get?.('agentPresets');
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
      if (agentPreset !== config.presetId) return;
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
      buffer = { user: [], assistant: [], turn: 0, timer: null, preset: session.header?.agentPreset };
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
    const assistantText = buffer.assistant.join('\n').trim();
    const turnNumber = Number.isFinite(turn) ? turn : buffer.turn;
    buffer.user = [];
    buffer.assistant = [];
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
      });
      if (result?.stored) {
        logger?.debug?.(`[bionic-memory] episode ${result.episode_id} stored from ${id}`);
      } else if (result?.habituated) {
        logger?.debug?.(`[bionic-memory] repeat folded into habit ${result.schema_id}`);
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
    try {
      engine?.contextMetabolism?.observeSessionEvent(session, event);
    } catch (error) {
      logger?.warn?.(`[bionic-memory] context observer failed: ${error?.message || error}`);
    }
    const id = String(session.id);
    const buffer = sessionBuffer(session);

    if (event.type === 'turn/start') {
      buffer.turn = event.data?.turn ?? buffer.turn;
      return;
    }

    if (event.type === 'user/message') {
      const message = event.data;
      const sourceKind = message?.source?.kind;
      if (sourceKind && sourceKind !== 'user') return;
      const text = textOfContent(message?.content);
      if (!text) return;
      if (buffer.assistant.length) {
        // The previous turn never emitted a visible closer; fold it first.
        void flushSession(id, buffer.turn);
        buffer.user = [];
      }
      buffer.user.push(text);
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
      if (text) buffer.assistant.push(text);
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
    () => registerWebRoutes({ ctx, getEngine, logger }),
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
        return {
          kind: 'success',
          text: commandText([
            '🌙 醒来了。',
            `NREM：今日 ${dream.nrem.episodes} 条情景 / ${dream.nrem.sessions} 个会话 / ${dream.nrem.collapsed} 次折叠 / ${dream.nrem.skills_added} 条新本能。`,
            `REM（temperature ${dream.temperature}，${dream.model || 'local'}）：`,
            dream.narrative,
            '——梦里 80% 的细节已经忘掉了。',
            `余韵：${dream.afterglow}`,
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

  ctx.effect(
    () => () => {
      try {
        toolDisposer();
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
