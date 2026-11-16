/**
 * 记忆入库：把滑出上下文窗口的消息压成块、向量化、写 FTS。
 * 记忆是常驻功能，无开关；模型缺失时降级为「只写 FTS 不写向量」，不影响对话。
 */
const { db, now } = require('../db');
const { buildChunks, hashText } = require('./chunk');
const { summarizeChunk } = require('./summarize');

const WINDOW = 16; // 与 prompt.buildContext 的窗口一致：最近 16 条留在上下文里

let tokenizer = null;
let embedFailed = false;

/** 切换嵌入模型后清掉「不可用」的粘性标记，否则新模型永远不会被尝试 */
function resetEmbedFailure() {
  embedFailed = false;
}

function countTokens(text) {
  try {
    if (!tokenizer) tokenizer = require('../embedding/tokenizer').loadTokenizer(require('../embedding/onnx').resolveDir());
    return Math.max(1, tokenizer.encode(text, 512).ids.length - 2);
  } catch {
    return text.length; // 模型缺失时按字符数粗估
  }
}

function maxMessageId(characterId) {
  return db.prepare('SELECT MAX(id) AS m FROM messages WHERE character_id = ?').get(characterId)?.m || 0;
}

function lastChunkedId(characterId) {
  return db.prepare('SELECT MAX(msg_to) AS m FROM memory_chunks WHERE character_id = ?').get(characterId)?.m || 0;
}

/** 待分块的消息：id 落在 (lastChunked, maxId - WINDOW] 区间 */
function pendingMessages(characterId) {
  const maxId = maxMessageId(characterId);
  const cutoff = maxId - WINDOW;
  if (cutoff <= 0) return [];
  const from = lastChunkedId(characterId);
  if (cutoff <= from) return [];
  return db
    .prepare(
      `SELECT * FROM messages
        WHERE character_id = ? AND id > ? AND id <= ?
          AND role IN ('user','assistant') AND kind IN ('text','game')
        ORDER BY id ASC`,
    )
    .all(characterId, from, cutoff);
}

function vectorToBuffer(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function bufferToVector(buf) {
  const copy = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(copy);
}

/**
 * 把该角色已滑出窗口的消息入库。幂等：重复调用不会重复插入。
 * @returns {{created:number, embedded:number, skipped:number}}
 */
async function ingest(characterId, characterName, opts = {}) {
  const msgs = pendingMessages(characterId);
  if (!msgs.length) return { created: 0, embedded: 0, skipped: 0 };
  // 攒够一批再切，否则每次回复后只挤出一条，块会碎成一句话一块
  const MIN_BATCH = 6;
  if (!opts.force && msgs.length < MIN_BATCH) {
    return { created: 0, embedded: 0, skipped: 0, waiting: MIN_BATCH - msgs.length };
  }

  const chunks = buildChunks(msgs, { characterName, countTokens });
  if (!chunks.length) return { created: 0, embedded: 0, skipped: 0 };

  // 先总结再入库：摘要当 content，原文留 raw_content。
  // 一次回复最多总结 4 块，多了排队太久，剩下的按原文存。
  const MAX_SUMMARIZE = 4;
  const prepared = [];
  let summarized = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const summary = i < MAX_SUMMARIZE ? await summarizeChunk(c.content, characterName) : null;
    if (summary) summarized += 1;
    prepared.push({
      ...c,
      content: summary || c.content,
      raw: summary ? c.content : null,
      embedText: summary || c.embedText || c.content,
    });
  }

  // 向量：模型不可用时整体跳过，块仍然入库（FTS 可搜）
  let vectors = [];
  let modelId = null;
  if (!embedFailed) {
    try {
      const embedding = require('../embedding');
      vectors = await embedding.embed(prepared.map((c) => c.embedText));
      modelId = embedding.currentModelId();
    } catch (e) {
      embedFailed = true;
      console.warn('[memory] 嵌入模型不可用，降级为仅关键词检索：', e.message);
      vectors = [];
      modelId = null;
    }
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO memory_chunks
      (id, character_id, session_id, content, embed_text, msg_from, msg_to, token_count, content_hash,
       embed_model, embed_dim, vector, embedded_at, created_at, raw_content, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'chat')`,
  );
  const insertFts = db.prepare('INSERT INTO memory_fts (chunk_id, content) VALUES (?, ?)');
  const crypto = require('node:crypto');

  let created = 0;
  let embedded = 0;
  prepared.forEach((c, i) => {
    const id = crypto.randomUUID();
    const vec = vectors[i] || null;
    const info = insert.run(
      id,
      characterId,
      c.sessionId,
      c.content,
      c.embedText,
      c.msgFrom,
      c.msgTo,
      c.tokenCount,
      c.hash,
      vec ? modelId : null,
      vec ? vec.length : null,
      vec ? vectorToBuffer(vec) : null,
      vec ? now() : null,
      now(),
      c.raw,
    );
    if (info.changes > 0) {
      created += 1;
      if (vec) embedded += 1;
      insertFts.run(id, c.content);
    }
  });

  return { created, embedded, skipped: prepared.length - created, summarized };
}

/**
 * 直接写一条记忆（用户手动添加，或模型调用 memory_write）。
 * @returns {{id:string, content:string, embedded:boolean}}
 */
async function insertChunk(characterId, content, opts = {}) {
  const text = String(content || '').trim().slice(0, 2000);
  if (!text) throw new Error('记忆内容不能为空');

  let vec = null;
  let modelId = null;
  try {
    const embedding = require('../embedding');
    [vec] = await embedding.embed([text]);
    modelId = embedding.currentModelId();
  } catch (e) {
    console.warn('[memory] 新记忆算向量失败，先按关键词检索：', e.message);
  }

  const id = require('node:crypto').randomUUID();
  const source = opts.source === 'model' ? 'model' : 'manual';
  db.prepare(
    `INSERT INTO memory_chunks
      (id, character_id, session_id, content, embed_text, msg_from, msg_to, token_count, content_hash,
       embed_model, embed_dim, vector, embedded_at, created_at, raw_content, source)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    id,
    characterId,
    new Date().toISOString().slice(0, 10),
    text,
    text,
    countTokens(text),
    `${hashText(`${text}\u0000${id}`)}-${text.length}`,
    vec ? modelId : null,
    vec ? vec.length : null,
    vec ? vectorToBuffer(vec) : null,
    vec ? now() : null,
    now(),
    source,
  );

  try {
    db.prepare('INSERT INTO memory_fts (chunk_id, content) VALUES (?, ?)').run(id, text);
  } catch {
    /* FTS 不可用时关键词路会退回 LIKE */
  }

  return { id, content: text, embedded: Boolean(vec) };
}

/** 删除一条记忆（连同 FTS 行） */
function deleteChunk(id) {
  const row = db.prepare('SELECT id FROM memory_chunks WHERE id = ?').get(id);
  if (!row) throw new Error('这条记忆不存在了');
  try {
    db.prepare('DELETE FROM memory_fts WHERE chunk_id = ?').run(id);
  } catch {
    /* ignore */
  }
  db.prepare('DELETE FROM memory_chunks WHERE id = ?').run(id);
  return { id, removed: 1 };
}

function stats(characterId) {
  const where = characterId ? 'WHERE character_id = ?' : '';
  const args = characterId ? [characterId] : [];
  const total = db.prepare(`SELECT COUNT(*) AS c FROM memory_chunks ${where}`).get(...args).c;
  const withVector = db
    .prepare(`SELECT COUNT(*) AS c FROM memory_chunks ${where ? where + ' AND' : 'WHERE'} vector IS NOT NULL`)
    .get(...args).c;
  const tokens = db.prepare(`SELECT COALESCE(SUM(token_count),0) AS t FROM memory_chunks ${where}`).get(...args).t;
  const pending = characterId ? pendingMessages(characterId).length : 0;
  const model = db.prepare(`SELECT embed_model AS m FROM memory_chunks ${where} LIMIT 1`).get(...args)?.m || null;
  return { chunks: total, withVector, tokens, pending, model };
}

/** 记忆块列表（按时间倒序分页）：给「逐条查看 / 编辑」用 */
function listChunks(characterId, opts = {}) {
  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 20));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const total = db
    .prepare('SELECT COUNT(*) AS c FROM memory_chunks WHERE character_id = ? AND deleted_at IS NULL')
    .get(characterId).c;
  const rows = db
    .prepare(
      `SELECT id, content, raw_content, source, created_at, token_count, vector IS NOT NULL AS has_vector
         FROM memory_chunks
        WHERE character_id = ? AND deleted_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(characterId, limit, offset);
  return {
    items: rows.map((r) => ({
      id: r.id,
      content: r.content,
      raw: r.raw_content || null,
      source: r.source || 'chat',
      createdAt: r.created_at,
      tokens: r.token_count,
      hasVector: Boolean(r.has_vector),
    })),
    total,
  };
}

/**
 * 改写一条记忆：内容、FTS、向量一起更新。
 * 嵌入不可用时把旧向量清掉——宁可退回关键词检索，也不要留下和内容不符的向量。
 */
async function updateChunk(id, content) {
  const text = String(content || '').trim().slice(0, 2000);
  if (!text) throw new Error('记忆内容不能为空');
  const row = db.prepare('SELECT id FROM memory_chunks WHERE id = ?').get(id);
  if (!row) throw new Error('这条记忆不存在了，刷新看看');

  let vec = null;
  let modelId = null;
  try {
    const embedding = require('../embedding');
    [vec] = await embedding.embed([text]);
    modelId = embedding.currentModelId();
  } catch (e) {
    console.warn('[memory] 编辑后重算向量失败，退回关键词检索：', e.message);
    vec = null;
  }

  // 去重键跟着内容走，但掺进 id，避免撞上别的块的 hash
  const hash = `${require('node:crypto').createHash('sha1').update(`${text}\u0000${id}`).digest('hex').slice(0, 16)}-${text.length}`;

  db.prepare(
    `UPDATE memory_chunks
        SET content = ?, embed_text = ?, content_hash = ?, token_count = ?,
            embed_model = ?, embed_dim = ?, vector = ?, embedded_at = ?
      WHERE id = ?`,
  ).run(
    text,
    text,
    hash,
    countTokens(text),
    vec ? modelId : null,
    vec ? vec.length : null,
    vec ? vectorToBuffer(vec) : null,
    vec ? now() : null,
    id,
  );

  try {
    db.prepare('DELETE FROM memory_fts WHERE chunk_id = ?').run(id);
    db.prepare('INSERT INTO memory_fts (chunk_id, content) VALUES (?, ?)').run(id, text);
  } catch {
    /* FTS 不可用时关键词路会退回 LIKE，不影响编辑 */
  }

  return { id, content: text, embedded: Boolean(vec) };
}

function clear(characterId) {
  if (characterId) {
    db.prepare('DELETE FROM memory_fts WHERE chunk_id IN (SELECT id FROM memory_chunks WHERE character_id = ?)').run(characterId);
    const info = db.prepare('DELETE FROM memory_chunks WHERE character_id = ?').run(characterId);
    return { removed: info.changes };
  }
  db.prepare('DELETE FROM memory_fts').run();
  const info = db.prepare('DELETE FROM memory_chunks').run();
  return { removed: info.changes };
}

module.exports = {
  WINDOW,
  ingest,
  stats,
  listChunks,
  updateChunk,
  insertChunk,
  deleteChunk,
  clear,
  pendingMessages,
  bufferToVector,
  vectorToBuffer,
  countTokens,
  resetEmbedFailure,
};
