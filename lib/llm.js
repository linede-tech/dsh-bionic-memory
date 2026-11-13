/**
 * Thin, failure-tolerant wrapper around the Host `llm` service.
 *
 * Dream and skill extraction are enhancements: when no model route is
 * configured, the call fails, or the user disabled it, the engine falls back
 * to deterministic local generation.
 */

export function createLlmHost({ ctx, logger, config }) {
  let lastModel = '';
  let lastFailure = '';

  function selection() {
    try {
      const service = ctx.get?.('agentDefaultModel');
      if (!service || typeof service.currentSelection !== 'function') return null;
      const current = service.currentSelection();
      if (!current?.provider || !current?.model) return null;
      return current;
    } catch {
      return null;
    }
  }

  function available() {
    if (!config.llmEnabled) return false;
    if (!ctx.get?.('llm')) return false;
    return selection() !== null;
  }

  async function generate({ system, prompt, temperature, maxTokens = 400, reasoningEffort, signal } = {}) {
    if (!available()) return null;
    const llm = ctx.get('llm');
    const current = selection();
    if (!llm || typeof llm.stream !== 'function' || !current) return null;

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) return null;
      signal.addEventListener('abort', abortFromCaller, { once: true });
    }
    const timer = setTimeout(() => {
      try {
        controller.abort(new Error('bionic-memory llm timeout'));
      } catch {
        /* ignore */
      }
    }, config.llmTimeoutMs);
    timer.unref?.();

    const options = {
      provider: current.provider,
      model: current.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens,
      signal: controller.signal,
    };
    if (Number.isFinite(temperature)) options.temperature = temperature;
    if (reasoningEffort) options.reasoningEffort = reasoningEffort;

    let output = '';
    let failure = null;
    try {
      for await (const chunk of llm.stream(options)) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          output += chunk.text;
        } else if (chunk?.type === 'finish') {
          if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
            failure = chunk.reason.failure || { message: chunk.reason.kind, code: chunk.reason.kind };
          }
        }
      }
    } catch (error) {
      failure = { message: error?.message || String(error), code: error?.code || 'THROW' };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromCaller);
    }

    if (failure) {
      lastFailure = failure.message || failure.code;
      logger?.warn?.(`[bionic-memory] model call failed (${failure.code || 'error'}): ${lastFailure}`);
      return null;
    }
    const text = output.trim();
    if (!text) {
      lastFailure = 'empty response';
      return null;
    }
    lastModel = `${current.provider}/${current.model}`;
    lastFailure = '';
    return text;
  }

  return {
    available,
    generate,
    selection,
    get lastModel() {
      return lastModel;
    },
    get lastFailure() {
      return lastFailure;
    },
  };
}
