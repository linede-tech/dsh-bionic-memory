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
  ensureVisualAssets,
  identityFor,
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
  check(config.name === '小溯', 'default display name is 小溯');
  check(config.avatar === 'assets/avatar.png', 'default avatar path is assets/avatar.png');

  const calm = identityFor(DATA, { scratchpad: { mood: { label: '平静', valence: 0.1, arousal: 0.5 } } });
  check(calm.enabled === true, 'identity is enabled');
  check(calm.name === '小溯', 'identity carries the display name');
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

  const replaced = await setVisualAvatar(DATA, PIXEL, { name: '阿溯' });
  check(replaced.ok === true, 'setVisualAvatar accepts a data URI');
  check(replaced.name === '阿溯', 'setVisualAvatar updates the display name');
  const after = readVisualConfig(DATA);
  check(after.name === '阿溯', 'new name is persisted');
  check(after.avatar === 'assets/avatar.png', 'new avatar path is persisted');
  check(fs.statSync(path.join(DATA, 'assets', 'avatar.png')).size > 0, 'new avatar bytes are written');
  check(fs.readdirSync(path.join(DATA, 'assets')).some((name) => name.startsWith('avatar.previous-')), 'previous avatar is backed up');

  const missing = await setVisualAvatar(DATA, path.join(DATA, 'nope.png'));
  check(missing.ok === false, 'missing local image is rejected');

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
