/**
 * One-line-a-day memory catalog.
 *
 * `soul/memory_catalog.md` is the meta-memory table of contents: exactly one
 * line per day, so she can tell "that day never happened" from "it happened
 * but the fuzzy recall missed it". The last 90 lines are compiled into Tier 1
 * as <my_memory_catalog>.
 */

import fs from 'node:fs';
import path from 'node:path';

import { isoDate, startOfLocalDay } from './text.js';

const MAX_ANCHOR = 35;
const DEFAULT_DAYS = 90;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function dayFromIso(value) {
  const ms = Date.parse(`${value}T00:00:00`);
  return Number.isFinite(ms) ? ms : 0;
}

function nextDay(iso) {
  const ms = dayFromIso(iso);
  return isoDate(ms + 86400000);
}

function oneLine(value, max = MAX_ANCHOR) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export class MemoryCatalog {
  constructor({ dataDir, logger = null, clock = () => Date.now() } = {}) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.clock = typeof clock === 'function' ? clock : () => Date.now();
    this.file = path.join(dataDir, 'soul', 'memory_catalog.md');
    this.lines = [];
  }

  init() {
    ensureDir(path.dirname(this.file));
    if (!fs.existsSync(this.file)) {
      fs.writeFileSync(this.file, '# Memory Catalog\n\n', 'utf8');
    }
    this.load();
    return this;
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      this.lines = raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^- \d{4}-\d{2}-\d{2} /.test(line));
    } catch {
      this.lines = [];
    }
    return this.lines;
  }

  save() {
    ensureDir(path.dirname(this.file));
    fs.writeFileSync(this.file, `# Memory Catalog\n\n${this.lines.join('\n')}${this.lines.length ? '\n' : ''}`, 'utf8');
  }

  dayLine(day) {
    return this.lines.find((line) => line.startsWith(`- ${day} `)) || '';
  }

  makeLine({ day, status, anchor, turns, impressions, journal }) {
    const label = status || (turns || impressions ? '正常' : '空白');
    const text = anchor ? oneLine(anchor) : label === '空白' ? '无交互' : '没有清晰锚点';
    return `- ${day} [${label}] ${text} (对话:${Number(turns) || 0}轮 | 印象:${Number(impressions) || 0}条 | 日记:${journal ? '有' : '无'})`;
  }

  /**
   * Upsert the current day and fill un-recorded intervening days as [空白].
   */
  recordDay({ day = isoDate(this.clock()), status = '', anchor = '', turns = 0, impressions = 0, journal = false } = {}) {
    this.load();
    const target = this.makeLine({ day, status, anchor, turns, impressions, journal });
    const existingIndex = this.lines.findIndex((line) => line.startsWith(`- ${day} `));
    if (existingIndex >= 0) this.lines[existingIndex] = target;
    else this.lines.push(target);

    this.lines.sort((a, b) => a.slice(2, 12).localeCompare(b.slice(2, 12)));

    // Fill every missing day since the catalog started, but do not invent days
    // before its first record. A broken engine day is still a real gap and is
    // written as [空白]; a failed sleep can overwrite it as [异常残缺].
    const first = this.lines[0]?.slice(2, 12);
    if (first && day >= first) {
      let cursor = first;
      const present = new Set(this.lines.map((line) => line.slice(2, 12)));
      let guard = 0;
      while (cursor < day && guard < 400) {
        if (!present.has(cursor)) {
          this.lines.push(this.makeLine({ day: cursor, status: '空白', anchor: '无交互', turns: 0, impressions: 0, journal: false }));
          present.add(cursor);
        }
        cursor = nextDay(cursor);
        guard += 1;
      }
      this.lines.sort((a, b) => a.slice(2, 12).localeCompare(b.slice(2, 12)));
    }

    this.save();
    return target;
  }

  recordGap(day = isoDate(this.clock())) {
    return this.recordDay({ day, status: '异常残缺', anchor: '系统断连', turns: 0, impressions: 0, journal: false });
  }

  recent(limit = DEFAULT_DAYS) {
    this.load();
    return this.lines.slice(-Math.max(1, Number(limit) || DEFAULT_DAYS));
  }

  block(limit = DEFAULT_DAYS) {
    const lines = this.recent(limit);
    if (!lines.length) return '';
    return `<my_memory_catalog>\n${lines.join('\n')}\n</my_memory_catalog>`;
  }

  status() {
    this.load();
    return { days: this.lines.length, last: this.lines[this.lines.length - 1] || '', file: this.file };
  }
}
