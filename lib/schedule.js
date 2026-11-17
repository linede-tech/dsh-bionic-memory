/**
 * Her own schedule (`soul/my_schedule.json`).
 *
 * `set_my_own_schedule` writes a pending intent; the 5-minute heartbeat in the
 * plugin checks it and starts an autonomous tick without waiting for the user.
 */

import fs from 'node:fs';
import path from 'node:path';

const ACTIONS = new Set(['silent_task', 'proactive_message', 'go_to_sleep']);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export class MySchedule {
  constructor({ dataDir, logger = null, clock = () => Date.now() } = {}) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.clock = typeof clock === 'function' ? clock : () => Date.now();
    this.file = path.join(dataDir, 'soul', 'my_schedule.json');
    this.data = null;
  }

  init() {
    ensureDir(path.dirname(this.file));
    if (!fs.existsSync(this.file)) {
      this.data = { version: 1, entries: [] };
      this.save();
    } else {
      this.data = this.load();
    }
    return this;
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { version: 1, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
    } catch {
      return { version: 1, entries: [] };
    }
  }

  save() {
    ensureDir(path.dirname(this.file));
    fs.writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
  }

  add({ wakeAt = 0, delayMinutes = 0, intention = '', actionType = 'proactive_message' } = {}) {
    this.init();
    const now = this.clock();
    const delay = Number(delayMinutes) > 0 ? Number(delayMinutes) * 60000 : 0;
    let wake = Number(wakeAt) || 0;
    if (!wake && delay) wake = now + delay;
    if (!wake) throw new Error('wake_at_time 或 delay_minutes 必须提供其中一个');
    if (!ACTIONS.has(actionType)) throw new Error(`unknown action_type: ${actionType}`);
    const entry = {
      id: `alarm-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      created_at: now,
      wake_at: wake,
      my_intention: String(intention || '').trim(),
      action_type: actionType,
      status: 'pending',
      fired_at: 0,
      attempts: 0,
      session_id: '',
    };
    this.data.entries.push(entry);
    this.data.entries = this.data.entries.slice(-100);
    this.save();
    return entry;
  }

  due(now = this.clock()) {
    this.init();
    return this.data.entries.filter((entry) => entry.status === 'pending' && Number(entry.wake_at) <= now);
  }

  /** A process restart cannot know whether a `firing` turn survived. */
  recoverFiring() {
    this.init();
    let recovered = 0;
    for (const entry of this.data.entries) {
      if (entry.status !== 'firing') continue;
      entry.status = 'pending';
      entry.reason = 'interrupted-before-completion';
      recovered += 1;
    }
    if (recovered) this.save();
    return recovered;
  }

  all() {
    this.init();
    return this.data.entries.slice();
  }

  mark(id, status, extra = {}) {
    this.init();
    const entry = this.data.entries.find((item) => item.id === id);
    if (!entry) return null;
    entry.status = status;
    if (status === 'fired') entry.fired_at = this.clock();
    if (status === 'pending') entry.attempts = (Number(entry.attempts) || 0) + 1;
    Object.assign(entry, extra);
    this.save();
    return entry;
  }
}
