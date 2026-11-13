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
 *     orchestrator/zcode_briefing.md
 *     orchestrator/workbuddy_briefing.md
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
    zcode: path.join(orchestrator, 'zcode_briefing.md'),
    workbuddy: path.join(orchestrator, 'workbuddy_briefing.md'),
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

export function ensureSoul({ root = SOUL_ROOT, tier0Source = '', logger = null } = {}) {
  const paths = soulPaths(root);
  for (const dir of [
    paths.root,
    paths.cortex,
    paths.soul,
    paths.cache,
    paths.orchestrator,
    paths.evolution,
    paths.dreams,
    paths.proposals,
    paths.snapshots,
  ]) {
    ensureDir(dir);
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
  const codeRe = /代码|插件|函数|接口|API|bug|报错|错误|修复|测试|重构|部署|SQL|脚本|架构|性能|权限|日志|版本|编译|运行时|提示词|人格|名字|prompt/i;
  const docRe = /文档|办公|表格|PPT|Word|Excel|演示|排版|写作|审美|汇报|纪要|知识库|邮件/i;
  const bugRe = /bug|报错|错误|异常|修复|崩溃|失败|接口|回归|兼容|性能|日志|SQL|脚本|部署|构建|竞态|内存泄漏|类型错误/i;
  const noiseRe = /记忆测试|测试记忆|你好|哈哈|笑死|梦到|做梦|吃饭|心情|聊天|小溯|游了一片海|水面|名字|提示词/i;

  const codeSkills = (skills || []).filter((skill) => skill.active && codeRe.test(String(skill.rule)));
  const docSkills = (skills || []).filter((skill) => skill.active && docRe.test(String(skill.rule)));
  const codeSchemas = (schemas || []).filter((schema) => codeRe.test(String(schema.pattern_summary)));
  const docSchemas = (schemas || []).filter((schema) => docRe.test(String(schema.pattern_summary)));
  const bugEpisodes = (episodes || [])
    .filter((episode) => {
      const text = `${episode.level_1_summary || ''} ${episode.level_2_impression || ''}`;
      return bugRe.test(text) && !noiseRe.test(text);
    })
    .slice()
    .sort((a, b) => b.t_last - a.t_last)
    .slice(0, 8);
  const docEpisodes = (episodes || [])
    .filter((episode) => {
      const text = `${episode.level_1_summary || ''} ${episode.level_2_impression || ''}`;
      return docRe.test(text) && !noiseRe.test(text);
    })
    .slice()
    .sort((a, b) => b.t_last - a.t_last)
    .slice(0, 8);
  const voiceMetrics = voice?.metrics || null;

  const zcode = [
    '# ZCode Briefing · 脱敏研发简报',
    '',
    '> 由 bionic-soul 自动生成。只含习惯、本能与模糊印象，不含原始私人对话。',
    '',
    '## 研发本能',
    ...(codeSkills.length
      ? codeSkills.slice(0, 10).map((skill) => `- ${skill.rule}（置信度 ${round(skill.confidence, 2)}）`)
      : ['- （还没有形成稳定的研发本能）']),
    '',
    '## 历史 Bug 锚点',
    ...(bugEpisodes.length
      ? bugEpisodes.map(
          (episode) =>
            `- [${isoDate(episode.t_last)}] ${xmlEscape(sanitizeImprint(episode.level_2_impression || episode.level_1_summary || ''))}`,
        )
      : ['- （还没有记录到 Bug 锚点）']),
    '',
    '## 代码习惯与例外',
    ...(codeSchemas.length
      ? codeSchemas.slice(0, 8).map((schema) => {
          const anchor = Array.isArray(schema.exception_anchors) ? schema.exception_anchors[0] : null;
          return `- ${sanitizeImprint(schema.pattern_summary)}${anchor ? `；例外：${sanitizeImprint(anchor.brief)}` : ''}`;
        })
      : ['- （还没有足够稳定的代码习惯）']),
    '',
  ].join('\n');

  const workbuddy = [
    '# WorkBuddy Briefing · 脱敏办公简报',
    '',
    '> 由 bionic-soul 自动生成。只含习惯、审美与模糊印象，不含原始私人对话。',
    '',
    '## 文档审美与办公习惯',
    ...(docSkills.length
      ? docSkills.slice(0, 10).map((skill) => `- ${skill.rule}（置信度 ${round(skill.confidence, 2)}）`)
      : ['- （还没有形成稳定的办公本能）']),
    '',
    '## 常用格式与例外',
    ...(docSchemas.length
      ? docSchemas.slice(0, 8).map((schema) => {
          const anchor = Array.isArray(schema.exception_anchors) ? schema.exception_anchors[0] : null;
          return `- ${sanitizeImprint(schema.pattern_summary)}${anchor ? `；例外：${sanitizeImprint(anchor.brief)}` : ''}`;
        })
      : ['- （还没有足够稳定的办公习惯）']),
    '',
    '## 近期文档类印象',
    ...(docEpisodes.length
      ? docEpisodes.map(
          (episode) =>
            `- [${isoDate(episode.t_last)}] ${xmlEscape(sanitizeImprint(episode.level_2_impression || episode.level_1_summary || ''))}`,
        )
      : ['- （还没有文档类记忆）']),
    '',
    '## 语感提醒',
    voiceMetrics
      ? `- 用户平均句长约 ${voiceMetrics.avg_sentence_chars} 字，短句占 ${Math.round((voiceMetrics.short_sentence_ratio || 0) * 100)}%；文档交付保持简洁、少客服腔。`
      : '- （还没有足够的语感样本）',
    ...(voice?.self_discovered_voice_notes || []).slice(0, 2).map((note) => `- ${note}`),
    '',
  ].join('\n');

  writeFile(paths.zcode, zcode);
  writeFile(paths.workbuddy, workbuddy);
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
