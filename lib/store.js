/**
 * Durable store for the bionic memory engine.
 *
 * Primary backend: SQLite through Node's built-in `node:sqlite` (Electron 44
 * ships Node 24). When that builtin is unavailable the same interface is
 * served by an atomic JSON document, so memory never silently stops working.
 *
 * All episode/schema fields use the snake_case names from the design spec so
 * the persisted shape, the HTTP payload, and the prompt renderer agree.
 */

import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scratchpad (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL DEFAULT 0,
  t_created INTEGER NOT NULL,
  t_last INTEGER NOT NULL,
  s_0 REAL NOT NULL,
  e REAL NOT NULL,
  n REAL NOT NULL,
  k INTEGER NOT NULL DEFAULT 0,
  level_0_raw TEXT,
  level_1_summary TEXT,
  level_2_impression TEXT NOT NULL,
  emotion_tone TEXT,
  source_type TEXT NOT NULL DEFAULT 'agent_inferred',
  vector TEXT NOT NULL,
  keywords TEXT NOT NULL,
  schema_id TEXT,
  anchor INTEGER NOT NULL DEFAULT 0,
  faded INTEGER NOT NULL DEFAULT 0,
  last_exposed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS episodes_created ON episodes (t_created);
CREATE INDEX IF NOT EXISTS episodes_faded ON episodes (faded);

CREATE TABLE IF NOT EXISTS schemas (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_triggered INTEGER NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  stability_score REAL NOT NULL DEFAULT 0.5,
  pattern_summary TEXT NOT NULL,
  source_text TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT 'agent_inferred',
  vector TEXT NOT NULL,
  keywords TEXT NOT NULL,
  exception_anchors TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  avg_interval_hours REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS schemas_status ON schemas (status);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  rule TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  source TEXT NOT NULL DEFAULT '',
  hits INTEGER NOT NULL DEFAULT 0,
  last_used INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS dreams (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'manual',
  nrem TEXT NOT NULL DEFAULT '{}',
  narrative TEXT NOT NULL DEFAULT '',
  afterglow TEXT NOT NULL DEFAULT '',
  mood_before TEXT NOT NULL DEFAULT '{}',
  mood_after TEXT NOT NULL DEFAULT '{}',
  temperature REAL NOT NULL DEFAULT 1.25,
  model TEXT NOT NULL DEFAULT '',
  samples TEXT NOT NULL DEFAULT '[]',
  remembered_fraction REAL NOT NULL DEFAULT 0.2
);
CREATE INDEX IF NOT EXISTS dreams_started ON dreams (started_at);

CREATE TABLE IF NOT EXISTS journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS journal_at ON journal (at);

CREATE TABLE IF NOT EXISTS session_notes (
  session_id TEXT PRIMARY KEY,
  summary TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  last_user_at INTEGER NOT NULL DEFAULT 0,
  turn INTEGER NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL DEFAULT 'agent_inferred'
);
CREATE INDEX IF NOT EXISTS session_notes_updated ON session_notes (updated_at);

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  from_kind TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_kind TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0.5,
  UNIQUE (from_kind, from_id, to_kind, to_id, relation)
);
CREATE INDEX IF NOT EXISTS edges_from ON edges (from_kind, from_id);
CREATE INDEX IF NOT EXISTS edges_to ON edges (to_kind, to_id);

-- ---------------------------------------------------------------------------
-- Global bionic-soul dual-modal cortex. The engine keeps writing the legacy
-- internal tables above; these three canonical tables are the public left-brain
-- surface and are kept byte-for-byte in sync by triggers.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS episodic_memories (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL DEFAULT 0,
  t_created INTEGER NOT NULL,
  t_last INTEGER NOT NULL,
  s_0 REAL NOT NULL,
  e REAL NOT NULL,
  n REAL NOT NULL,
  k INTEGER NOT NULL DEFAULT 0,
  level_0_raw TEXT,
  level_1_summary TEXT,
  level_2_impression TEXT NOT NULL,
  embedding TEXT NOT NULL,
  emotion_tone TEXT,
  source_type TEXT NOT NULL DEFAULT 'agent_inferred',
  keywords TEXT NOT NULL,
  schema_id TEXT,
  anchor INTEGER NOT NULL DEFAULT 0,
  faded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS episodic_memories_created ON episodic_memories (t_created);
CREATE INDEX IF NOT EXISTS episodic_memories_faded ON episodic_memories (faded);

CREATE TABLE IF NOT EXISTS compressed_schemas (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_triggered INTEGER NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  stability_score REAL NOT NULL DEFAULT 0.5,
  pattern_summary TEXT NOT NULL,
  source_text TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT 'agent_inferred',
  embedding TEXT NOT NULL,
  keywords TEXT NOT NULL,
  exception_anchors TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  avg_interval_hours REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS memory_edges (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  from_kind TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_kind TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0.5,
  anchor TEXT NOT NULL DEFAULT ''
);

INSERT OR REPLACE INTO episodic_memories (
  id, session_id, turn, t_created, t_last, s_0, e, n, k,
  level_0_raw, level_1_summary, level_2_impression, embedding,
  emotion_tone, source_type, keywords, schema_id, anchor, faded
)
SELECT
  id, session_id, turn, t_created, t_last, s_0, e, n, k,
  level_0_raw, level_1_summary, level_2_impression, vector,
  emotion_tone, source_type, keywords, schema_id, anchor, faded
FROM episodes;

INSERT OR REPLACE INTO compressed_schemas (
  id, created_at, last_triggered, occurrence_count, stability_score,
  pattern_summary, source_text, source_type, embedding, keywords,
  exception_anchors, status, avg_interval_hours
)
SELECT
  id, created_at, last_triggered, occurrence_count, stability_score,
  pattern_summary, source_text, source_type, vector, keywords,
  exception_anchors, status, avg_interval_hours
FROM schemas;

INSERT OR REPLACE INTO memory_edges (
  id, at, from_kind, from_id, to_kind, to_id, relation, weight, anchor
)
SELECT id, at, from_kind, from_id, to_kind, to_id, relation, weight, ''
FROM edges;

CREATE TRIGGER IF NOT EXISTS episodes_mirror_insert
AFTER INSERT ON episodes
BEGIN
  INSERT OR REPLACE INTO episodic_memories (
    id, session_id, turn, t_created, t_last, s_0, e, n, k,
    level_0_raw, level_1_summary, level_2_impression, embedding,
    emotion_tone, source_type, keywords, schema_id, anchor, faded
  ) VALUES (
    NEW.id, NEW.session_id, NEW.turn, NEW.t_created, NEW.t_last, NEW.s_0, NEW.e, NEW.n, NEW.k,
    NEW.level_0_raw, NEW.level_1_summary, NEW.level_2_impression, NEW.vector,
    NEW.emotion_tone, NEW.source_type, NEW.keywords, NEW.schema_id, NEW.anchor, NEW.faded
  );
END;

CREATE TRIGGER IF NOT EXISTS episodes_mirror_update
AFTER UPDATE ON episodes
BEGIN
  INSERT OR REPLACE INTO episodic_memories (
    id, session_id, turn, t_created, t_last, s_0, e, n, k,
    level_0_raw, level_1_summary, level_2_impression, embedding,
    emotion_tone, source_type, keywords, schema_id, anchor, faded
  ) VALUES (
    NEW.id, NEW.session_id, NEW.turn, NEW.t_created, NEW.t_last, NEW.s_0, NEW.e, NEW.n, NEW.k,
    NEW.level_0_raw, NEW.level_1_summary, NEW.level_2_impression, NEW.vector,
    NEW.emotion_tone, NEW.source_type, NEW.keywords, NEW.schema_id, NEW.anchor, NEW.faded
  );
END;

CREATE TRIGGER IF NOT EXISTS episodes_mirror_delete
AFTER DELETE ON episodes
BEGIN
  DELETE FROM episodic_memories WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS schemas_mirror_insert
AFTER INSERT ON schemas
BEGIN
  INSERT OR REPLACE INTO compressed_schemas (
    id, created_at, last_triggered, occurrence_count, stability_score,
    pattern_summary, source_text, source_type, embedding, keywords,
    exception_anchors, status, avg_interval_hours
  ) VALUES (
    NEW.id, NEW.created_at, NEW.last_triggered, NEW.occurrence_count, NEW.stability_score,
    NEW.pattern_summary, NEW.source_text, NEW.source_type, NEW.vector, NEW.keywords,
    NEW.exception_anchors, NEW.status, NEW.avg_interval_hours
  );
END;

CREATE TRIGGER IF NOT EXISTS schemas_mirror_update
AFTER UPDATE ON schemas
BEGIN
  INSERT OR REPLACE INTO compressed_schemas (
    id, created_at, last_triggered, occurrence_count, stability_score,
    pattern_summary, source_text, source_type, embedding, keywords,
    exception_anchors, status, avg_interval_hours
  ) VALUES (
    NEW.id, NEW.created_at, NEW.last_triggered, NEW.occurrence_count, NEW.stability_score,
    NEW.pattern_summary, NEW.source_text, NEW.source_type, NEW.vector, NEW.keywords,
    NEW.exception_anchors, NEW.status, NEW.avg_interval_hours
  );
END;

CREATE TRIGGER IF NOT EXISTS schemas_mirror_delete
AFTER DELETE ON schemas
BEGIN
  DELETE FROM compressed_schemas WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS edges_mirror_insert
AFTER INSERT ON edges
BEGIN
  INSERT OR REPLACE INTO memory_edges (
    id, at, from_kind, from_id, to_kind, to_id, relation, weight, anchor
  ) VALUES (
    NEW.id, NEW.at, NEW.from_kind, NEW.from_id, NEW.to_kind, NEW.to_id, NEW.relation, NEW.weight, ''
  );
END;

CREATE TRIGGER IF NOT EXISTS edges_mirror_delete
AFTER DELETE ON edges
BEGIN
  DELETE FROM memory_edges WHERE id = OLD.id;
END;
`;

const EPISODE_COLUMNS = {
  session_id: 'session_id',
  turn: 'turn',
  t_created: 't_created',
  t_last: 't_last',
  s_0: 's_0',
  e: 'e',
  n: 'n',
  k: 'k',
  level_0_raw: 'level_0_raw',
  level_1_summary: 'level_1_summary',
  level_2_impression: 'level_2_impression',
  emotion_tone: 'emotion_tone',
  source_type: 'source_type',
  vector: 'vector',
  keywords: 'keywords',
  schema_id: 'schema_id',
  anchor: 'anchor',
  faded: 'faded',
  last_exposed: 'last_exposed',
};

const SCHEMA_COLUMNS = {
  created_at: 'created_at',
  last_triggered: 'last_triggered',
  occurrence_count: 'occurrence_count',
  stability_score: 'stability_score',
  pattern_summary: 'pattern_summary',
  source_text: 'source_text',
  source_type: 'source_type',
  vector: 'vector',
  keywords: 'keywords',
  exception_anchors: 'exception_anchors',
  status: 'status',
  avg_interval_hours: 'avg_interval_hours',
};

const SKILL_COLUMNS = {
  created_at: 'created_at',
  rule: 'rule',
  confidence: 'confidence',
  source: 'source',
  hits: 'hits',
  last_used: 'last_used',
  active: 'active',
};

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toJson(value) {
  return JSON.stringify(value ?? null);
}

function rowToEpisode(row) {
  if (!row) return null;
  return {
    id: row.id,
    session_id: row.session_id,
    turn: row.turn,
    t_created: row.t_created,
    t_last: row.t_last,
    s_0: row.s_0,
    e: row.e,
    n: row.n,
    k: row.k,
    level_0_raw: row.level_0_raw,
    level_1_summary: row.level_1_summary,
    level_2_impression: row.level_2_impression,
    emotion_tone: row.emotion_tone,
    source_type: row.source_type || 'agent_inferred',
    vector: parseJson(row.vector, []),
    keywords: parseJson(row.keywords, []),
    schema_id: row.schema_id,
    anchor: row.anchor,
    faded: row.faded,
    last_exposed: row.last_exposed,
  };
}

function rowToSchema(row) {
  if (!row) return null;
  return {
    id: row.id,
    created_at: row.created_at,
    last_triggered: row.last_triggered,
    occurrence_count: row.occurrence_count,
    stability_score: row.stability_score,
    pattern_summary: row.pattern_summary,
    source_text: row.source_text,
    source_type: row.source_type || 'agent_inferred',
    vector: parseJson(row.vector, []),
    keywords: parseJson(row.keywords, []),
    exception_anchors: parseJson(row.exception_anchors, []),
    status: row.status,
    avg_interval_hours: row.avg_interval_hours,
  };
}

function rowToSkill(row) {
  if (!row) return null;
  return {
    id: row.id,
    created_at: row.created_at,
    rule: row.rule,
    confidence: row.confidence,
    source: row.source,
    hits: row.hits,
    last_used: row.last_used,
    active: row.active,
  };
}

function rowToDream(row) {
  if (!row) return null;
  return {
    id: row.id,
    started_at: row.started_at,
    ended_at: row.ended_at,
    trigger: row.trigger,
    nrem: parseJson(row.nrem, {}),
    narrative: row.narrative,
    afterglow: row.afterglow,
    mood_before: parseJson(row.mood_before, {}),
    mood_after: parseJson(row.mood_after, {}),
    temperature: row.temperature,
    model: row.model,
    samples: parseJson(row.samples, []),
    remembered_fraction: row.remembered_fraction,
  };
}

function rowToJournal(row) {
  if (!row) return null;
  return {
    seq: row.seq,
    at: row.at,
    session_id: row.session_id,
    kind: row.kind,
    summary: row.summary,
    detail: row.detail,
  };
}

function rowToEdge(row) {
  if (!row) return null;
  return {
    id: row.id,
    at: row.at,
    from_kind: row.from_kind,
    from_id: row.from_id,
    to_kind: row.to_kind,
    to_id: row.to_id,
    relation: row.relation,
    weight: row.weight,
  };
}

function rowToSessionNote(row) {
  if (!row) return null;
  return {
    session_id: row.session_id,
    summary: row.summary,
    updated_at: row.updated_at,
    last_user_at: row.last_user_at,
    turn: row.turn,
    source_type: row.source_type || 'agent_inferred',
  };
}

class SqliteStore {
  constructor(file, DatabaseSync, logger) {
    this.kind = 'sqlite';
    this.file = file;
    this.logger = logger;
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA_SQL);
    // Migration for databases created before source attribution existed.
    this.ensureColumn('episodes', 'source_type', "TEXT NOT NULL DEFAULT 'agent_inferred'");
    this.ensureColumn('schemas', 'source_type', "TEXT NOT NULL DEFAULT 'agent_inferred'");
  }

  ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((entry) => entry.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  getMeta(key, fallback = undefined) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? parseJson(row.value, fallback) : fallback;
  }

  setMeta(key, value) {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, toJson(value));
  }

  getScratchpad() {
    const row = this.db.prepare('SELECT json FROM scratchpad WHERE id = 1').get();
    return row ? parseJson(row.json, null) : null;
  }

  saveScratchpad(value) {
    this.db
      .prepare(
        'INSERT INTO scratchpad (id, json, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at',
      )
      .run(toJson(value), Date.now());
  }

  listEpisodes() {
    return this.db.prepare('SELECT * FROM episodes ORDER BY t_created ASC').all().map(rowToEpisode);
  }

  getEpisode(id) {
    return rowToEpisode(this.db.prepare('SELECT * FROM episodes WHERE id = ?').get(id));
  }

  findEpisodeByTurn(sessionId, turn) {
    if (!sessionId) return null;
    return rowToEpisode(
      this.db
        .prepare('SELECT * FROM episodes WHERE session_id = ? AND turn = ? ORDER BY t_created DESC LIMIT 1')
        .get(String(sessionId), Number(turn) || 0),
    );
  }

  insertEpisode(episode) {
    this.db
      .prepare(
        `INSERT INTO episodes (id, session_id, turn, t_created, t_last, s_0, e, n, k,
          level_0_raw, level_1_summary, level_2_impression, emotion_tone, source_type, vector, keywords,
          schema_id, anchor, faded, last_exposed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        episode.id,
        episode.session_id,
        episode.turn ?? 0,
        episode.t_created,
        episode.t_last,
        episode.s_0,
        episode.e,
        episode.n,
        episode.k ?? 0,
        episode.level_0_raw ?? null,
        episode.level_1_summary ?? null,
        episode.level_2_impression,
        episode.emotion_tone ?? null,
        episode.source_type ?? 'agent_inferred',
        toJson(episode.vector ?? []),
        toJson(episode.keywords ?? []),
        episode.schema_id ?? null,
        episode.anchor ? 1 : 0,
        episode.faded ? 1 : 0,
        episode.last_exposed ?? 0,
      );
    return episode;
  }

  updateEpisode(id, patch) {
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(EPISODE_COLUMNS)) {
      if (!(key in patch)) continue;
      sets.push(`${column} = ?`);
      values.push(Array.isArray(patch[key]) ? toJson(patch[key]) : patch[key]);
    }
    if (!sets.length) return;
    values.push(id);
    this.db.prepare(`UPDATE episodes SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  deleteEpisodes(ids) {
    if (!ids?.length) return;
    const remove = this.db.prepare('DELETE FROM episodes WHERE id = ?');
    const unlink = this.db.prepare(
      "DELETE FROM edges WHERE (from_kind = 'episode' AND from_id = ?) OR (to_kind = 'episode' AND to_id = ?)",
    );
    for (const id of ids) {
      remove.run(id);
      unlink.run(id, id);
    }
  }

  listSchemas() {
    return this.db.prepare('SELECT * FROM schemas ORDER BY last_triggered ASC').all().map(rowToSchema);
  }

  insertSchema(schema) {
    this.db
      .prepare(
        `INSERT INTO schemas (id, created_at, last_triggered, occurrence_count, stability_score,
          pattern_summary, source_text, source_type, vector, keywords, exception_anchors, status, avg_interval_hours)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        schema.id,
        schema.created_at,
        schema.last_triggered,
        schema.occurrence_count,
        schema.stability_score,
        schema.pattern_summary,
        schema.source_text ?? '',
        schema.source_type ?? 'agent_inferred',
        toJson(schema.vector ?? []),
        toJson(schema.keywords ?? []),
        toJson(schema.exception_anchors ?? []),
        schema.status ?? 'active',
        schema.avg_interval_hours ?? 0,
      );
    return schema;
  }

  updateSchema(id, patch) {
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(SCHEMA_COLUMNS)) {
      if (!(key in patch)) continue;
      sets.push(`${column} = ?`);
      values.push(Array.isArray(patch[key]) || typeof patch[key] === 'object' ? toJson(patch[key]) : patch[key]);
    }
    if (!sets.length) return;
    values.push(id);
    this.db.prepare(`UPDATE schemas SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  deleteSchemas(ids) {
    if (!ids?.length) return;
    const remove = this.db.prepare('DELETE FROM schemas WHERE id = ?');
    const unlink = this.db.prepare(
      "DELETE FROM edges WHERE (from_kind = 'habit' AND from_id = ?) OR (to_kind = 'habit' AND to_id = ?)",
    );
    for (const id of ids) {
      remove.run(id);
      unlink.run(id, id);
    }
  }

  listSkills() {
    return this.db.prepare('SELECT * FROM skills ORDER BY created_at ASC').all().map(rowToSkill);
  }

  insertSkill(skill) {
    this.db
      .prepare(
        'INSERT INTO skills (id, created_at, rule, confidence, source, hits, last_used, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        skill.id,
        skill.created_at,
        skill.rule,
        skill.confidence,
        skill.source ?? '',
        skill.hits ?? 0,
        skill.last_used ?? 0,
        skill.active ? 1 : 0,
      );
    return skill;
  }

  updateSkill(id, patch) {
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(SKILL_COLUMNS)) {
      if (!(key in patch)) continue;
      sets.push(`${column} = ?`);
      values.push(patch[key]);
    }
    if (!sets.length) return;
    values.push(id);
    this.db.prepare(`UPDATE skills SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  deleteSkills(ids) {
    if (!ids?.length) return;
    const remove = this.db.prepare('DELETE FROM skills WHERE id = ?');
    const unlink = this.db.prepare(
      "DELETE FROM edges WHERE (from_kind = 'skill' AND from_id = ?) OR (to_kind = 'skill' AND to_id = ?)",
    );
    for (const id of ids) {
      remove.run(id);
      unlink.run(id, id);
    }
  }

  deleteEdges(ids) {
    if (!ids?.length) return;
    const remove = this.db.prepare('DELETE FROM edges WHERE id = ?');
    for (const id of ids) remove.run(id);
  }

  insertDream(dream) {
    this.db
      .prepare(
        `INSERT INTO dreams (id, started_at, ended_at, trigger, nrem, narrative, afterglow,
          mood_before, mood_after, temperature, model, samples, remembered_fraction)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        dream.id,
        dream.started_at,
        dream.ended_at,
        dream.trigger ?? 'manual',
        toJson(dream.nrem ?? {}),
        dream.narrative ?? '',
        dream.afterglow ?? '',
        toJson(dream.mood_before ?? {}),
        toJson(dream.mood_after ?? {}),
        dream.temperature ?? 1.25,
        dream.model ?? '',
        toJson(dream.samples ?? []),
        dream.remembered_fraction ?? 0.2,
      );
    return dream;
  }

  listDreams(limit = 5) {
    return this.db.prepare('SELECT * FROM dreams ORDER BY started_at DESC LIMIT ?').all(limit).map(rowToDream);
  }

  appendJournal(entry) {
    this.db
      .prepare('INSERT INTO journal (at, session_id, kind, summary, detail) VALUES (?, ?, ?, ?, ?)')
      .run(entry.at ?? Date.now(), entry.session_id ?? '', entry.kind, entry.summary ?? '', entry.detail ?? '');
  }

  listJournal(since = 0, limit = 200) {
    return this.db
      .prepare('SELECT * FROM journal WHERE at >= ? ORDER BY at DESC LIMIT ?')
      .all(since, limit)
      .map(rowToJournal);
  }

  listSessionNotes() {
    return this.db.prepare('SELECT * FROM session_notes ORDER BY updated_at DESC').all().map(rowToSessionNote);
  }

  getSessionNote(id) {
    return rowToSessionNote(this.db.prepare('SELECT * FROM session_notes WHERE session_id = ?').get(id));
  }

  upsertSessionNote(note) {
    this.db
      .prepare(
        `INSERT INTO session_notes (session_id, summary, updated_at, last_user_at, turn, source_type)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           summary = excluded.summary,
           updated_at = excluded.updated_at,
           last_user_at = excluded.last_user_at,
           turn = excluded.turn,
           source_type = excluded.source_type`,
      )
      .run(
        note.session_id,
        note.summary ?? '',
        note.updated_at ?? Date.now(),
        note.last_user_at ?? 0,
        note.turn ?? 0,
        note.source_type ?? 'agent_inferred',
      );
  }

  addEdge(edge) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO edges (at, from_kind, from_id, to_kind, to_id, relation, weight) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        edge.at ?? Date.now(),
        edge.from_kind,
        edge.from_id,
        edge.to_kind,
        edge.to_id,
        edge.relation,
        edge.weight ?? 0.5,
      );
  }

  listEdges(limit = 80) {
    return this.db.prepare('SELECT * FROM edges ORDER BY at DESC LIMIT ?').all(limit).map(rowToEdge);
  }

  stats() {
    const count = (table) => this.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
    return {
      episodes: count('episodes'),
      faded: this.db.prepare('SELECT COUNT(*) AS c FROM episodes WHERE faded = 1').get().c,
      schemas: count('schemas'),
      skills: count('skills'),
      dreams: count('dreams'),
      journal: count('journal'),
      edges: count('edges'),
    };
  }

  reset() {
    this.db.exec(
      'DELETE FROM episodes; DELETE FROM schemas; DELETE FROM skills; DELETE FROM dreams; DELETE FROM journal; DELETE FROM edges; DELETE FROM session_notes; DELETE FROM meta; DELETE FROM scratchpad;',
    );
  }

  flush() {}
  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

class JsonStore {
  constructor(dir, logger, fileName = 'memory.json') {
    this.kind = 'json';
    this.dir = dir;
    this.file = path.join(dir, fileName);
    this.logger = logger;
    this.timer = null;
    this.data = this.load();
  }

  load() {
    const empty = {
      meta: {},
      scratchpad: null,
      episodes: [],
      schemas: [],
      skills: [],
      dreams: [],
      journal: [],
      edges: [],
      session_notes: [],
      nextJournalSeq: 1,
      nextEdgeId: 1,
    };
    try {
      if (!fs.existsSync(this.file)) return empty;
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        ...empty,
        ...parsed,
        meta: parsed.meta ?? {},
        edges: parsed.edges ?? [],
        session_notes: parsed.session_notes ?? [],
      };
    } catch (error) {
      this.logger?.warn?.(`[bionic-memory] memory.json unreadable, starting fresh: ${error?.message || error}`);
      return empty;
    }
  }

  touch() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 300);
    this.timer.unref?.();
  }

  getMeta(key, fallback = undefined) {
    return key in this.data.meta ? this.data.meta[key] : fallback;
  }

  setMeta(key, value) {
    this.data.meta[key] = value;
    this.touch();
  }

  getScratchpad() {
    return this.data.scratchpad;
  }

  saveScratchpad(value) {
    this.data.scratchpad = value;
    this.touch();
  }

  listEpisodes() {
    return this.data.episodes.slice().sort((a, b) => a.t_created - b.t_created);
  }

  getEpisode(id) {
    return this.data.episodes.find((episode) => episode.id === id) ?? null;
  }

  findEpisodeByTurn(sessionId, turn) {
    if (!sessionId) return null;
    return (
      this.data.episodes
        .filter((episode) => episode.session_id === String(sessionId) && Number(episode.turn) === (Number(turn) || 0))
        .sort((a, b) => b.t_created - a.t_created)[0] ?? null
    );
  }

  insertEpisode(episode) {
    this.data.episodes.push(episode);
    this.touch();
    return episode;
  }

  updateEpisode(id, patch) {
    const episode = this.getEpisode(id);
    if (!episode) return;
    Object.assign(episode, patch);
    this.touch();
  }

  deleteEpisodes(ids) {
    const set = new Set(ids || []);
    if (!set.size) return;
    this.data.episodes = this.data.episodes.filter((episode) => !set.has(episode.id));
    this.data.edges = this.data.edges.filter(
      (edge) =>
        !((edge.from_kind === 'episode' && set.has(edge.from_id)) ||
          (edge.to_kind === 'episode' && set.has(edge.to_id))),
    );
    this.touch();
  }

  listSchemas() {
    return this.data.schemas.slice().sort((a, b) => a.last_triggered - b.last_triggered);
  }

  insertSchema(schema) {
    this.data.schemas.push(schema);
    this.touch();
    return schema;
  }

  updateSchema(id, patch) {
    const schema = this.data.schemas.find((item) => item.id === id);
    if (!schema) return;
    Object.assign(schema, patch);
    this.touch();
  }

  deleteSchemas(ids) {
    const set = new Set(ids || []);
    if (!set.size) return;
    this.data.schemas = this.data.schemas.filter((schema) => !set.has(schema.id));
    this.data.edges = this.data.edges.filter(
      (edge) =>
        !((edge.from_kind === 'habit' && set.has(edge.from_id)) ||
          (edge.to_kind === 'habit' && set.has(edge.to_id))),
    );
    this.touch();
  }

  listSkills() {
    return this.data.skills.slice().sort((a, b) => a.created_at - b.created_at);
  }

  insertSkill(skill) {
    this.data.skills.push(skill);
    this.touch();
    return skill;
  }

  updateSkill(id, patch) {
    const skill = this.data.skills.find((item) => item.id === id);
    if (!skill) return;
    Object.assign(skill, patch);
    this.touch();
  }

  deleteSkills(ids) {
    const set = new Set(ids || []);
    if (!set.size) return;
    this.data.skills = this.data.skills.filter((skill) => !set.has(skill.id));
    this.data.edges = this.data.edges.filter(
      (edge) =>
        !((edge.from_kind === 'skill' && set.has(edge.from_id)) ||
          (edge.to_kind === 'skill' && set.has(edge.to_id))),
    );
    this.touch();
  }

  deleteEdges(ids) {
    const set = new Set(ids || []);
    if (!set.size) return;
    this.data.edges = this.data.edges.filter((edge) => !set.has(edge.id));
    this.touch();
  }

  insertDream(dream) {
    this.data.dreams.push(dream);
    this.touch();
    return dream;
  }

  listDreams(limit = 5) {
    return this.data.dreams.slice().sort((a, b) => b.started_at - a.started_at).slice(0, limit);
  }

  appendJournal(entry) {
    this.data.journal.push({
      seq: this.data.nextJournalSeq++,
      at: entry.at ?? Date.now(),
      session_id: entry.session_id ?? '',
      kind: entry.kind,
      summary: entry.summary ?? '',
      detail: entry.detail ?? '',
    });
    if (this.data.journal.length > 5000) this.data.journal = this.data.journal.slice(-4000);
    this.touch();
  }

  listJournal(since = 0, limit = 200) {
    return this.data.journal
      .filter((entry) => entry.at >= since)
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
  }

  listSessionNotes() {
    return this.data.session_notes.slice().sort((a, b) => b.updated_at - a.updated_at);
  }

  getSessionNote(id) {
    return this.data.session_notes.find((note) => note.session_id === id) ?? null;
  }

  upsertSessionNote(note) {
    const existing = this.data.session_notes.find((item) => item.session_id === note.session_id);
    if (existing) {
      Object.assign(existing, note);
    } else {
      this.data.session_notes.push({
        session_id: note.session_id,
        summary: note.summary ?? '',
        updated_at: note.updated_at ?? Date.now(),
        last_user_at: note.last_user_at ?? 0,
        turn: note.turn ?? 0,
        source_type: note.source_type ?? 'agent_inferred',
      });
    }
    this.touch();
  }

  addEdge(edge) {
    const exists = this.data.edges.some(
      (item) =>
        item.from_kind === edge.from_kind &&
        item.from_id === edge.from_id &&
        item.to_kind === edge.to_kind &&
        item.to_id === edge.to_id &&
        item.relation === edge.relation,
    );
    if (exists) return;
    this.data.edges.push({
      id: this.data.nextEdgeId++,
      at: edge.at ?? Date.now(),
      from_kind: edge.from_kind,
      from_id: edge.from_id,
      to_kind: edge.to_kind,
      to_id: edge.to_id,
      relation: edge.relation,
      weight: edge.weight ?? 0.5,
    });
    if (this.data.edges.length > 5000) this.data.edges = this.data.edges.slice(-4000);
    this.touch();
  }

  listEdges(limit = 80) {
    return this.data.edges.slice().sort((a, b) => b.at - a.at).slice(0, limit);
  }

  stats() {
    return {
      episodes: this.data.episodes.length,
      faded: this.data.episodes.filter((episode) => episode.faded).length,
      schemas: this.data.schemas.length,
      skills: this.data.skills.length,
      dreams: this.data.dreams.length,
      journal: this.data.journal.length,
      edges: this.data.edges.length,
    };
  }

  reset() {
    this.data = {
      meta: {},
      scratchpad: null,
      episodes: [],
      schemas: [],
      skills: [],
      dreams: [],
      journal: [],
      edges: [],
      session_notes: [],
      nextJournalSeq: 1,
      nextEdgeId: 1,
    };
    this.touch();
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const temporary = `${this.file}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(this.data), 'utf8');
      fs.renameSync(temporary, this.file);
    } catch (error) {
      this.logger?.warn?.(`[bionic-memory] memory.json flush failed: ${error?.message || error}`);
    }
  }

  close() {
    this.flush();
  }
}

/**
 * Open the durable memory store.
 * @param {{ dir: string, logger?: { warn?: Function, info?: Function } }} options
 */
export async function openStore({
  dir,
  logger,
  dbFile = 'memory.db',
  jsonFile = 'memory.json',
} = {}) {
  fs.mkdirSync(dir, { recursive: true });
  let sqlite = null;
  try {
    sqlite = await import('node:sqlite');
  } catch {
    sqlite = null;
  }
  if (sqlite && typeof sqlite.DatabaseSync === 'function') {
    try {
      return new SqliteStore(path.join(dir, dbFile), sqlite.DatabaseSync, logger);
    } catch (error) {
      logger?.warn?.(
        `[bionic-memory] sqlite open failed, falling back to JSON: ${error?.message || error}`,
      );
    }
  } else {
    logger?.warn?.('[bionic-memory] node:sqlite unavailable, using the JSON store');
  }
  return new JsonStore(dir, logger, jsonFile);
}
