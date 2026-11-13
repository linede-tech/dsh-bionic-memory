/**
 * Small, dependency-free Chinese/English text helpers used by the memory
 * engine: tokenization, hashing-vector similarity, extractive summaries,
 * sentiment/arousal estimation, and time formatting.
 */

export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export function round(value, digits = 3) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const ASCII_WORD = /[a-z][a-z0-9_+-]{1,}/g;

const STOPWORDS = new Set(`
的 了 是 在 我 你 他 她 它 我们 你们 他们 咱们 这 那 就 也 都 和 与 及 或 而 但
不 没有 一个 一些 什么 怎么 为什么 因为 所以 如果 然后 现在 可以 需要 应该 已经
还是 只是 这样 那样 时候 感觉 东西 事情 有点 非常 真的 其实 就是 不是 这个 那个
一下 一起 自己 大家 用户 助手 您好 谢谢 请问 不过 而且 还有 可能 大概 确实 比较
一个 一种 一直 一点 一样 这么 那么 怎样 如何 是否 以及 或者 但是 之后 之前 目前
the a an and or but if then else of to in on at for with without from by is are was
were be been being it this that these those we you they he she as not no yes do does
did done have has had will would can could should may might must about into over under
again more most some any all each other such only own same so than too very just now
also i my me our your yours their them us what when where which who whom whose how why
`.split(/\s+/).filter(Boolean));

/** Extract plain text from a ContentBlock array, string, or single block. */
export function textOfContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (typeof content.text === 'string') return content.text.trim();
  return '';
}

/**
 * Tokenize mixed Chinese/English text. Chinese runs become character bigrams
 * (which behave like a cheap word proxy), English runs become lowercase words.
 */
export function tokenize(text) {
  if (!text) return [];
  const lower = String(text).toLowerCase();
  const tokens = [];

  for (const match of lower.matchAll(ASCII_WORD)) {
    const word = match[0];
    if (word.length > 1 && !STOPWORDS.has(word)) tokens.push(word);
  }

  const runs = lower.match(CJK_RUN) || [];
  for (const run of runs) {
    const chars = Array.from(run);
    for (let i = 0; i < chars.length - 1; i += 1) {
      const bigram = chars[i] + chars[i + 1];
      if (!STOPWORDS.has(bigram)) tokens.push(bigram);
    }
    if (chars.length === 1 && !STOPWORDS.has(chars[0])) tokens.push(chars[0]);
  }

  return tokens;
}

/** FNV-1a hashing vectorizer: deterministic, offline, no model required. */
export function vectorize(tokens, dim = 192) {
  const vector = new Float64Array(dim);
  for (const token of tokens) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i += 1) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const index = (hash >>> 0) % dim;
    const sign = ((hash >>> 8) & 1) === 0 ? 1 : -1;
    vector[index] += sign;
  }
  let norm = 0;
  for (let i = 0; i < dim; i += 1) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm) || 1;
  return Array.from(vector, (value) => round(value / norm, 6));
}

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return 0;
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return clamp(dot / (Math.sqrt(na) * Math.sqrt(nb)), -1, 1);
}

export function jaccard(a, b) {
  if (!a?.size || !b?.size) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const value of small) if (large.has(value)) intersection += 1;
  return intersection / (a.size + b.size - intersection || 1);
}

/** Combined lexical similarity in [0, 1]; 0.65 vector + 0.35 token overlap. */
export function textSimilarity(textA, textB) {
  const tokensA = tokenize(textA);
  const tokensB = tokenize(textB);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const lex = jaccard(new Set(tokensA), new Set(tokensB));
  const vec = cosine(vectorize(tokensA), vectorize(tokensB));
  return clamp(vec * 0.65 + lex * 0.35, 0, 1);
}

/** Similarity between a precomputed vector/token set and a candidate text. */
export function vectorTextSimilarity(vector, tokens, text) {
  if (!Array.isArray(vector) || !Array.isArray(tokens) || tokens.length === 0) return 0;
  const otherTokens = tokenize(text);
  if (otherTokens.length === 0) return 0;
  const lex = jaccard(new Set(tokens), new Set(otherTokens));
  const vec = cosine(vector, vectorize(otherTokens));
  return clamp(vec * 0.65 + lex * 0.35, 0, 1);
}

/** Top keyword tokens by weighted frequency, preserving first-seen order on ties. */
export function keywords(text, limit = 8) {
  const counts = new Map();
  for (const token of tokenize(text)) {
    const current = counts.get(token) || { count: 0, first: counts.size };
    current.count += 1;
    counts.set(token, current);
  }
  return [...counts.entries()]
    .map(([token, meta]) => ({
      token,
      score: meta.count * (1 + Math.min(token.length, 6) / 10),
      first: meta.first,
    }))
    .sort((a, b) => b.score - a.score || a.first - b.first)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.token);
}

/** Extractive summary that never exceeds `maxChars` characters. */
export function summarize(text, maxChars = 140) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= maxChars) return clean;

  const sentenceSplit = clean.split(/(?<=[。！？!?；;])/).filter(Boolean);
  let output = '';
  for (const sentence of sentenceSplit) {
    if ((output + sentence).length > maxChars) break;
    output += sentence;
  }
  if (!output) output = clean.slice(0, maxChars);
  return `${output.trim()}…`;
}

export const CORRECTION_RE =
  /不对|错了|不是这样|不是这个|不要这样|不要那么|搞错|理解错|误会|重新来|纠正|改一下|别这样|其实不|我指的是|我说的是|wrong|incorrect|not what|that's not|stop,|no, i|redo|mistake/i;

export const PRAISE_RE =
  /太好了|完美|漂亮|厉害|优秀|不错|很好|太棒|绝了|赞|谢谢|辛苦|喜欢|有价值|靠谱|awesome|great|perfect|nice|love it|thank|excellent|brilliant|amazing/i;

/**
 * Markers that a new statement may directly contradict an established habit
 * ("I quit", "no longer", "stop", "actually not", ...). Combined with high
 * topic similarity, this drives the cognitive-dissonance path.
 */
export const CONTRADICTION_RE =
  /不再|不喝|不吃|不写|不熬夜|不抽|戒了|戒掉|改掉|停止|不想|不喜欢|讨厌|受不了|别把|不要再|以后不|再也不|其实不是|我不是|错了|不是这样|never|stop|quit|don't|do not|no longer|not anymore|hate|instead/i;

/** Slightly repaint a retrieved memory with the tone at the end of a turn. */
export function reconsolidationTone(oldTone, currentTone) {
  const old = String(oldTone || '平静').trim();
  const current = String(currentTone || '平静').trim();
  if (!current) return old;
  if (old === current) return old;
  const base = old.split('·再巩固为')[0];
  const next = `${base}·再巩固为${current}`;
  return next.length > 32 ? `${base}·再巩固` : next;
}

const POSITIVE_WORDS =
  /喜欢|爱|谢谢|太好了|完美|漂亮|厉害|棒|赞|开心|高兴|期待|有趣|优雅|聪明|可靠|感激|不错|很好|优秀|顺利|满意|惊喜|舒服|搞笑|震撼|兴奋|good|great|nice|love|thanks|perfect|beautiful|excellent|cool|amazing|happy|wow|brilliant|delightful|glad|awesome/gi;

const NEGATIVE_WORDS =
  /讨厌|烦|气死|生气|难过|失望|糟糕|痛苦|焦虑|压力|累|崩溃|垃圾|烂|错|失败|无语|郁闷|担心|害怕|救命|算了|不行|难受|无聊|混乱|bug|damn|angry|sad|bad|terrible|awful|hate|wrong|broken|fail|exhausted|anxious|frustrated|annoying|sorry|stuck|confusing/gi;

const INTENSIFIERS = /太|很|超|非常|极其|真是|特别|巨|狂|简直|really|very|so|extremely|totally/gi;

function countMatches(text, regex) {
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

export function toneLabel(valence, arousal) {
  if (valence > 0.35) return arousal > 0.6 ? '兴奋喜悦' : '温和愉快';
  if (valence < -0.35) return arousal > 0.6 ? '焦躁不安' : '低沉失落';
  return arousal > 0.6 ? '专注紧绷' : '平静松弛';
}

/**
 * Estimate an emotion anchor from text.
 * `e` is the spec's emotional arousal E in [0.1, 2.0].
 */
export function sentiment(text) {
  const value = String(text ?? '');
  const positive = countMatches(value, POSITIVE_WORDS);
  const negative = countMatches(value, NEGATIVE_WORDS);
  const exclamations = countMatches(value, /[!！]/g);
  const questions = countMatches(value, /[?？]/g);
  const intensifiers = countMatches(value, INTENSIFIERS);
  const caps = countMatches(value, /\b[A-Z]{3,}\b/g);
  const correction = CORRECTION_RE.test(value) ? 1 : 0;
  const praise = PRAISE_RE.test(value) ? 1 : 0;
  const total = positive + negative;
  const balance = total === 0 ? 0 : (positive - negative) / total;
  const arousal = clamp(
    Math.min(0.45, exclamations * 0.12) +
      Math.min(0.2, questions * 0.05) +
      Math.min(0.25, intensifiers * 0.05) +
      Math.min(0.15, caps * 0.08) +
      Math.min(0.2, value.length / 1500),
    0,
    1,
  );
  const valence = clamp(balance * (0.6 + arousal * 0.6) + praise * 0.08, -1, 1);
  const e = clamp(0.65 + Math.abs(valence) * 0.85 + arousal * 0.35 + correction * 0.2, 0.1, 2.0);
  return {
    e: round(e, 2),
    valence: round(valence, 3),
    arousal: round(arousal, 3),
    tone: toneLabel(valence, arousal),
    positive,
    negative,
    correction: correction === 1,
    praise: praise === 1,
    surpriseBoost: correction ? 0.65 : praise ? 0.15 : 0,
  };
}

/** A one-line, deliberately fuzzy impression (Layer 2). */
export function impressionOf(text, tone, keywordList, maxChars = 120) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  const topic = (keywordList || []).slice(0, 3).join('、');
  const gist = summarize(clean.replace(/^【用户】/, ''), 46).replace(/[。！？!?]+$/, '');
  const pieces = [];
  if (topic) pieces.push(`那天说到${topic}`);
  if (gist) pieces.push(gist);
  if (!pieces.length) pieces.push('一段已经说不清细节的对话');
  let output = `${pieces.join('，')}——留下的感觉是${tone || '平静'}。`;
  if (output.length > maxChars) output = `${output.slice(0, maxChars - 1)}…`;
  return output;
}

export function habitusSummary(keywordList) {
  const topic = (keywordList || []).slice(0, 3).join('、');
  return topic
    ? `你们反复围绕「${topic}」展开类似的对话，已经成了无需多说的默契。`
    : '你们反复经历着相似节奏的对话，已经成了习惯。';
}

/** Random but human wording for a first-person dream residue. */
export function moodWord(valence, arousal) {
  if (valence > 0.35) return arousal > 0.55 ? '心里亮得发烫' : '胸口有一块温温的地方';
  if (valence < -0.35) return arousal > 0.55 ? '像被人攥住又松开' : '像一间很久没开灯的屋子';
  return arousal > 0.55 ? '神经还绷着一根细线' : '像水面刚恢复平静';
}

export function humanizeElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '刚刚';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月`;
  return `${Math.floor(months / 12)} 年`;
}

export function formatDateTime(timestamp) {
  const date = new Date(timestamp || Date.now());
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

export function isoDate(timestamp) {
  const date = new Date(timestamp || Date.now());
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function startOfLocalDay(timestamp = Date.now()) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function sameLocalDay(a, b) {
  return isoDate(a) === isoDate(b);
}

export function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let counter = 0;

export function newId(prefix) {
  counter = (counter + 1) % 100000;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(3, '0')}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

export function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

export function shortRule(text, maxChars = 180) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > maxChars ? `${clean.slice(0, maxChars - 1)}…` : clean;
}

export function averageVector(vectors, dim = 192) {
  const out = new Array(dim).fill(0);
  let count = 0;
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length === 0) continue;
    count += 1;
    for (let i = 0; i < dim && i < vector.length; i += 1) out[i] += vector[i];
  }
  if (count === 0) return out;
  let norm = 0;
  for (let i = 0; i < dim; i += 1) {
    out[i] /= count;
    norm += out[i] * out[i];
  }
  norm = Math.sqrt(norm) || 1;
  return out.map((value) => round(value / norm, 6));
}
