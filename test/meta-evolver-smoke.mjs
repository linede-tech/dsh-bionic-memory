/**
 * Smoke test for the meta-evolution engine: telemetry, Tier 1 self-tuning,
 * Tier 2 prompt mutation, Tier 3 proposal generation/approval, snapshots,
 * dry-run rollback and trial-period rollback.
 *
 * Usage: node test/meta-evolver-smoke.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeConfig } from '../lib/config.js';
import { BionicMemoryEngine } from '../lib/engine.js';
import { openStore } from '../lib/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASE_PROMPT = fs.readFileSync(path.join(ROOT, 'prompt-template.md'), 'utf8');

let failures = 0;
function check(condition, message, extra) {
  if (condition) {
    console.log(`ok - ${message}`);
  } else {
    failures += 1;
    console.error(`FAIL - ${message}${extra === undefined ? '' : ` :: ${JSON.stringify(extra)}`}`);
  }
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function fakeSessions() {
  return {
    list: () => [{ id: 's1', header: { agentPreset: 'bionic-memory' } }],
    get: () => ({
      id: 's1',
      header: { agentPreset: 'bionic-memory' },
      deriveMessages: () => [],
    }),
  };
}

async function main() {
  const dataDir = path.join(ROOT, '.meta-evolver-data');
  const fixture = path.join(ROOT, '.meta-evolver-fixture');
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(fixture, { recursive: true, force: true });
  writeFile(
    path.join(fixture, 'package.json'),
    `${JSON.stringify({ name: '@local/meta-evolver-fixture', version: '0.0.1', private: true, type: 'module' }, null, 2)}\n`,
  );
  writeFile(path.join(fixture, 'test', 'ok.mjs'), "console.log('ok');\n");

  let now = Date.UTC(2026, 10, 12, 6, 0, 0);
  const clock = () => now;
  const advance = (ms) => {
    now += ms;
  };
  let reloads = 0;
  const reload = async () => {
    reloads += 1;
    return { ok: true };
  };

  const fakeLlm = {
    lastModel: 'fake/model',
    async generate({ system }) {
      if (String(system).includes('元认知编辑器')) {
        return JSON.stringify({
          guidance: [
            '当用户重复解释时，先复述你理解到的关键需求，再给答案；不要用空话收尾。',
            '不确定的记忆先说不确定，不要补全成确定的事实。',
          ],
          rationale: 'test',
        });
      }
      if (String(system).includes('元进化架构师')) {
        return JSON.stringify({
          summary: '增加一个轻量检索扩展',
          bottleneck: '记忆效用偏低且上下文偏重',
          risk: 'low',
          files: [
            {
              path: 'lib/proposal.js',
              language: 'js',
              content: 'export const metaProposal = true;\nexport function describe() { return "meta proposal"; }\n',
            },
          ],
          tests: ['test/ok.mjs'],
          rationale: 'test proposal',
        });
      }
      return '';
    },
  };

  const config = normalizeConfig({
    llmEnabled: true,
    fallibilityEnabled: false,
    metaEvolutionEnabled: true,
    contextCharBudget: 3000,
  });
  const store = await openStore({ dir: dataDir });
  const engine = new BionicMemoryEngine({
    store,
    config,
    clock,
    dataDir,
    llm: fakeLlm,
    sessions: fakeSessions(),
    packageDir: fixture,
    basePrompt: BASE_PROMPT,
    pluginReload: reload,
    random: () => 0.5,
  });
  engine.init();
  const meta = engine.metaEvolver;
  check(Boolean(meta), 'meta-evolver attached to the engine');
  check(fs.existsSync(meta.telemetryFile), 'telemetry file created');
  check(fs.existsSync(meta.evolutionFile), 'evolution file created');

  const observe = ({ user, assistant, injection }) => {
    meta.observeTurn({
      session_id: 's1',
      turn: 1,
      user_text: user,
      assistant_text: assistant,
      now,
      injection: injection ? { at: now, ...injection } : null,
    });
  };

  observe({
    user: '海边书店真不错',
    assistant: '你说的海边书店，我也记得。',
    injection: {
      contextChars: 120,
      snippets: [{ id: 'ep1', text: '海边书店', keywords: ['海边', '书店'] }],
      dreamResidue: false,
      habitCount: 0,
      distortionType: '',
      fallibilityAnchor: false,
    },
  });
  for (let index = 0; index < 3; index += 1) {
    observe({
      user: '嗯',
      assistant: '好。',
      injection: {
        contextChars: 200,
        snippets: [{ id: `ep${index + 2}`, text: '一段无关旧事', keywords: ['无关', '旧事'] }],
        dreamResidue: false,
        habitCount: 0,
        distortionType: '',
        fallibilityAnchor: false,
      },
    });
  }
  observe({ user: '你记错了，我说过很多次了', assistant: '抱歉。', injection: null });
  observe({
    user: '太好了，你还记得',
    assistant: '那当然，我也有点恍惚。',
    injection: {
      contextChars: 100,
      snippets: [{ id: 'dreamx', text: '梦里的走廊', keywords: ['走廊'] }],
      dreamResidue: true,
      habitCount: 0,
      distortionType: '',
      fallibilityAnchor: false,
    },
  });

  const day = meta.metricsForDay();
  check(day.turns === 6, 'telemetry counts turns', day.turns);
  check(day.injected === 5, 'telemetry counts injected memories', day.injected);
  check(day.referenced === 1, 'telemetry counts referenced memories', day.referenced);
  check(day.memory_utility_rate === 0.2, 'memory utility rate computed', day.memory_utility_rate);
  check(day.user_friction_count === 2, 'user friction count computed', day.user_friction_count);
  check(day.resonance_score > 0, 'resonance score computed', day.resonance_score);
  check(day.token_overhead > 0.5, 'token overhead computed', day.token_overhead);
  check(fs.existsSync(meta.telemetryFile), 'telemetry persisted');

  console.log('\n# Tier 1 self-tuning + trial');
  const tier1 = await meta.tuneHomeostasis({ force: true });
  check(tier1.changed === true, 'Tier 1 changed parameters', tier1);
  const t1Trial = tier1.trial;
  check(t1Trial?.status === 'trial', 'Tier 1 entered a trial');
  check(
    meta.config.s0Multiplier > 1 && meta.config.s0Multiplier <= 1.15,
    'effective S0 raised within 15%',
    meta.config.s0Multiplier,
  );
  check(meta.config.defaultS0 === 48, 'base S0 stays explicit while the multiplier changes', meta.config.defaultS0);
  check(meta.config.fallibilityChanceMin < 0.15, 'confusion rate lowered', meta.config.fallibilityChanceMin);
  check(meta.config.similarityThreshold > 0, 'retrieval similarity threshold tightened', meta.config.similarityThreshold);
  check(meta.config.contextCharBudget < 3000, 'context budget tightened', meta.config.contextCharBudget);
  check(fs.existsSync(meta.configFile), 'config.json written');
  check(fs.existsSync(path.join(meta.dataDir, '.git')), 'git snapshot repo created in evolution_lab');
  check(Boolean(t1Trial?.snapshot?.git), 'Tier 1 recorded a git snapshot', t1Trial?.snapshot);

  // A worsened trial: two friction turns within the 3-day window.
  advance(86400000);
  observe({ user: '你又忘了，我说过很多次', assistant: '抱歉。', injection: null });
  advance(86400000);
  observe({ user: '你记错了，不对', assistant: '抱歉。', injection: null });
  advance(2 * 86400000);
  const trials = await meta.checkTrials();
  check(trials.length >= 1, 'trial checked at the next sleep');
  check(t1Trial.status === 'rolled_back', 'worsened Tier 1 trial rolled back', t1Trial.status);
  check(meta.config.s0Multiplier === 1, 'effective S0 multiplier restored after trial rollback', meta.config.s0Multiplier);
  check(meta.config.similarityThreshold === 0, 'similarity threshold restored');
  check(meta.config.contextCharBudget === 3000, 'context budget restored');
  check(Boolean(meta.evolution.last_nightmare), 'rollback recorded a nightmare note');

  console.log('\n# Tier 2 prompt mutation + trial');
  const tier2 = await meta.mutatePrompt({ force: true });
  check(tier2.changed === true, 'Tier 2 mutated the prompt', tier2);
  const t2Trial = tier2.trial;
  check(t2Trial?.status === 'trial', 'Tier 2 entered a trial');
  check(meta.activePrompt().includes('<evolved_expression_guidance'), 'evolved guidance block injected');
  check(meta.activePrompt().includes('当用户重复解释时'), 'LLM guidance appears in the active prompt');
  check(meta.activePrompt().includes('记忆来源防伪'), 'core source-safety rule preserved');
  check(meta.activePrompt().includes('安全豁免红线'), 'core immunity rule preserved');
  check(fs.existsSync(meta.promptFile), 'working prompt-template.md written');

  advance(86400000);
  observe({ user: '你记错了，说了多少遍', assistant: '抱歉。', injection: null });
  advance(86400000);
  observe({ user: '怎么又忘了，烦', assistant: '抱歉。', injection: null });
  advance(2 * 86400000);
  await meta.checkTrials();
  check(t2Trial.status === 'rolled_back', 'worsened Tier 2 trial rolled back', t2Trial.status);
  check(!meta.activePrompt().includes('<evolved_expression_guidance'), 'working prompt restored after trial rollback');
  check(meta.evolution.prompt_version === 0, 'prompt version restored');

  console.log('\n# Tier 3 proposal, approval, dry-run and rollback');
  const tier3 = await meta.proposeArchitecture({ force: true });
  check(tier3.changed === true, 'Tier 3 generated a proposal', tier3);
  const proposal = tier3.proposal;
  check(Boolean(proposal?.id), 'proposal has an id');
  check(fs.existsSync(path.join(tier3.dir, 'manifest.json')), 'proposal manifest written');
  check(fs.existsSync(path.join(tier3.dir, 'files', 'lib', 'proposal.js')), 'proposal file stored');

  const approved = await meta.approveProposal(proposal.id);
  check(approved.ok === true, 'proposal approved and applied', approved);
  check(fs.existsSync(path.join(fixture, 'lib', 'proposal.js')), 'proposal file copied into the package');
  const fixturePkg = JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'), 'utf8'));
  check(fixturePkg.version === '0.0.2', 'package version bumped for reload', fixturePkg.version);
  check(reloads === 1, 'plugin reload requested once', reloads);
  check(fs.existsSync(meta.pendingApplyFile), 'pending-apply sentinel written');

  const boot = await meta.finishPendingApply();
  check(boot?.ok === true, 'boot dry-run accepted the applied code', boot);
  check(!fs.existsSync(meta.pendingApplyFile), 'pending-apply sentinel removed after boot check');
  const t3Record = meta.evolution.history.find((record) => record.proposal_id === proposal.id);
  check(t3Record?.status === 'trial', 'approved code entered trial', t3Record?.status);

  const bad = {
    id: 'proposal-bad',
    at: now,
    summary: 'bad syntax proposal',
    bottleneck: 'test',
    risk: 'low',
    files: [{ path: 'lib/bad.js', language: 'js', content: 'export const = ;\n' }],
    tests: [],
    rationale: '',
  };
  const badDir = meta.writeProposal(bad);
  meta.evolution.pending_proposals.unshift({
    id: bad.id,
    at: now,
    summary: bad.summary,
    bottleneck: bad.bottleneck,
    risk: bad.risk,
    dir: badDir,
    files: [bad.files[0].path],
  });
  meta.saveEvolution();
  const badResult = await meta.approveProposal(bad.id);
  check(badResult.ok === false, 'syntax-error proposal rejected');
  check(!fs.existsSync(path.join(fixture, 'lib', 'bad.js')), 'failed proposal source was rolled back');
  check(
    String(meta.evolution.last_nightmare?.text || '').includes('代码提案')
      || String(meta.evolution.last_nightmare?.text || '').includes('干跑'),
    'failed apply recorded as a nightmare',
    meta.evolution.last_nightmare,
  );

  const rollback = await meta.rollbackLast();
  check(rollback.ok === true, 'manual rollback succeeded', rollback);
  check(!fs.existsSync(path.join(fixture, 'lib', 'proposal.js')), 'rolled-back proposal file removed');
  const restoredPkg = JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'), 'utf8'));
  check(restoredPkg.version === '0.0.1', 'package version restored on rollback', restoredPkg.version);
  check(reloads >= 2, 'rollback requested reload', reloads);

  const statusText = meta.statusText();
  check(statusText.includes('元认知进化引擎'), 'status text shaped');
  check(statusText.includes('similarity_threshold'), 'status exposes similarity_threshold');
  const context = meta.contextLines();
  check(Array.isArray(context) && context.some((line) => line.includes('<meta_evolution>')), 'meta evolution context block rendered');

  engine.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(fixture, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failed assertion(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('META EVOLVER SMOKE ERROR', error?.stack || error);
  process.exitCode = 1;
});
