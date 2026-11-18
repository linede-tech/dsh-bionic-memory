/**
 * Smoke test for the visual identity: default assets, config, mood mapping,
 * image resolution and avatar replacement. Cleans up its temporary data.
 *
 * Usage: node test/visual-smoke.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  companionPrompt,
  ensureVisualAssets,
  identityFor,
  initializeCompanion,
  moodFromState,
  readVisualConfig,
  setVisualAvatar,
} from '../lib/visual.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, '.visual-data');
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z2ioAAAAASUVORK5CYII=';

let failures = 0;
function check(condition, message, extra) {
  if (condition) console.log(`ok - ${message}`);
  else {
    failures += 1;
    console.error(`FAIL - ${message}${extra === undefined ? '' : ` :: ${JSON.stringify(extra)}`}`);
  }
}

async function main() {
  fs.rmSync(DATA, { recursive: true, force: true });
  const paths = ensureVisualAssets(DATA);
  check(fs.existsSync(paths.avatar), 'default avatar.png is created');
  check(fs.existsSync(paths.config), 'config.json is created');
  const config = readVisualConfig(DATA);
  check(config.initialized === false, 'default identity is not initialized');
  check(config.name === '', 'default display name is empty (no preset role)');
  check(config.avatar === 'assets/avatar.png', 'default avatar path is assets/avatar.png');
  check(companionPrompt(config).includes('<companion_setup>'), 'uninitialized prompt contains first-run setup');

  const calm = identityFor(DATA, { scratchpad: { mood: { label: '平静', valence: 0.1, arousal: 0.5 } } });
  check(calm.enabled === true, 'identity is enabled');
  check(calm.initialized === false, 'identity reports uninitialized');
  check(calm.name === '', 'identity has no preset display name');
  check(String(calm.avatar).startsWith('data:image/png;base64,'), 'main avatar resolves to a PNG data URI');
  check(calm.mood === 'calm' && calm.glow === 'calm', 'calm mood/glow is selected');

  check(moodFromState({ scratchpad: { mood: { label: '开心', valence: 0.8, arousal: 0.6 } } }).mood === 'happy', 'happy mood is detected');
  check(moodFromState({ scratchpad: { mood: { label: '困倦', valence: 0, arousal: 0.2 } } }).mood === 'sleepy', 'sleepy mood is detected');
  check(moodFromState({ scratchpad: { curiosity_hooks: [{ resolved: false }] } }).mood === 'curious', 'curiosity makes the mood curious');
  check(moodFromState({ scratchpad: { visual_status: 'monitoring' } }).mood === 'monitoring', 'monitoring status is detected');

  fs.writeFileSync(path.join(DATA, 'assets', 'avatar_happy.png'), Buffer.from(PIXEL.split(',')[1], 'base64'));
  const happy = identityFor(DATA, { scratchpad: { mood: { label: '开心', valence: 0.8, arousal: 0.6 } } });
  check(happy.mood === 'happy', 'identity mood is happy');
  check(Boolean(happy.moods.happy), 'mood-specific avatar file is discovered');
  check(String(happy.moods.happy).startsWith('data:image/png;base64,'), 'mood avatar resolves to a data URI');

  const initialized = await initializeCompanion(DATA, {
    name: '阿溯',
    user_name: '阿岚',
    relationship: '搭档',
    tone: '温和、直接',
  });
  check(initialized.ok === true, 'initializeCompanion succeeds with a user-provided name');
  const afterInit = readVisualConfig(DATA);
  check(afterInit.initialized === true, 'initialized flag is persisted');
  check(afterInit.name === '阿溯', 'user-provided name is persisted');
  check(afterInit.user_name === '阿岚', 'user-provided form of address is persisted');
  check(afterInit.relationship === '搭档', 'user-provided relationship is persisted');
  const initializedIdentity = identityFor(DATA, { scratchpad: {} });
  check(initializedIdentity.name === '阿溯', 'identity now carries the initialized name');
  check(companionPrompt(afterInit).includes('<companion_identity>'), 'initialized prompt contains identity block');

  const replaced = await setVisualAvatar(DATA, PIXEL, { name: '阿溯' });
  check(replaced.ok === true, 'setVisualAvatar accepts a data URI');
  const after = readVisualConfig(DATA);
  check(after.name === '阿溯', 'name remains after avatar replacement');
  check(after.avatar === 'assets/avatar.png', 'new avatar path is persisted');
  check(fs.statSync(path.join(DATA, 'assets', 'avatar.png')).size > 0, 'new avatar bytes are written');
  check(fs.readdirSync(path.join(DATA, 'assets')).some((name) => name.startsWith('avatar.previous-')), 'previous avatar is backed up');

  const missing = await setVisualAvatar(DATA, path.join(DATA, 'nope.png'));
  check(missing.ok === false, 'missing local image is rejected');

  // A config from the preset-role era must not leak its old name back in, and
  // startup must not rewrite the existing file.
  fs.writeFileSync(
    path.join(DATA, 'config.json'),
    JSON.stringify({ name: '小溯', avatar: 'assets/avatar.png', moods: {} }),
    'utf8',
  );
  const legacyFile = fs.readFileSync(path.join(DATA, 'config.json'), 'utf8');
  const legacy = readVisualConfig(DATA);
  check(legacy.initialized === false && legacy.name === '', 'legacy preset name is read as uninitialized/empty');
  check(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8') === legacyFile, 'startup leaves an existing legacy config untouched');

  fs.writeFileSync(
    path.join(DATA, 'config.json'),
    JSON.stringify({ name: '阿岚', avatar: 'assets/avatar.png', moods: {} }),
    'utf8',
  );
  const customLegacy = readVisualConfig(DATA);
  check(customLegacy.initialized === true && customLegacy.name === '阿岚', 'custom legacy name is treated as initialized in memory');
  check(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8').includes('阿岚'), 'startup leaves a custom legacy config untouched');

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
  try {
    fs.rmSync(DATA, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
