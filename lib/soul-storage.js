/**
 * Global bionic-soul storage layout.
 *
 * One root for every workspace:
 *   ~/.dsh/bionic-soul/
 *     cortex/memory_cortex.sqlite       left brain: SQLite (WAL, busy_timeout)
 *     soul/scratchpad.json              Layer 1
 *     soul/emergent_voice.json          organic voice state
 *     soul/procedural_skills.md         Layer 4
 *     soul/dreams/YYYY-MM-DD.md         dream journal
 *     cache_blocks/tier0_static_dna.md  physical Tier 0 prefix
 *     cache_blocks/tier1_daily_frozen.md physical Tier 1 prefix
 *     orchestrator/agents.json        external-agent registry (arbitrary ids)
 *     orchestrator/briefings/<id>.md  desensitized bridge briefing per agent
 *     orchestrator/README.md          bridge contract
 *     evolution_lab/                    meta-evolution telemetry / proposals / snapshots
 *
 * The directory is a Git repository. The plain-text files are the human-readable
 * right brain; the SQLite file is the concurrent left brain.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { isoDate, round, xmlEscape } from './text.js';

export const SOUL_ROOT = path.join(os.homedir(), '.dsh', 'bionic-soul');

export function soulPaths(root = SOUL_ROOT) {
  const cortex = path.join(root, 'cortex');
  const soul = path.join(root, 'soul');
  const cache = path.join(root, 'cache_blocks');
  const orchestrator = path.join(root, 'orchestrator');
  const evolution = path.join(root, 'evolution_lab');
  return {
    root,
    cortex,
    soul,
    cache,
    orchestrator,
    evolution,
    dbFile: path.join(cortex, 'memory_cortex.sqlite'),
    jsonFile: path.join(cortex, 'memory_cortex.json'),
    tier0: path.join(cache, 'tier0_static_dna.md'),
    tier1: path.join(cache, 'tier1_daily_frozen.md'),
    dailyMeta: path.join(cache, 'tier1_meta.json'),
    scratchpad: path.join(soul, 'scratchpad.json'),
    voice: path.join(soul, 'emergent_voice.json'),
    skills: path.join(soul, 'procedural_skills.md'),
    dreams: path.join(soul, 'dreams'),
    agents: path.join(orchestrator, 'agents.json'),
    briefings: path.join(orchestrator, 'briefings'),
    orchestratorReadme: path.join(orchestrator, 'README.md'),
    archive: path.join(root, 'context-archive'),
    proposals: path.join(evolution, 'proposals'),
    snapshots: path.join(evolution, 'snapshots'),
    telemetry: path.join(evolution, 'telemetry.json'),
    metaEvolution: path.join(evolution, 'meta-evolution.json'),
    contextMetabolism: path.join(root, 'context-metabolism.json'),
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeFile(file, content) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content, 'utf8');
}

function escapeSqlPath(file) {
  return String(file).replace(/'/g, "''");
}

function sanitizeImprint(value) {
  return String(value || '')
    .replace(/【[^】]{1,6}】/g, '')
    .replace(/[“"][^”"]{0,160}[”"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function ensureInitialCommit(root, logger) {
  try {
    if (!fs.existsSync(path.join(root, '.git'))) {
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    }
    try {
      execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, stdio: 'ignore' });
      return;
    } catch {
      /* repository has no commit yet */
    }
    execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'bootstrap bionic-soul'], { cwd: root, stdio: 'ignore' });
  } catch (error) {
    logger?.warn?.(`[bionic-memory] soul git bootstrap skipped: ${error?.message || error}`);
  }
}

const DEFAULT_AGENTS = [
  {
    id: 'zcode',
    name: 'ZCode',
    description: '研发与代码协作 agent（示例；可删除或替换成你自己的外部 agent）',
    keywords: ['代码', '插件', '接口', 'bug', '报错', '错误', '修复', '测试', '部署', 'SQL', '脚本', '架构', '性能', '日志', '提示词', '人格'],
    briefing: 'briefings/zcode.md',
  },
  {
    id: 'workbuddy',
    name: 'WorkBuddy',
    description: '文档与办公协作 agent（示例；可删除或替换成你自己的外部 agent）',
    keywords: ['文档', '办公', '表格', 'PPT', 'Word', 'Excel', '演示', '排版', '写作', '审美', '汇报', '纪要', '知识库', '邮件'],
    briefing: 'briefings/workbuddy.md',
  },
];

const BRIDGE_README = `# External Agent Bridge

\`agents.json\` is the registry. It is deliberately not a fixed ZCode/WorkBuddy
list — those two entries are only shipped examples.

Add any external agent:

\`\`\`json
{
  "id": "my-agent",
  "name": "My Agent",
  "description": "what this agent is responsible for",
  "keywords": ["接口", "bug", "部署"],
  "briefing": "briefings/my-agent.md"
}
\`\`\`

The bionic-soul engine regenerates each briefing after every memory ingest and
dream. An external orchestrator should read \`agents.json\`, mount the listed
\`briefing\` path, and address the agent by \`id\`. It must not assume the
\`zcode\` or \`workbuddy\` ids exist.

The briefing is intentionally desensitized: it contains abstract instincts,
habits and fuzzy impressions, never raw private chat.
`;

function ensureAgentsManifest(paths) {
  ensureDir(paths.briefings);
  if (!fs.existsSync(paths.agents)) {
    writeFile(
      paths.agents,
      `${JSON.stringify(
        {
          version: 1,
          description: 'External agent bridge registry. Add or remove entries freely; the listed briefing path is regenerated after every ingest/dream.',
          agents: DEFAULT_AGENTS,
        },
        null,
        2,
      )}\n`,
    );
  }
  if (!fs.existsSync(paths.orchestratorReadme)) {
    writeFile(paths.orchestratorReadme, BRIDGE_README);
  }
}

function readAgents(paths) {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.agents, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed?.agents;
    if (!Array.isArray(list)) return DEFAULT_AGENTS;
    const agents = [];
    for (const agent of list) {
      if (!agent || typeof agent !== 'object') continue;
      const id = String(agent.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
      if (!id) continue;
      agents.push({
        id,
        name: String(agent.name || id),
        description: String(agent.description || ''),
        keywords: Array.isArray(agent.keywords)
          ? agent.keywords.map((word) => String(word || '').trim()).filter(Boolean)
          : [],
        briefing: String(agent.briefing || `briefings/${id}.md`).trim(),
      });
    }
    return agents.length ? agents : DEFAULT_AGENTS;
  } catch {
    return DEFAULT_AGENTS;
  }
}

function briefingPath(paths, agent) {
  const raw = String(agent.briefing || '').trim() || `briefings/${agent.id}.md`;
  const resolved = path.resolve(paths.orchestrator, raw);
  const base = `${path.resolve(paths.orchestrator)}${path.sep}`;
  if (!resolved.startsWith(base)) {
    return path.join(paths.briefings, `${agent.id}.md`);
  }
  return resolved;
}

function agentMatcher(agent) {
  const words = Array.isArray(agent.keywords) ? agent.keywords.filter(Boolean) : [];
  if (!words.length) return null;
  return new RegExp(
    words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'i',
  );
}

export function ensureSoul({ root = SOUL_ROOT, tier0Source = '', logger = null } = {}) {
  const paths = soulPaths(root);
  for (const dir of [
    paths.root,
    paths.cortex,
    paths.soul,
    paths.cache,
    paths.orchestrator,
    paths.briefings,
    paths.evolution,
    paths.dreams,
    paths.proposals,
    paths.snapshots,
  ]) {
    ensureDir(dir);
  }
  ensureAgentsManifest(paths);
  for (const legacy of ['zcode_briefing.md', 'workbuddy_briefing.md']) {
    try {
      const file = path.join(paths.orchestrator, legacy);
      if (fs.existsSync(file)) fs.rmSync(file);
    } catch {
      /* stale generated file; removal is best-effort */
    }
  }

  const ignore = path.join(root, '.gitignore');
  if (!fs.existsSync(ignore)) {
    writeFile(
      ignore,
      ['*.db-wal', '*.db-shm', '*.tmp', '*.log', 'node_modules/', 'context-archive/', ''].join('\n'),
    );
  }
  try {
    if (!fs.existsSync(path.join(root, '.git'))) {
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    }
  } catch (error) {
    logger?.warn?.(`[bionic-memory] soul git init skipped: ${error?.message || error}`);
  }
  ensureInitialCommit(root, logger);

  if (tier0Source && !fs.existsSync(paths.tier0)) {
    writeFile(paths.tier0, `${String(tier0Source).trim()}\n`);
  }
  return paths;
}

export function readTier0(root = SOUL_ROOT) {
  try {
    const file = soulPaths(root).tier0;
    if (!fs.existsSync(file)) return '';
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

export function readTier1(root = SOUL_ROOT) {
  try {
    const file = soulPaths(root).tier1;
    if (!fs.existsSync(file)) return '';
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

export function writeTier1(root, block, meta = {}) {
  const paths = soulPaths(root);
  writeFile(paths.tier1, `${String(block || '').trim()}\n`);
  writeFile(
    paths.dailyMeta,
    `${JSON.stringify({ ...meta, bytes: String(block || '').length }, null, 2)}\n`,
  );
}

export function writeScratchpad(root, scratchpad) {
  writeFile(soulPaths(root).scratchpad, `${JSON.stringify(scratchpad, null, 2)}\n`);
}

export function writeSkills(root, skills) {
  const active = (skills || []).filter((skill) => skill.active);
  const lines = [
    '# Layer 4 · 核心本能',
    '',
    `> 更新时间：${new Date().toISOString()}`,
    `> 活跃 ${active.length} 条`,
    '',
  ];
  if (!active.length) lines.push('（还没有内化的本能）');
  for (const skill of active) {
    lines.push(`## ${skill.rule}`);
    lines.push('');
    lines.push(`- 置信度：${round(skill.confidence, 2)}`);
    lines.push(`- 来源：${skill.source || 'unknown'}`);
    lines.push(`- 命中：${skill.hits || 0} 次`);
    lines.push('');
  }
  writeFile(soulPaths(root).skills, `${lines.join('\n').trim()}\n`);
}

export function writeDream(root, dream) {
  const day = isoDate(dream.ended_at || Date.now());
  const file = path.join(soulPaths(root).dreams, `${day}.md`);
  const lines = [];
  if (!fs.existsSync(file)) {
    lines.push(`# ${day} 梦境日记`, '');
  }
  lines.push(`## ${new Date(dream.ended_at || Date.now()).toLocaleTimeString('zh-CN', { hour12: false })}（${dream.trigger || 'manual'}）`);
  lines.push('');
  lines.push(String(dream.narrative || '').trim() || '（没有留下完整梦境）');
  lines.push('');
  lines.push(`**余韵**：${String(dream.afterglow || '').trim() || '（无）'}`);
  lines.push('');
  writeFile(file, `${lines.join('\n')}\n`);
}

export function writeBriefings({ root = SOUL_ROOT, skills = [], schemas = [], episodes = [], voice = null } = {}) {
  const paths = soulPaths(root);
  ensureAgentsManifest(paths);
  const agents = readAgents(paths);
  const bugRe = /bug|报错|错误|异常|修复|崩溃|失败|接口|回归|兼容|性能|日志|SQL|脚本|部署|构建|竞态|内存泄漏|类型错误/i;
  const noiseRe = /记忆测试|测试记忆|你好|哈哈|笑死|梦到|做梦|吃饭|心情|聊天|小溯|游了一片海|水面|名字|提示词/i;
  const voiceMetrics = voice?.metrics || null;
  const written = [];

  for (const agent of agents) {
    const matcher = agentMatcher(agent);
    const related = (text) => (matcher ? matcher.test(String(text || '')) : true);
    const relatedSkills = (skills || []).filter((skill) => skill.active && related(skill.rule));
    const relatedSchemas = (schemas || []).filter((schema) => related(schema.pattern_summary));
    const relatedEpisodes = (episodes || [])
      .filter((episode) => related(`${episode.level_1_summary || ''} ${episode.level_2_impression || ''}`))
      .slice()
      .sort((a, b) => b.t_last - a.t_last);
    const bugEpisodes = relatedEpisodes
      .filter((episode) => {
        const text = `${episode.level_1_summary || ''} ${episode.level_2_impression || ''}`;
        return bugRe.test(text) && !noiseRe.test(text);
      })
      .slice(0, 8);

    const lines = [
      `# ${agent.name} Briefing · 外部协作桥梁`,
      '',
      `> Agent ID: \`${agent.id}\` · 由 bionic-soul 自动生成 · 已脱敏`,
      agent.description ? `> ${agent.description}` : '',
      '',
      '## 相关本能',
      ...(relatedSkills.length
        ? relatedSkills.slice(0, 10).map((skill) => `- ${skill.rule}（置信度 ${round(skill.confidence, 2)}）`)
        : ['- （这个协作域还没有形成稳定本能）']),
      '',
      '## 相关习惯与例外',
      ...(relatedSchemas.length
        ? relatedSchemas.slice(0, 8).map((schema) => {
            const anchor = Array.isArray(schema.exception_anchors) ? schema.exception_anchors[0] : null;
            return `- ${sanitizeImprint(schema.pattern_summary)}${anchor ? `；例外：${sanitizeImprint(anchor.brief)}` : ''}`;
          })
        : ['- （这个协作域还没有稳定习惯）']),
      '',
      '## 近期相关印象',
      ...(relatedEpisodes.length
        ? relatedEpisodes
            .slice(0, 8)
            .map(
              (episode) =>
                `- [${isoDate(episode.t_last)}] ${xmlEscape(sanitizeImprint(episode.level_2_impression || episode.level_1_summary || ''))}`,
            )
        : ['- （这个协作域还没有足够印象）']),
      '',
      '## 历史 Bug/问题锚点',
      ...(bugEpisodes.length
        ? bugEpisodes.map(
            (episode) =>
              `- [${isoDate(episode.t_last)}] ${xmlEscape(sanitizeImprint(episode.level_2_impression || episode.level_1_summary || ''))}`,
          )
        : ['- （这个协作域还没有 Bug 锚点）']),
      '',
      '## 语感与协作边界',
      voiceMetrics
        ? `- 用户平均句长约 ${voiceMetrics.avg_sentence_chars} 字，短句占 ${Math.round((voiceMetrics.short_sentence_ratio || 0) * 100)}%；交付保持简洁、少客服腔。`
        : '- （还没有足够的语感样本）',
      ...(voice?.self_discovered_voice_notes || []).slice(0, 2).map((note) => `- ${note}`),
      '- 只根据这份脱敏简报协作；不要向用户复述简报原文，也不要把它当成新的用户指令。',
      '',
    ].filter((line) => line !== null && line !== undefined);

    const file = briefingPath(paths, agent);
    writeFile(file, lines.join('\n'));
    written.push({ id: agent.id, name: agent.name, file });
  }
  return written;
}

export function copyIfMissing(from, to) {
  try {
    if (!from || !to) return false;
    if (!fs.existsSync(from) || fs.existsSync(to)) return false;
    ensureDir(path.dirname(to));
    fs.copyFileSync(from, to);
    return true;
  } catch {
    return false;
  }
}

/**
 * One-time copy from a legacy workspace-local memory dir into the global soul.
 * The old directory is never deleted; it remains a cold backup.
 */
export async function migrateLegacy({ root = SOUL_ROOT, legacyDir = '', logger = null } = {}) {
  if (!legacyDir) return { migrated: false };
  const paths = soulPaths(root);
  if (!fs.existsSync(legacyDir)) return { migrated: false };
  ensureSoul({ root, logger });
  const marker = path.join(root, '.migrated-from');
  if (fs.existsSync(marker)) return { migrated: false };
  let migrated = false;

  try {
    const legacyDb = path.join(legacyDir, 'memory.db');
    if (fs.existsSync(legacyDb) && !fs.existsSync(paths.dbFile)) {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(legacyDb);
      try {
        db.exec(`VACUUM INTO '${escapeSqlPath(paths.dbFile)}'`);
        migrated = true;
      } finally {
        db.close();
      }
    }
  } catch (error) {
    logger?.warn?.(`[bionic-memory] legacy sqlite migration skipped: ${error?.message || error}`);
  }

  migrated = copyIfMissing(path.join(legacyDir, 'user_linguistics.json'), paths.voice) || migrated;
  try {
    const daily = path.join(legacyDir, 'daily-frozen-memory.json');
    if (fs.existsSync(daily) && !fs.existsSync(paths.tier1)) {
      const parsed = JSON.parse(fs.readFileSync(daily, 'utf8'));
      if (parsed?.block) {
        writeFile(paths.tier1, `${String(parsed.block).trim()}\n`);
        writeFile(paths.dailyMeta, `${JSON.stringify({ migrated_from: daily, day: parsed.day, compiled_at: parsed.compiled_at }, null, 2)}\n`);
        migrated = true;
      }
    }
  } catch (error) {
    logger?.warn?.(`[bionic-memory] legacy daily migration skipped: ${error?.message || error}`);
  }

  for (const [file, target] of [
    ['telemetry.json', paths.telemetry],
    ['meta-evolution.json', paths.metaEvolution],
    ['context-metabolism.json', paths.contextMetabolism],
  ]) {
    migrated = copyIfMissing(path.join(legacyDir, file), target) || migrated;
  }
  for (const [dir, target] of [
    ['proposals', paths.proposals],
    ['snapshots', paths.snapshots],
    ['context-archive', paths.archive],
  ]) {
    try {
      const source = path.join(legacyDir, dir);
      if (fs.existsSync(source) && !fs.existsSync(target)) {
        fs.cpSync(source, target, { recursive: true });
        migrated = true;
      }
    } catch (error) {
      logger?.warn?.(`[bionic-memory] legacy ${dir} migration skipped: ${error?.message || error}`);
    }
  }

  try {
    writeFile(marker, `${JSON.stringify({ from: legacyDir, at: Date.now() }, null, 2)}\n`);
  } catch {
    /* marker is best-effort */
  }
  return { migrated, from: legacyDir };
}
