/**
 * Configuration defaults and normalization for the bionic memory engine.
 *
 * This module is dependency-free so the algorithm can be exercised by the
 * pre-install smoke test without a Cordis runtime.
 */

export const DEFAULT_CONFIG = Object.freeze({
  // Where `memory.db` / `memory.json` live. Empty means
  // `<workingDirectory.defaultDirectory>/.dsh/bionic-memory`.
  dataDir: '',

  // 'all' injects the memory context into every session; 'preset' restricts
  // injection to sessions started with `presetId`.
  activation: 'preset',
  presetId: 'bionic-memory',
  observeAllSessions: false,

  // Dream scheduler.
  dreamHour: 4,
  dreamIntervalHours: 18,
  schedulerTickMs: 10 * 60 * 1000,
  bootCheckDelayMs: 45 * 1000,
  dreamTemperature: 1.25,
  dreamMaxTokens: 520,
  dreamForgetRatio: 0.8,
  dreamSamplesHot: 2,
  dreamSamplesOld: 2,
  // If the LLM batch omits a precomputed similar cluster, still collapse it
  // deterministically so repetitive compression never silently stops.
  batchCollapseFallback: true,

  // Model-assisted phases. Deterministic local fallbacks run when this is off,
  // no model is configured, or a request fails.
  llmEnabled: true,
  skillExtraction: true,
  llmTimeoutMs: 45 * 1000,

  // Context assembly.
  contextCharBudget: 3000,
  contextRawChars: 420,
  sessionHintMax: 3,
  sessionHintFreshHours: 24,
  reconsolidationWindowMs: 30 * 60 * 1000,
  maxClear: 4,
  maxSummarized: 4,
  maxFaded: 6,
  maxHabits: 5,
  maxSkills: 20,
  skillMergeSimilarity: 0.75,
  skillTriggerSimilarity: 0.3,
  skillIdleDays: 30,
  maxCuriosity: 3,
  maxProceduralRuleChars: 180,

  // Organic voice emergence: linguistic mirroring, familiarity growth and
  // sleep-time first-person voice reflection. No canned examples are injected.
  voiceEngineEnabled: true,
  voiceReflectionEnabled: true,
  voiceLexiconThreshold: 3,
  voiceLexiconMax: 24,
  voiceLexiconTop: 8,
  voiceRecentTurns: 120,
  voiceRecentHighDays: 7,
  voiceFamiliarityTurnScale: 70,
  voiceFamiliarityEventScale: 35,
  voiceFamiliarityResonanceScale: 10,

  // Controlled memory fallibility (only mid-low retention, non-core daily
  // memories; core task/code memories and R > 0.6 are always immune).
  fallibilityEnabled: true,
  fallibilityChanceMin: 0.15,
  fallibilityChanceMax: 0.25,
  fallibilityBandMin: 0.2,
  fallibilityBandMax: 0.5,
  fallibilityTipBandMax: 0.35,
  fallibilityTtlMs: 24 * 60 * 60 * 1000,
  fallibilityMaxAnchors: 3,

  // Meta-evolution: telemetry, self-tuning, prompt evolution and code proposals.
  metaEvolutionEnabled: true,
  similarityThreshold: 0,
  metaEvolutionTrialDays: 3,
  metaEvolutionPromptSessions: 10,
  metaEvolutionPromptDays: 7,
  metaEvolutionCodeDays: 14,

  // Breathing context metabolism: token waterlines, tool dehydration, rolling
  // micro-consolidation, overload yawn and cross-session handover.
  contextMetabolismEnabled: true,
  contextWaterlineBatch: 0.82,
  contextBatchPrefixRatio: 0.45,
  contextWaterlineTool: 0.6,
  contextWaterlineMicro: 0.75,
  contextWaterlineOverload: 0.88,
  contextToolAgeTurns: 15,
  contextToolMinChars: 600,
  contextCollapseRatio: 0.35,
  contextEmergencyRatio: 0.6,
  contextHandoverMinutes: 5,
  contextHandoverWaterline: 0.75,
  contextOpenLoopMax: 12,

  // Forgetting / consolidation.
  fadeThreshold: 0.3,
  clearThreshold: 0.7,
  habitSimilarity: 0.58,
  habituationSurprise: 0.3,
  collapseSimilarity: 0.45,
  collapseThreshold: 3,
  defaultS0: 48,
  s0Multiplier: 1,
  maxRawChars: 1800,
  summaryChars: 140,
  impressionChars: 120,
  decayIntervalMs: 5 * 60 * 1000,
  recallWakeCooldownMs: 30 * 60 * 1000,
  habitDegradeMinHours: 72,

  debug: false,
});

const NUMBER_FIELDS = [
  'dreamHour', 'dreamIntervalHours', 'schedulerTickMs', 'bootCheckDelayMs',
  'dreamTemperature', 'dreamMaxTokens', 'dreamForgetRatio', 'dreamSamplesHot',
  'dreamSamplesOld', 'llmTimeoutMs', 'contextCharBudget', 'contextRawChars',
  'maxClear', 'maxSummarized', 'maxFaded', 'maxHabits', 'maxSkills',
  'maxCuriosity', 'maxProceduralRuleChars', 'fadeThreshold', 'clearThreshold',
  'habitSimilarity', 'habituationSurprise', 'collapseSimilarity',
  'collapseThreshold', 'defaultS0', 's0Multiplier', 'maxRawChars', 'summaryChars',
  'impressionChars', 'decayIntervalMs', 'recallWakeCooldownMs',
  'habitDegradeMinHours', 'skillMergeSimilarity', 'skillTriggerSimilarity',
  'skillIdleDays', 'sessionHintMax', 'sessionHintFreshHours',
  'reconsolidationWindowMs', 'fallibilityChanceMin', 'fallibilityChanceMax',
  'fallibilityBandMin', 'fallibilityBandMax', 'fallibilityTipBandMax',
  'fallibilityTtlMs', 'fallibilityMaxAnchors',
  'similarityThreshold', 'metaEvolutionTrialDays', 'metaEvolutionPromptSessions',
  'metaEvolutionPromptDays', 'metaEvolutionCodeDays',
  'contextWaterlineTool', 'contextWaterlineMicro', 'contextWaterlineOverload',
  'contextWaterlineBatch', 'contextBatchPrefixRatio',
  'contextToolAgeTurns', 'contextToolMinChars', 'contextCollapseRatio',
  'contextEmergencyRatio', 'contextHandoverMinutes', 'contextHandoverWaterline',
  'contextOpenLoopMax',
  'voiceLexiconThreshold', 'voiceLexiconMax', 'voiceLexiconTop',
  'voiceRecentTurns', 'voiceRecentHighDays', 'voiceFamiliarityTurnScale',
  'voiceFamiliarityEventScale', 'voiceFamiliarityResonanceScale',
];

const BOOLEAN_FIELDS = [
  'observeAllSessions',
  'llmEnabled',
  'skillExtraction',
  'batchCollapseFallback',
  'fallibilityEnabled',
  'metaEvolutionEnabled',
  'contextMetabolismEnabled',
  'voiceEngineEnabled',
  'voiceReflectionEnabled',
  'debug',
];

function toFinite(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

/** Normalize an arbitrary Loader config object into a complete, bounded config. */
export function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const config = { ...DEFAULT_CONFIG };

  for (const field of NUMBER_FIELDS) {
    if (input[field] !== undefined) config[field] = toFinite(input[field], DEFAULT_CONFIG[field]);
  }
  for (const field of BOOLEAN_FIELDS) {
    if (input[field] !== undefined) config[field] = Boolean(input[field]);
  }

  if (typeof input.dataDir === 'string') config.dataDir = input.dataDir.trim();
  if (input.activation === 'preset' || input.activation === 'all') config.activation = input.activation;
  if (typeof input.presetId === 'string' && input.presetId.trim()) config.presetId = input.presetId.trim();

  config.dreamHour = Math.round(config.dreamHour);
  if (config.dreamHour < 0) config.dreamHour = 0;
  if (config.dreamHour > 23) config.dreamHour = 23;

  // Keep threshold ordering sane regardless of what the profile wrote.
  config.fadeThreshold = Math.min(0.95, Math.max(0.05, config.fadeThreshold));
  config.clearThreshold = Math.min(0.99, Math.max(config.fadeThreshold + 0.01, config.clearThreshold));
  config.collapseThreshold = Math.max(2, Math.round(config.collapseThreshold));
  config.dreamForgetRatio = Math.min(0.95, Math.max(0, config.dreamForgetRatio));
  config.dreamTemperature = Math.min(2, Math.max(0.1, config.dreamTemperature));
  config.maxClear = Math.max(1, Math.round(config.maxClear));
  config.maxSummarized = Math.max(1, Math.round(config.maxSummarized));
  config.maxFaded = Math.max(1, Math.round(config.maxFaded));
  config.maxHabits = Math.max(0, Math.round(config.maxHabits));
  config.maxSkills = Math.max(0, Math.round(config.maxSkills));
  config.maxCuriosity = Math.max(0, Math.round(config.maxCuriosity));
  config.fallibilityChanceMin = Math.min(0.95, Math.max(0, config.fallibilityChanceMin));
  config.fallibilityChanceMax = Math.min(0.99, Math.max(config.fallibilityChanceMin, config.fallibilityChanceMax));
  config.fallibilityBandMin = Math.min(0.95, Math.max(0, config.fallibilityBandMin));
  config.fallibilityBandMax = Math.min(0.99, Math.max(config.fallibilityBandMin + 0.01, config.fallibilityBandMax));
  config.fallibilityTipBandMax = Math.min(
    config.fallibilityBandMax,
    Math.max(config.fallibilityBandMin, config.fallibilityTipBandMax),
  );
  config.fallibilityMaxAnchors = Math.max(0, Math.round(config.fallibilityMaxAnchors));
  config.similarityThreshold = Math.min(0.6, Math.max(0, config.similarityThreshold));
  config.s0Multiplier = Math.min(3, Math.max(0.5, config.s0Multiplier));
  config.metaEvolutionTrialDays = Math.max(1, Math.round(config.metaEvolutionTrialDays));
  config.metaEvolutionPromptSessions = Math.max(1, Math.round(config.metaEvolutionPromptSessions));
  config.metaEvolutionPromptDays = Math.max(1, Math.round(config.metaEvolutionPromptDays));
  config.metaEvolutionCodeDays = Math.max(1, Math.round(config.metaEvolutionCodeDays));
  config.contextWaterlineTool = Math.min(0.95, Math.max(0.3, config.contextWaterlineTool));
  config.contextWaterlineMicro = Math.min(
    0.97,
    Math.max(config.contextWaterlineTool + 0.01, config.contextWaterlineMicro),
  );
  config.contextWaterlineOverload = Math.min(
    0.99,
    Math.max(config.contextWaterlineMicro + 0.01, config.contextWaterlineOverload),
  );
  config.contextWaterlineBatch = Math.min(0.99, Math.max(0.5, config.contextWaterlineBatch));
  config.contextBatchPrefixRatio = Math.min(0.8, Math.max(0.1, config.contextBatchPrefixRatio));
  config.contextToolAgeTurns = Math.max(1, Math.round(config.contextToolAgeTurns));
  config.contextToolMinChars = Math.max(100, Math.round(config.contextToolMinChars));
  config.contextCollapseRatio = Math.min(0.9, Math.max(0.1, config.contextCollapseRatio));
  config.contextEmergencyRatio = Math.min(
    0.95,
    Math.max(config.contextCollapseRatio + 0.01, config.contextEmergencyRatio),
  );
  config.contextHandoverMinutes = Math.max(1, Math.round(config.contextHandoverMinutes));
  config.contextHandoverWaterline = Math.min(0.99, Math.max(0.3, config.contextHandoverWaterline));
  config.contextOpenLoopMax = Math.max(1, Math.round(config.contextOpenLoopMax));
  config.voiceLexiconThreshold = Math.min(20, Math.max(1, Math.round(config.voiceLexiconThreshold)));
  config.voiceLexiconMax = Math.min(200, Math.max(4, Math.round(config.voiceLexiconMax)));
  config.voiceLexiconTop = Math.min(20, Math.max(1, Math.round(config.voiceLexiconTop)));
  config.voiceRecentTurns = Math.min(500, Math.max(20, Math.round(config.voiceRecentTurns)));
  config.voiceRecentHighDays = Math.min(30, Math.max(1, Math.round(config.voiceRecentHighDays)));
  config.voiceFamiliarityTurnScale = Math.min(1000, Math.max(5, config.voiceFamiliarityTurnScale));
  config.voiceFamiliarityEventScale = Math.min(1000, Math.max(5, config.voiceFamiliarityEventScale));
  config.voiceFamiliarityResonanceScale = Math.min(100, Math.max(1, config.voiceFamiliarityResonanceScale));
  return config;
}
