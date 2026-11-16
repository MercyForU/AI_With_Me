/**
 * 手机版的对话记忆：与电脑端同一套「分块 → 向量 + 关键词 → RRF 融合」。
 *
 * 向量用内置 bge-small-zh（onnxruntime-web / WASM）算，和电脑端是同一份权重。
 * 模型加载失败时自动降级为纯关键词检索，并在设置里如实显示，不会静默失效。
 */
import { all, run } from './sqlite';
import { insertMessage, now, type MessageRow } from './data';

export const WINDOW = 16;
const MAX_MSGS = 5;
const MAX_CHARS = 300;
const MIN_BATCH = 6;

const RRF_K = 60;
const POOL = 20;
const MIN_COS = 0.38;
const REL_CUT = 0.12;

let embedError: string | null = null;

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------- 向量序列化（base64 比 JSON 省一半空间） ----------
function vecToB64(v: Float32Array): string {
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64ToVec(s: string): Float32Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

async function embedTexts(texts: string[]): Promise<{ vectors: Float32Array[]; model: string | null }> {
  try {
    const m = await import('./embed');
    const vectors = await m.embed(texts);
    embedError = null;
    return { vectors, model: m.MODEL_ID };
  } catch (e) {
    embedError = (e as Error).message || '嵌入模型不可用';
    return { vectors: [], model: null };
  }
}

export function embeddingState() {
  return { error: embedError, degraded: Boolean(embedError) };
}

// ---------- 分块 ----------
export async function maxMessageId(characterId: number): Promise<number> {
  const row = await all<{ m: number | null }>('SELECT MAX(id) AS m FROM messages WHERE character_id = ?', [
    characterId,
  ]);
  return row[0]?.m || 0;
}

export async function lastChunkedId(characterId: number): Promise<number> {
  const row = await all<{ m: number | null }>('SELECT MAX(msg_to) AS m FROM memory_chunks WHERE character_id = ?', [
    characterId,
  ]);
  return row[0]?.m || 0;
}

export async function pendingMessages(characterId: number): Promise<MessageRow[]> {
  const maxId = await maxMessageId(characterId);
  const cutoff = maxId - WINDOW;
  if (cutoff <= 0) return [];
  const from = await lastChunkedId(characterId);
  if (cutoff <= from) return [];
  return all<MessageRow>(
    `SELECT * FROM messages
      WHERE character_id = ? AND id > ? AND id <= ?
        AND role IN ('user','assistant') AND kind IN ('text','game')
      ORDER BY id ASC`,
    [characterId, from, cutoff],
  );
}

type Chunk = {
  content: string;
  embedText: string;
  msgFrom: number;
  msgTo: number;
  tokenCount: number;
  hash: string;
  sessionId: string;
};

function renderGroup(group: MessageRow[], characterName: string) {
  const content = group
    .map((m) => {
      const who = m.role === 'user' ? '用户' : characterName || '角色';
      const text = m.kind === 'game' ? `（${m.content.replace(/^（|）$/g, '')}）` : m.content;
      return `[${dayLabel(m.created_at)}] ${who}：${text}`;
    })
    .join('\n');
  const embedText = group
    .map((m) => `${m.role === 'user' ? '用户' : characterName || '角色'}：${m.content}`)
    .join('\n');
  return { content, embedText };
}

function buildChunks(msgs: MessageRow[], characterName: string): Chunk[] {
  const out: Chunk[] = [];
  let group: MessageRow[] = [];
  let chars = 0;

  const flush = (force = false) => {
    if (!group.length) return;
    if (!force && group.length < 2) return;
    const { content, embedText } = renderGroup(group, characterName);
    out.push({
      content,
      embedText,
      msgFrom: group[0].id,
      msgTo: group[group.length - 1].id,
      tokenCount: Math.max(1, Math.round(chars / 2)),
      hash: hashText(content),
      sessionId: dayLabel(group[0].created_at).slice(0, 5),
    });
    group = group.slice(-1);
    chars = group.reduce((s, m) => s + m.content.length, 0);
  };

  for (const m of msgs) {
    group.push(m);
    chars += m.content.length;
    if (group.length >= MAX_MSGS || chars >= MAX_CHARS) flush();
  }
  flush(true);
  return out;
}

export async function ingest(characterId: number, characterName: string, force = false) {
  const msgs = await pendingMessages(characterId);
  if (!msgs.length) return { created: 0, skipped: 0 };
  if (!force && msgs.length < MIN_BATCH) return { created: 0, skipped: 0, waiting: MIN_BATCH - msgs.length };

  const chunks = buildChunks(msgs, characterName);
  const { vectors, model } = await embedTexts(chunks.map((c) => c.embedText));

  let created = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const vec = vectors[i] || null;
    const r = await run(
      `INSERT OR IGNORE INTO memory_chunks
        (id, character_id, session_id, content, embed_text, msg_from, msg_to, token_count, content_hash,
         embed_model, embed_dim, vector, embedded_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuid(),
        characterId,
        c.sessionId,
        c.content,
        c.embedText,
        c.msgFrom,
        c.msgTo,
        c.tokenCount,
        c.hash,
        vec ? model : null,
        vec ? vec.length : null,
        vec ? vecToB64(vec) : null,
        vec ? now() : null,
        now(),
      ],
    );
    created += r.changes;
  }
  return { created, skipped: chunks.length - created, embedded: vectors.length };
}

export async function stats(characterId?: number) {
  const where = characterId ? 'WHERE character_id = ?' : '';
  const args = characterId ? [characterId] : [];
  const total = (await all<{ c: number }>(`SELECT COUNT(*) AS c FROM memory_chunks ${where}`, args))[0].c;
  const withVector = (
    await all<{ c: number }>(
      `SELECT COUNT(*) AS c FROM memory_chunks ${where ? `${where} AND` : 'WHERE'} vector IS NOT NULL`,
      args,
    )
  )[0].c;
  const tokens = (
    await all<{ t: number }>(`SELECT COALESCE(SUM(token_count),0) AS t FROM memory_chunks ${where}`, args)
  )[0].t;
  const pending = characterId ? (await pendingMessages(characterId)).length : 0;
  const model =
    (await all<{ m: string | null }>(`SELECT embed_model AS m FROM memory_chunks ${where} LIMIT 1`, args))[0]?.m ||
    null;
  return { chunks: total, withVector, tokens, pending, model };
}

export async function clear(characterId?: number) {
  if (characterId) {
    const r = await run('DELETE FROM memory_chunks WHERE character_id = ?', [characterId]);
    return { removed: r.changes };
  }
  const r = await run('DELETE FROM memory_chunks');
  return { removed: r.changes };
}

/** 记忆块列表（按时间倒序分页）：给「逐条查看 / 编辑」用 */
export async function listChunks(characterId: number, limit = 20, offset = 0) {
  const take = Math.min(100, Math.max(1, limit));
  const skip = Math.max(0, offset);
  const total =
    (
      await all<{ c: number }>(
        'SELECT COUNT(*) AS c FROM memory_chunks WHERE character_id = ? AND deleted_at IS NULL',
        [characterId],
      )
    )[0]?.c || 0;
  const rows = await all<{
    id: string;
    content: string;
    created_at: string;
    token_count: number;
    has_vector: number;
  }>(
    `SELECT id, content, created_at, token_count, (vector IS NOT NULL) AS has_vector
       FROM memory_chunks
      WHERE character_id = ? AND deleted_at IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?`,
    [characterId, take, skip],
  );
  return {
    items: rows.map((r) => ({
      id: r.id,
      content: r.content,
      createdAt: r.created_at,
      tokens: r.token_count,
      hasVector: Boolean(r.has_vector),
    })),
    total,
  };
}

/**
 * 改写一条记忆：内容与向量一起更新。
 * 嵌入不可用时清掉旧向量，避免留下和内容不符的向量。
 */
export async function updateChunk(id: string, content: string) {
  const text = String(content || '').trim().slice(0, 2000);
  if (!text) throw new Error('记忆内容不能为空');
  const rows = await all<{ id: string }>('SELECT id FROM memory_chunks WHERE id = ?', [id]);
  if (!rows.length) throw new Error('这条记忆不存在了，刷新看看');

  const { vectors, model } = await embedTexts([text]);
  const vec = vectors[0] || null;

  await run(
    `UPDATE memory_chunks
        SET content = ?, embed_text = ?, content_hash = ?, token_count = ?,
            embed_model = ?, embed_dim = ?, vector = ?, embedded_at = ?
      WHERE id = ?`,
    [
      text,
      text,
      `${hashText(`${text}|${id}`)}-${text.length}`,
      Math.max(1, Math.round(text.length / 2)),
      vec ? model : null,
      vec ? vec.length : null,
      vec ? vecToB64(vec) : null,
      vec ? now() : null,
      id,
    ],
  );

  return { id, content: text, embedded: Boolean(vec) };
}

// ---------- 召回 ----------
function bigrams(text: string): string[] {
  const clean = text.replace(/[\s，。！？、,.!?~～"「」《》()（）]/g, '');
  const out: string[] = [];
  for (let i = 0; i < clean.length - 1; i++) out.push(clean.slice(i, i + 2));
  for (const w of text.match(/[a-zA-Z0-9_]+/g) || []) if (w.length >= 2) out.push(w.toLowerCase());
  return out;
}

export type RecallHit = {
  id: string;
  content: string;
  createdAt: string;
  score: number;
  vec: number | null;
  keyword: boolean;
};

type Scored = { id: string; content: string; createdAt: string; score: number };

export async function recall(characterId: number, query: string, opts: { topK?: number } = {}) {
  const t0 = Date.now();
  const topK = opts.topK || 6;
  const text = String(query || '').trim();
  if (!text || !characterId) {
    return { items: [] as RecallHit[], debug: { vector: 0, keyword: 0, ms: 0, mode: 'empty' } };
  }

  const rows = await all<{
    id: string;
    content: string;
    created_at: string;
    vector: string | null;
    embed_model: string | null;
  }>(
    'SELECT id, content, created_at, vector, embed_model FROM memory_chunks WHERE character_id = ? AND deleted_at IS NULL',
    [characterId],
  );

  // 向量路：只比对同一个模型算出来的向量
  let vecHits: Scored[] = [];
  let mode = 'keyword-only';
  const { vectors, model } = await embedTexts([text]);
  if (vectors.length && model) {
    const qv = vectors[0];
    mode = 'hybrid';
    vecHits = rows
      .filter((r) => r.vector && r.embed_model === model)
      .map((r) => {
        const v = b64ToVec(r.vector as string);
        if (v.length !== qv.length) return null;
        let dot = 0;
        for (let i = 0; i < v.length; i++) dot += v[i] * qv[i];
        return { id: r.id, content: r.content, createdAt: r.created_at, score: dot } as Scored;
      })
      .filter((x): x is Scored => x !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, POOL);
  }

  // 关键词路（中文按二元组切）
  const grams = [...new Set(bigrams(text))];
  const nowMs = Date.now();
  const kwHits: Scored[] = grams.length
    ? rows
        .map((r) => {
          const hay = r.content.toLowerCase();
          let hit = 0;
          for (const g of grams) if (hay.includes(g)) hit += 1;
          const base = hit / grams.length;
          const ageDays = Math.max(0, (nowMs - new Date(r.created_at).getTime()) / 86400000);
          const decay = 1 / (1 + ageDays / 120);
          return { id: r.id, content: r.content, createdAt: r.created_at, score: base * 0.85 + base * decay * 0.15 };
        })
        .filter((x) => x.score >= 0.25)
        .sort((a, b) => b.score - a.score)
        .slice(0, POOL)
    : [];

  // RRF 融合
  const merged = new Map<string, RecallHit>();
  const add = (hit: Scored, rank: number, src: 'v' | 'k') => {
    const cur =
      merged.get(hit.id) || {
        id: hit.id,
        content: hit.content,
        createdAt: hit.createdAt,
        score: 0,
        vec: null as number | null,
        keyword: false,
      };
    cur.score += 1 / (RRF_K + rank + 1);
    if (src === 'v') cur.vec = hit.score;
    if (src === 'k') cur.keyword = true;
    merged.set(hit.id, cur);
  };
  vecHits.forEach((h, i) => add(h, i, 'v'));
  kwHits.forEach((h, i) => add(h, i, 'k'));

  const bestVec = Math.max(0, ...vecHits.map((h) => h.score));
  const items = [...merged.values()]
    .filter((it) => it.keyword || (it.vec !== null && it.vec >= MIN_COS && it.vec >= bestVec - REL_CUT))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return { items, debug: { vector: vecHits.length, keyword: kwHits.length, ms: Date.now() - t0, mode } };
}

export async function recallForPrompt(characterId: number, query: string, budgetTokens = 600) {
  const { items, debug } = await recall(characterId, query, { topK: 8 });
  const picked: RecallHit[] = [];
  let used = 0;
  for (const it of items) {
    const cost = Math.round(it.content.length / 2);
    if (used + cost > budgetTokens) break;
    picked.push(it);
    used += cost;
  }
  return { items: picked, tokens: used, debug };
}

export async function rememberGame(characterId: number, summary: string) {
  await run('INSERT INTO memories (character_id, content, kind, importance, created_at) VALUES (?, ?, ?, ?, ?)', [
    characterId,
    `和用户玩石头剪刀布：${summary}`,
    'fact',
    2,
    now(),
  ]);
}

export { insertMessage };
