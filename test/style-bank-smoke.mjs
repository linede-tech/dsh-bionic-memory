/**
 * Smoke test for the few-shot natural-voice architecture:
 * Tier 0 style rules, positive-feedback capture, user teaching, /style manual
 * saves, ranking/dedupe, the daily Tier 1 <learned_natural_voice_examples>
 * block, and persistence of style_bank.json.
 *
 * Usage: node test/style-bank-smoke.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeConfig } from '../lib/config.js';
import { BionicMemoryEngine } from '../lib/engine.js';
import { openStore } from '../lib/store.js';
import { StyleBank } from '../lib/style-bank.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, '.style-bank-data');
const PROMPT = fs.readFileSync(path.join(ROOT, 'prompt-template.md'), 'utf8');

let failures = 0;
function check(condition, message, extra) {
  if (condition) console.log(`ok - ${message}`);
  else {
    failures += 1;
    console.error(`FAIL - ${message}${extra === undefined ? '' : ` :: ${JSON.stringify(extra)}`}`);
  }
}

async function main() {
  // ---------------------------------------------------------- Tier 0 prompt
  check(PROMPT.includes('<style_imitation_and_voice_rules>'), 'Tier 0 carries the style imitation block');
  check(PROMPT.includes('</style_imitation_and_voice_rules>'), 'style imitation block is closed');
  check(PROMPT.includes('❌ [生硬AI味]'), 'negative examples are present');
  check(PROMPT.includes('✅ [自然活人感]'), 'positive examples are present');
  check(PROMPT.includes('深海大肥鱼'), 'TOT correction example is present');
  check(PROMPT.includes('ZCode') && PROMPT.includes('WorkBuddy'), 'delegation example is present');
  check(PROMPT.includes('<hard_style_constraints>'), 'hard style constraints are present');
  for (const banned of ['首先', '其次', '总而言之', '总的来说', '有什么帮您', '我理解你的感受', '加粗小标题']) {
    check(PROMPT.includes(banned), `hard constraint mentions ${banned}`);
  }
  check(PROMPT.length <= 16000, 'prompt stays inside meta-evolver validation bounds', PROMPT.length);

  fs.rmSync(DATA, { recursive: true, force: true });
  let now = Date.UTC(2026, 10, 12, 6, 0, 0);
  const clock = () => now;
  const config = normalizeConfig({
    llmEnabled: false,
    fallibilityEnabled: false,
    metaEvolutionEnabled: false,
    contextMetabolismEnabled: false,
    styleBankEnabled: true,
    styleBankTop: 5,
    styleBankManualWeight: 10,
    styleBankFeedbackWeight: 3,
    styleBankContinuationWeight: 1.5,
  });
  const store = await openStore({ dir: DATA });
  const engine = new BionicMemoryEngine({
    store,
    config,
    clock,
    dataDir: DATA,
    basePrompt: PROMPT,
    random: () => 0.5,
  });
  engine.init();
  const bank = engine.styleBank;
  check(Boolean(bank), 'style bank attached to the engine');
  check(fs.existsSync(path.join(DATA, 'style_bank.json')), 'style_bank.json created');
  check(bank.state().count === 0, 'bank starts empty');
  check(engine.state('s1').style_bank?.count === 0, 'engine state exposes the empty bank');

  // ------------------------------------------------ positive feedback capture
  await engine.ingestTurn({
    session_id: 's1',
    turn: 1,
    user_text: '今天改了一天底层接口，累死我了，刚点了份烧烤。',
    assistant_text:
      '不是吧，这都几点了还炫烧烤？我怎么隐约记着……好像就前阵子，也有一回你半夜嘴馋点了个超辣的什么东西，第二天直接蔫儿了半天？算了算了，累一天了先吃吧，少吃点凉的啊。',
  });
  check(bank.entries.length === 0, 'ordinary turn is not captured on its own');
  await engine.ingestTurn({
    session_id: 's1',
    turn: 2,
    user_text: '哈哈哈哈哈，太懂我了，你也太可爱了',
    assistant_text: '害，谁让你老是这样，我还能怎么办呢。',
  });
  check(bank.entries.length === 1, 'positive feedback captures the previous dialogue pair');
  const positive = bank.entries[0];
  check(positive.source === 'feedback', 'positive pair marked as feedback', positive.source);
  check(positive.weight === config.styleBankFeedbackWeight, 'positive pair uses the feedback weight', positive.weight);
  check(positive.user.includes('烧烤'), 'positive pair keeps the previous user turn');
  check(positive.assistant.includes('不是吧'), 'positive pair keeps the praised assistant turn');
  check(
    engine.store.listJournal(now - 86400000, 50).some((entry) => entry.kind === 'style_capture'),
    'style capture is journaled',
  );

  // --------------------------------------------- dense continuation capture
  await engine.ingestTurn({
    session_id: 's1',
    turn: 3,
    user_text:
      '然后呢，而且我跟你说，昨天我也遇到差不多的事，结果折腾到半夜，后来发现是配置写反了，你说离谱不离谱。',
    assistant_text: '啧，这种事真的会让人半夜怀疑人生。',
  });
  const continuation = bank.entries.find((entry) => entry.source === 'continuation');
  check(Boolean(continuation), 'dense continuation captures the previous pair');
  check(continuation.weight === config.styleBankContinuationWeight, 'continuation uses its own weight');

  // ----------------------------------------------------- teaching capture
  await engine.ingestTurn({
    session_id: 's1',
    turn: 4,
    user_text: '你应该这么说：行吧行吧，我先去给你倒杯水，你别急，慢慢说。',
    assistant_text: '记住了，下次我就这么回。',
  });
  const taught = bank.entries.find((entry) => entry.source === 'user_taught');
  check(Boolean(taught), 'explicit teaching is captured');
  check(taught.weight === config.styleBankManualWeight, 'teaching gets the highest weight');
  check(taught.assistant.includes('倒杯水'), 'teaching keeps the demonstrated reply');

  // --------------------------------------------------------- /style save
  const saved = engine.saveStyleExample({
    session_id: 's1',
    assistant_text: '啧，又熬夜。先睡，剩下的明早再说，天塌不下来。',
  });
  check(saved.ok, '/style save writes a manual example', saved.error);
  check(saved.entry.source === 'manual', 'manual example is marked manual');
  check(saved.entry.weight === config.styleBankManualWeight, 'manual example gets the highest weight');
  check(saved.entry.user.length > 0, 'manual example inherits the previous user context');
  check(bank.entries.length === 4, 'bank has four examples after teaching and manual save');

  for (let index = 0; index < 3; index += 1) {
    engine.saveStyleExample({
      session_id: 's1',
      assistant_text: `害，第${index + 1}条熬夜示范，先别急着把话说死，明早再看。`,
    });
  }
  check(bank.entries.length === 7, 'bank accepts more manual examples');
  const top = bank.top(5);
  check(top.length === 5, 'top five are selected');
  check(top.every((entry) => entry.weight === config.styleBankManualWeight), 'manual examples dominate the top five');
  check(top.some((entry) => entry.source === 'user_taught'), 'teaching stays in the daily top five');

  // --------------------------------------------- daily Tier 1 frozen block
  const block = engine.compileDailyFrozenMemory({ reason: 'test' });
  check(block.includes('<learned_natural_voice_examples>'), 'daily block carries learned voice examples');
  check(block.includes('</learned_natural_voice_examples>'), 'learned voice block is closed');
  check((block.match(/<example /g) || []).length === 5, 'daily block freezes exactly five examples');
  check(block.includes('倒杯水'), 'daily block includes the taught example');
  check(block.includes('先睡'), 'daily block includes the manual example');
  check(engine.dailyFrozenBlock() === block, 'daily block is the Tier 1 section text');
  check(engine.state('s1').style_bank?.top?.length === 5, 'engine state exposes the top five');

  const secondBlock = engine.compileDailyFrozenMemory({ reason: 'test-again' });
  check(secondBlock === block, 'recompiling without new data is byte-identical');

  // ----------------------------------------------------------- dedupe / cap
  const before = bank.entries.length;
  const duplicate = bank.record({
    user: top[0].user,
    assistant: top[0].assistant,
    weight: 1,
    source: 'feedback',
  });
  check(bank.entries.length === before, 'duplicate pair does not create a second entry');
  check(duplicate.weight >= config.styleBankManualWeight, 'manual weight survives a lower-weight duplicate');
  check(bank.record({ user: 'a', assistant: 'short' }) === null, 'too-short pair is rejected');
  check(bank.record({ user: 'a', assistant: '```js\nconst x = 1;\n```' }) === null, 'code block is rejected');

  // ---------------------------------------------------------- persistence
  const reloaded = new StyleBank({ dataDir: DATA, config, clock });
  reloaded.init();
  check(reloaded.entries.length === bank.entries.length, 'style bank reloads from style_bank.json');
  check(reloaded.top(5).length === 5, 'top five survive reload');
  reloaded.close();

  engine.close();
  fs.rmSync(DATA, { recursive: true, force: true });

  if (failures) {
    console.error(`\nFAIL: ${failures} failed assertion(s)`);
    process.exitCode = 1;
  } else {
    console.log('\nPASS: 0 failed assertion(s)');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
