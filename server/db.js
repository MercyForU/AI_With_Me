/**
 * SQLite 数据层（Node 内置 node:sqlite，零依赖、零编译）。
 * 数据库文件默认 data/app.db，可用 DB_PATH 覆盖。
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS characters (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT NOT NULL,
    emoji              TEXT NOT NULL DEFAULT '🌙',
    accent             TEXT NOT NULL DEFAULT 'violet',
    tagline            TEXT,
    personality        TEXT,
    scenario           TEXT,
    greeting           TEXT,
    model_id           TEXT,
    model_label        TEXT,
    memory_note        TEXT,
    relationship_level INTEGER NOT NULL DEFAULT 1,
    affinity           INTEGER NOT NULL DEFAULT 0,
    archived           INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    role         TEXT NOT NULL,
    content      TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'text',
    created_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memories (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    content      TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'fact',
    importance   INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS posts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER REFERENCES characters(id) ON DELETE CASCADE,
    content      TEXT NOT NULL,
    likes        INTEGER NOT NULL DEFAULT 0,
    liked        INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS game_records (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    game_key     TEXT NOT NULL,
    result       TEXT NOT NULL,
    summary      TEXT,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS providers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    label      TEXT NOT NULL,
    type       TEXT NOT NULL DEFAULT 'openai',
    base_url   TEXT NOT NULL,
    api_key    TEXT NOT NULL DEFAULT '',
    models     TEXT NOT NULL DEFAULT '[]',
    last_ok    INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_char ON messages (character_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_memories_char ON memories (character_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_games_char ON game_records (character_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_posts_created ON posts (created_at);

  CREATE TABLE IF NOT EXISTS memory_chunks (
    id           TEXT PRIMARY KEY,
    character_id INTEGER NOT NULL,
    session_id   TEXT NOT NULL,
    content      TEXT NOT NULL,
    embed_text   TEXT,
    msg_from     INTEGER,
    msg_to       INTEGER,
    token_count  INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL,
    embed_model  TEXT,
    embed_dim    INTEGER,
    vector       BLOB,
    embedded_at  TEXT,
    created_at   TEXT NOT NULL,
    deleted_at   TEXT,
    raw_content  TEXT,
    source       TEXT NOT NULL DEFAULT 'chat'
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_chunk_hash ON memory_chunks (character_id, content_hash);
  CREATE INDEX IF NOT EXISTS idx_chunk_char ON memory_chunks (character_id, deleted_at);
`);

// FTS5 用 trigram 分词：中文无需额外分词器即可子串匹配（unicode61 会整句当一个 token）
try {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(chunk_id UNINDEXED, content, tokenize='trigram')`);
} catch (e) {
  console.warn('[db] memory_fts 创建失败（将退回 LIKE 检索）：', e.message);
}

// 嵌入模型切换后的重建任务状态（单行表，id 恒为 1）
db.exec(`
  CREATE TABLE IF NOT EXISTS memory_rebuild (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    target_model TEXT NOT NULL DEFAULT '',
    total       INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'idle',
    started_at  TEXT,
    updated_at  TEXT,
    error       TEXT
  );
`);

// ---------- 轻量迁移（对已有数据库幂等） ----------
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

ensureColumn('characters', 'avatar_url', 'avatar_url TEXT');
ensureColumn('providers', 'models', "models TEXT NOT NULL DEFAULT '[]'");
ensureColumn('memory_chunks', 'embed_text', 'embed_text TEXT');
// 归档前用模型总结过的话，content 是摘要、raw_content 留原文；source 区分是谁写的
ensureColumn('memory_chunks', 'raw_content', 'raw_content TEXT');
ensureColumn('memory_chunks', 'source', "source TEXT NOT NULL DEFAULT 'chat'");
ensureColumn('providers', 'kind', "kind TEXT NOT NULL DEFAULT 'chat'");
ensureColumn('providers', 'supports_vision', 'supports_vision INTEGER NOT NULL DEFAULT 0');
ensureColumn('providers', 'preferred_model', 'preferred_model TEXT');
ensureColumn('providers', 'supports_tools', 'supports_tools INTEGER NOT NULL DEFAULT 0');
ensureColumn('messages', 'attachments', 'attachments TEXT');

const now = () => new Date().toISOString();

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value));
}

function deleteSetting(key) {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

module.exports = { db, now, getSetting, setSetting, deleteSetting, DB_PATH };
