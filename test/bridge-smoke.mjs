/**
 * Smoke test for the generic external-agent bridge:
 * agents.json registry, arbitrary agent ids, per-agent briefing paths,
 * dynamic keyword filtering, and removal of the old hardcoded zcode/workbuddy
 * root briefings.
 *
 * Usage: node test/bridge-smoke.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureSoul, soulPaths, writeBriefings } from '../lib/soul-storage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, '.bridge-data');

let failures = 0;
function check(condition, message, extra) {
  if (condition) console.log(`ok - ${message}`);
  else {
    failures += 1;
    console.error(`FAIL - ${message}${extra === undefined ? '' : ` :: ${JSON.stringify(extra)}`}`);
  }
}

function main() {
  fs.rmSync(DATA, { recursive: true, force: true });
  const paths = ensureSoul({ root: DATA, tier0Source: '<tier0_static_dna/>' });

  check(fs.existsSync(paths.agents), 'agents.json created');
  check(fs.existsSync(paths.orchestratorReadme), 'orchestrator/README.md created');
  check(fs.existsSync(paths.briefings), 'briefings/ directory created');
  check(fs.readFileSync(paths.tier0, 'utf8').includes('tier0_static_dna'), 'tier0 written');
  check(fs.existsSync(path.join(DATA, '.git')), 'soul git initialized');

  const manifest = JSON.parse(fs.readFileSync(paths.agents, 'utf8'));
  check(Array.isArray(manifest.agents), 'manifest has an agents array');
  check(manifest.agents.some((agent) => agent.id === 'zcode'), 'zcode is only a default example');
  check(manifest.agents.some((agent) => agent.id === 'workbuddy'), 'workbuddy is only a default example');

  manifest.agents.push({
    id: 'my-agent',
    name: 'My Agent',
    description: '一个完全自定义的外部协作 agent',
    keywords: ['接口', 'bug', '部署'],
    briefing: 'briefings/my-agent.md',
  });
  fs.writeFileSync(paths.agents, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const written = writeBriefings({
    root: DATA,
    skills: [
      { active: true, rule: '当接口出现 bug 时，先复现再改代码，不要猜。', confidence: 0.91, source: 'test' },
    ],
    schemas: [
      {
        pattern_summary: '每次部署前先跑一遍接口回归',
        exception_anchors: [{ date: '2026-11-13', brief: '那次跳过了回归，结果回滚。' }],
      },
    ],
    episodes: [
      {
        level_1_summary: '修复接口 bug 并完成部署',
        level_2_impression: '那次接口报错，先复现再修，最后部署通过。',
        t_last: Date.now(),
      },
      {
        level_1_summary: '记忆测试',
        level_2_impression: '你好呀，进行记忆测试。',
        t_last: Date.now(),
      },
    ],
    voice: {
      metrics: { avg_sentence_chars: 9, short_sentence_ratio: 0.6 },
      self_discovered_voice_notes: ['短句接话时更顺。'],
    },
  });

  check(Array.isArray(written) && written.length >= 3, 'writeBriefings returns every registered agent', written);
  check(written.some((entry) => entry.id === 'my-agent'), 'custom agent is written');
  const customFile = path.join(paths.orchestrator, 'briefings', 'my-agent.md');
  check(fs.existsSync(customFile), 'custom briefing file exists at its declared path');
  const custom = fs.readFileSync(customFile, 'utf8');
  check(custom.includes('My Agent Briefing'), 'custom briefing uses the agent name, not a hardcoded role');
  check(custom.includes('接口出现 bug'), 'custom briefing includes keyword-matched instincts');
  check(!custom.includes('记忆测试'), 'noise episode is filtered out of the bridge');
  check(custom.includes('语感与协作边界'), 'bridge carries voice/collaboration boundary');

  check(fs.existsSync(path.join(paths.orchestrator, 'briefings', 'zcode.md')), 'zcode example briefing exists');
  check(fs.existsSync(path.join(paths.orchestrator, 'briefings', 'workbuddy.md')), 'workbuddy example briefing exists');
  check(!fs.existsSync(path.join(paths.orchestrator, 'zcode_briefing.md')), 'old hardcoded zcode root file removed');
  check(!fs.existsSync(path.join(paths.orchestrator, 'workbuddy_briefing.md')), 'old hardcoded workbuddy root file removed');

  const readme = fs.readFileSync(paths.orchestratorReadme, 'utf8');
  check(readme.includes('agents.json'), 'bridge README documents the registry');
  check(readme.toLowerCase().includes('not a fixed'), 'bridge README says the examples are not fixed');

  fs.rmSync(DATA, { recursive: true, force: true });

  if (failures) {
    console.error(`\nFAIL: ${failures} failed assertion(s)`);
    process.exitCode = 1;
  } else {
    console.log('\nPASS: 0 failed assertion(s)');
  }
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
