/**
 * Visual identity for the bionic persona.
 *
 *   ~/.dsh/bionic-soul/config.json
 *   ~/.dsh/bionic-soul/assets/avatar.png
 *   ~/.dsh/bionic-soul/assets/avatar_happy.png
 *   ~/.dsh/bionic-soul/assets/avatar_sleepy.png
 *   ~/.dsh/bionic-soul/assets/avatar_curious.png
 *
 * The avatar can be a local path, an http(s) URL or a data: URI. The browser
 * receives a data URI so the same-origin client never needs a file route.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_AVATAR_FILE = path.join(PACKAGE_ROOT, 'assets', 'default-avatar.png');
const DEFAULT_NAME = '小溯';
const DEFAULT_AVATAR = 'assets/avatar.png';
const MAX_BYTES = 12 * 1024 * 1024;

const FALLBACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<defs><radialGradient id="g" cx="50%" cy="42%" r="65%"><stop offset="0" stop-color="#1e6f8f"/><stop offset="0.6" stop-color="#0a2d47"/><stop offset="1" stop-color="#020a13"/></radialGradient></defs>
<circle cx="256" cy="256" r="248" fill="url(#g)"/>
<circle cx="256" cy="256" r="226" fill="none" stroke="#5ee6ff" stroke-opacity=".35" stroke-width="3"/>
<ellipse cx="246" cy="270" rx="118" ry="76" fill="#8ceeff"/>
<ellipse cx="250" cy="290" rx="84" ry="46" fill="#d3fbff"/>
<path d="M350 250 L432 214 L410 286 L440 330 L344 306 Z" fill="#8ceeff"/>
<circle cx="196" cy="246" r="11" fill="#061b2d"/><circle cx="201" cy="250" r="4" fill="#e8ffff"/>
<path d="M206 300 q30 22 62 0" fill="none" stroke="#2f8ba8" stroke-width="5" stroke-linecap="round"/>
<circle cx="390" cy="150" r="10" fill="none" stroke="#b8f8ff" stroke-opacity=".55" stroke-width="3"/>
<circle cx="420" cy="112" r="5" fill="none" stroke="#b8f8ff" stroke-opacity=".4" stroke-width="2"/>
</svg>`;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function mimeOf(buffer, hint = '') {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.length >= 6 && buffer.subarray(0, 3).toString() === 'GIF') return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  const head = buffer.subarray(0, 300).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'image/svg+xml';
  const ext = String(hint).split('.').pop().toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'svg') return 'image/svg+xml';
  return 'image/png';
}

function dataUri(buffer, hint = '') {
  return `data:${mimeOf(buffer, hint)};base64,${buffer.toString('base64')}`;
}

function resolveLocalPath(root, value) {
  if (!value || typeof value !== 'string') return '';
  if (value.startsWith('data:') || /^https?:\/\//i.test(value)) return '';
  const direct = path.isAbsolute(value) ? value : path.join(root, value);
  if (fs.existsSync(direct)) return direct;
  if (!path.isAbsolute(value) && !value.startsWith('assets' + path.sep) && !value.startsWith('assets/')) {
    const inAssets = path.join(root, 'assets', value);
    if (fs.existsSync(inAssets)) return inAssets;
  }
  return direct;
}

export function visualPaths(root) {
  return {
    root,
    assets: path.join(root, 'assets'),
    config: path.join(root, 'config.json'),
    avatar: path.join(root, 'assets', 'avatar.png'),
  };
}

export function ensureVisualAssets(root) {
  const paths = visualPaths(root);
  ensureDir(paths.assets);
  if (!fs.existsSync(paths.avatar)) {
    try {
      if (fs.existsSync(DEFAULT_AVATAR_FILE)) fs.copyFileSync(DEFAULT_AVATAR_FILE, paths.avatar);
      else fs.writeFileSync(paths.avatar.replace(/\.png$/i, '.svg'), FALLBACK_SVG, 'utf8');
    } catch {
      /* the identity fallback still renders an SVG */
    }
  }
  if (!fs.existsSync(paths.config)) {
    fs.writeFileSync(
      paths.config,
      `${JSON.stringify(
        {
          name: DEFAULT_NAME,
          avatar: DEFAULT_AVATAR,
          moods: {
            happy: 'assets/avatar_happy.png',
            sleepy: 'assets/avatar_sleepy.png',
            curious: 'assets/avatar_curious.png',
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }
  return paths;
}

export function readVisualConfig(root) {
  const paths = ensureVisualAssets(root);
  const parsed = readJson(paths.config, {});
  return {
    name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim().slice(0, 40) : DEFAULT_NAME,
    avatar: typeof parsed.avatar === 'string' && parsed.avatar.trim() ? parsed.avatar.trim() : DEFAULT_AVATAR,
    moods: parsed.moods && typeof parsed.moods === 'object' ? parsed.moods : {},
  };
}

function imageValue(root, value, fallbackFile) {
  if (!value || typeof value !== 'string') {
    if (fallbackFile && fs.existsSync(fallbackFile)) {
      try {
        return dataUri(fs.readFileSync(fallbackFile), fallbackFile);
      } catch {
        return '';
      }
    }
    return '';
  }
  if (value.startsWith('data:')) return value;
  if (/^https?:\/\//i.test(value)) return value;
  const file = resolveLocalPath(root, value);
  try {
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return '';
    const buffer = fs.readFileSync(file);
    if (!buffer.length || buffer.length > MAX_BYTES) return '';
    return dataUri(buffer, file);
  } catch {
    return '';
  }
}

function defaultAvatar(root) {
  const paths = visualPaths(root);
  const main = imageValue(root, readVisualConfig(root).avatar, paths.avatar);
  if (main) return main;
  if (fs.existsSync(DEFAULT_AVATAR_FILE)) {
    try {
      return dataUri(fs.readFileSync(DEFAULT_AVATAR_FILE), DEFAULT_AVATAR_FILE);
    } catch {
      /* fall back to SVG */
    }
  }
  return `data:image/svg+xml;base64,${Buffer.from(FALLBACK_SVG).toString('base64')}`;
}

export function moodFromState(engineState = {}) {
  const scratchpad = engineState?.scratchpad || {};
  const mood = scratchpad.mood || {};
  const label = String(mood.label || '');
  const valence = Number(mood.valence) || 0;
  const arousal = Number(mood.arousal) || 0;
  const hooks = Array.isArray(scratchpad.curiosity_hooks) ? scratchpad.curiosity_hooks.filter((hook) => !hook?.resolved) : [];
  const monitoring = Boolean(
    scratchpad.visual_status === 'monitoring' ||
      scratchpad.monitoring === true ||
      scratchpad.external_agents_active === true ||
      (Array.isArray(scratchpad.active_external_agents) && scratchpad.active_external_agents.length > 0),
  );
  if (monitoring) return { mood: 'monitoring', glow: 'monitoring' };
  if (/困|倦|睡|懒|醒不来/.test(label) || (arousal > 0 && arousal < 0.3)) return { mood: 'sleepy', glow: 'soft' };
  if (/开心|高兴|愉快|兴奋|感动|幸福|雀跃/.test(label) || valence > 0.55) return { mood: 'happy', glow: 'warm' };
  if (hooks.length > 0 || /好奇|期待|想弄明白/.test(label)) return { mood: 'curious', glow: 'curious' };
  return { mood: 'calm', glow: 'calm' };
}

export function identityFor(root, engineState = {}) {
  const config = readVisualConfig(root);
  const stateMood = moodFromState(engineState);
  const moods = {};
  const candidates = {
    happy: config.moods?.happy || 'assets/avatar_happy.png',
    sleepy: config.moods?.sleepy || 'assets/avatar_sleepy.png',
    curious: config.moods?.curious || 'assets/avatar_curious.png',
    monitoring: config.moods?.monitoring || 'assets/avatar_monitoring.png',
  };
  for (const [key, value] of Object.entries(candidates)) {
    const image = imageValue(root, value, '');
    if (image) moods[key] = image;
  }
  return {
    enabled: true,
    name: config.name,
    avatar: defaultAvatar(root),
    moods,
    mood: stateMood.mood,
    glow: stateMood.glow,
    monitoring: stateMood.mood === 'monitoring',
    preset: 'bionic-memory',
  };
}

export async function setVisualAvatar(root, source, { name = '', logger = null } = {}) {
  const raw = String(source || '').trim();
  if (!raw) return { ok: false, error: '需要图片路径、URL 或 Base64' };
  let buffer;
  let hint = '';
  try {
    if (raw.startsWith('data:')) {
      const comma = raw.indexOf(',');
      if (comma < 0) return { ok: false, error: 'Base64 data URI 格式不完整' };
      const meta = raw.slice(5, comma);
      const body = raw.slice(comma + 1);
      buffer = meta.includes(';base64') ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'utf8');
      hint = meta.includes('svg') ? 'svg' : meta.includes('jpeg') || meta.includes('jpg') ? 'jpg' : 'png';
    } else if (/^https?:\/\//i.test(raw)) {
      const response = await fetch(raw, { redirect: 'follow' });
      if (!response.ok) return { ok: false, error: `下载头像失败：HTTP ${response.status}` };
      buffer = Buffer.from(await response.arrayBuffer());
      hint = raw.split('?')[0];
    } else {
      const file = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return { ok: false, error: `找不到图片：${file}` };
      buffer = fs.readFileSync(file);
      hint = file;
    }
  } catch (error) {
    return { ok: false, error: `读取头像失败：${error?.message || error}` };
  }
  if (!buffer?.length) return { ok: false, error: '图片为空' };
  if (buffer.length > MAX_BYTES) return { ok: false, error: `图片超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB` };
  const paths = ensureVisualAssets(root);
  try {
    if (fs.existsSync(paths.avatar)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = path.join(paths.assets, `avatar.previous-${stamp}.png`);
      fs.copyFileSync(paths.avatar, backup);
      const backups = fs
        .readdirSync(paths.assets)
        .filter((entry) => entry.startsWith('avatar.previous-'))
        .sort();
      for (const old of backups.slice(0, Math.max(0, backups.length - 5))) {
        try {
          fs.rmSync(path.join(paths.assets, old));
        } catch {
          /* best effort */
        }
      }
    }
    fs.writeFileSync(paths.avatar, buffer);
    const config = readVisualConfig(root);
    const next = {
      ...config,
      name: String(name || '').trim() ? String(name).trim().slice(0, 40) : config.name,
      avatar: 'assets/avatar.png',
    };
    fs.writeFileSync(paths.config, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    logger?.info?.(`[bionic-memory] avatar replaced (${buffer.length} bytes)`);
    return { ok: true, path: paths.avatar, bytes: buffer.length, name: next.name, mime: mimeOf(buffer, hint) };
  } catch (error) {
    logger?.warn?.(`[bionic-memory] avatar write failed: ${error?.message || error}`);
    return { ok: false, error: `写入头像失败：${error?.message || error}` };
  }
}
