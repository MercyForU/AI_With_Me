/**
 * 手机版的表结构：与电脑端 server/db.js 保持一致。
 * 将来做「记录级增量同步」时，两边字段一致能省掉一次迁移。
 */
import { exec, ensureColumn } from './sqlite';

const DDL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  emoji              TEXT NOT NULL DEFAULT '🌙',
  accent             TEXT NOT NULL DEFAULT 'violet',
  avatar_url         TEXT,
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
  attachments  TEXT,
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
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  label          TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'chat',
  type           TEXT NOT NULL DEFAULT 'openai',
  base_url       TEXT NOT NULL,
  api_key        TEXT NOT NULL DEFAULT '',
  models         TEXT NOT NULL DEFAULT '[]',
  preferred_model TEXT,
  supports_vision INTEGER NOT NULL DEFAULT 0,
  supports_tools  INTEGER NOT NULL DEFAULT 0,
  last_ok        INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);

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
  vector       TEXT,
  embedded_at  TEXT,
  created_at   TEXT NOT NULL,
  deleted_at   TEXT,
  raw_content  TEXT,
  source       TEXT NOT NULL DEFAULT 'chat'
);

CREATE INDEX IF NOT EXISTS idx_messages_char ON messages (character_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memories_char ON memories (character_id, created_at);
CREATE INDEX IF NOT EXISTS idx_games_char ON game_records (character_id, created_at);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts (created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chunk_hash ON memory_chunks (character_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_chunk_char ON memory_chunks (character_id, deleted_at);
`;

let ready: Promise<void> | null = null;

export async function initSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    await exec(DDL);
    // 老版本装过 APK 时可能缺列，逐个补（幂等）
    await ensureColumn('characters', 'avatar_url', 'avatar_url TEXT');
    await ensureColumn('messages', 'attachments', 'attachments TEXT');
    await ensureColumn('providers', 'kind', "kind TEXT NOT NULL DEFAULT 'chat'");
    await ensureColumn('providers', 'preferred_model', 'preferred_model TEXT');
    await ensureColumn('providers', 'supports_vision', 'supports_vision INTEGER NOT NULL DEFAULT 0');
    await ensureColumn('providers', 'supports_tools', 'supports_tools INTEGER NOT NULL DEFAULT 0');
    await ensureColumn('memory_chunks', 'embed_text', 'embed_text TEXT');
    await ensureColumn('memory_chunks', 'raw_content', 'raw_content TEXT');
    await ensureColumn('memory_chunks', 'source', "source TEXT NOT NULL DEFAULT 'chat'");
  })();
  return ready;
}
