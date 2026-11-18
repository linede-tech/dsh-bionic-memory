/**
 * Companion identity storage. There is intentionally no preset name, gender,
 * relationship or persona here: the user initializes those on first run.
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
const DEFAULT_AVATAR = 'assets/avatar.png';
const MAX_BYTES = 12 * 1024 * 1024;
const LEGACY_DEFAULT_NAMES = new Set(['小溯', '未命名']);

const FALLBACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<defs><radialGradient id="g" cx="50%" cy="45%" r="65%"><stop offset="0" stop-color="#165a78"/><stop offset="0.6" stop-color="#092b44"/><stop offset="1" stop-color="#020a13"/></radialGradient></defs>
<circle cx="256" cy="256" r="248" fill="url(#g)"/>
<circle cx="256" cy="256" r="220" fill="none" stroke="#6ee7ff" stroke-opacity=".25" stroke-width="2"/>
<circle cx="256" cy="256" r="176" fill="none" stroke="#6ee7ff" stroke-opacity=".18" stroke-width="2"/>
<circle cx="256" cy="256" r="90" fill="#6ee7ff" fill-opacity=".10"/>
<circle cx="256" cy="256" r="58" fill="#9ff5ff" fill-opacity=".20"/>
<circle cx="256" cy="256" r="30" fill="#d9ffff" fill-opacity=".85"/>
<circle cx="256" cy="256" r="13" fill="#ffffff"/>
<circle cx="390" cy="160" r="5" fill="#9ff5ff" fill-opacity=".65"/>
<circle cx="412" cy="132" r="3" fill="#9ff5ff" fill-opacity=".45"/>
<circle cx="150" cy="386" r="4" fill="#9ff5ff" fill-opacity=".45"/>
</svg>`;

function defaultConfig() {
  return {
    initialized: false,
    name: '',
    user_name: '',
    relationship: '',
    tone: '',
    avatar: DEFAULT_AVATAR,
    moods: {
      happy: 'assets/avatar_happy.png',
      sleepy: 'assets/avatar_sleepy.png',
      curious: 'assets/avatar_curious.png',
    },
  };
}

function writeConfig(file, config) {
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function cleanText(value, max = 120) {
  return String(value || '')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, max);
}

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
    writeConfig(paths.config, defaultConfig());
    return paths;
  }
  const parsed = readJson(paths.config, null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    writeConfig(paths.config, defaultConfig());
    return paths;
  }
  // Legacy configs created before 1.3.0 carried a hardcoded "小溯" name and no
  // initialized flag. Treat that as uninitialized, but preserve a name the
  // user clearly chose themselves.
  if (typeof parsed.initialized !== 'boolean') {
    const rawName = cleanText(parsed.name, 40);
    const initialized = Boolean(rawName && !LEGACY_DEFAULT_NAMES.has(rawName));
    writeConfig(paths.config, {
      ...defaultConfig(),
      ...parsed,
      initialized,
      name: initialized ? rawName : '',
    });
  }
  return paths;
}

export function readVisualConfig(root) {
  const paths = ensureVisualAssets(root);
  const parsed = readJson(paths.config, {});
  const initialized = parsed.initialized === true;
  return {
    initialized,
    name: initialized ? cleanText(parsed.name, 40) : '',
    user_name: initialized ? cleanText(parsed.user_name, 40) : '',
    relationship: initialized ? cleanText(parsed.relationship, 200) : '',
    tone: initialized ? cleanText(parsed.tone, 400) : '',
    avatar: typeof parsed.avatar === 'string' && parsed.avatar.trim() ? parsed.avatar.trim() : DEFAULT_AVATAR,
    moods: parsed.moods && typeof parsed.moods === 'object' ? parsed.moods : {},
  };
}

/**
 * The first-run guide and the initialized identity block. This is deliberately
 * procedural: it never invents a name, gender or relationship.
 */
export function companionPrompt(config) {
  if (!config?.initialized) {
    return [
      '<companion_setup>',
      '这个仿生记忆体还没有完成初始化：没有名字、称呼、关系或固定人格。',
      '不要使用任何预设角色名，不要假定性别，也不要把“小溯”之类的旧默认当成自己。',
      '在第一次回复里用两三句话说明你会跨会话记住他，然后邀请用户完成初始化：',
      '1. 你想给我起什么名字？',
      '2. 你希望我怎么称呼你？',
      '3. 你希望我们是什么关系、用什么方式相处？',
      '4. （可选）你想给我一张头像吗？',
      '用户回答后调用 initialize_companion 工具；name 是必填项。',
      '如果用户暂时不想命名，就用中性的“我”继续，不要反复追问，也不要编造过去。',
      '</companion_setup>',
    ].join('\n');
  }
  return [
    '<companion_identity>',
    '以下身份由用户亲自设定，不是系统预设。自然地保持它，不要机械复述或自行更改：',
    `名字：${config.name || '（未命名）'}`,
    `称呼用户：${config.user_name || '（未设定）'}`,
    `关系/相处方式：${config.relationship || '（未设定）'}`,
    `语气补充：${config.tone || '（未设定）'}`,
    '</companion_identity>',
  ].join('\n');
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
    initialized: config.initialized,
    name: config.name,
    user_name: config.user_name,
    relationship: config.relationship,
    avatar: defaultAvatar(root),
    moods,
    mood: stateMood.mood,
    glow: stateMood.glow,
    monitoring: stateMood.mood === 'monitoring',
    preset: 'bionic-memory',
  };
}

/**
 * First-run identity setup. The name is required; the avatar is optional.
 * No role data is manufactured here — every human-facing value comes from the
 * user's answer.
 */
export async function initializeCompanion(root, input = {}, { logger = null } = {}) {
  const name = cleanText(input?.name, 40);
  if (!name) return { ok: false, error: '初始化需要先确定一个名字' };
  const user_name = cleanText(input?.user_name, 40);
  const relationship = cleanText(input?.relationship, 200);
  const tone = cleanText(input?.tone, 400);
  let avatarResult = null;
  if (input?.avatar) {
    avatarResult = await setVisualAvatar(root, input.avatar, { name, logger });
    if (!avatarResult.ok) return avatarResult;
  }
  const paths = ensureVisualAssets(root);
  const current = readJson(paths.config, {});
  const next = {
    ...defaultConfig(),
    ...current,
    initialized: true,
    name,
    user_name,
    relationship,
    tone,
    avatar: typeof current.avatar === 'string' && current.avatar.trim() ? current.avatar : DEFAULT_AVATAR,
  };
  writeConfig(paths.config, next);
  logger?.info?.(`[bionic-memory] companion initialized as ${name}`);
  return {
    ok: true,
    initialized: true,
    name,
    user_name,
    relationship,
    tone,
    avatar: avatarResult?.path || next.avatar,
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
    const current = readJson(paths.config, {});
    const next = {
      ...current,
      avatar: 'assets/avatar.png',
    };
    const nextName = cleanText(name, 40);
    if (nextName) next.name = nextName;
    writeConfig(paths.config, next);
    logger?.info?.(`[bionic-memory] avatar replaced (${buffer.length} bytes)`);
    return { ok: true, path: paths.avatar, bytes: buffer.length, name: next.name || '', mime: mimeOf(buffer, hint) };
  } catch (error) {
    logger?.warn?.(`[bionic-memory] avatar write failed: ${error?.message || error}`);
    return { ok: false, error: `写入头像失败：${error?.message || error}` };
  }
}
