/**
 * 手机版的对话记忆：与电脑端同一套「分块 → 向量 + 关键词 → RRF 融合」。
 *
 * 向量用内置 bge-small-zh（onnxruntime-web / WASM）算，和电脑端是同一份权重。
 * 模型加载失败时自动降级为纯关键词检索，并在设置里如实显示，不会静默失效。
 */
import { all, run } from './sqlite';
import { currentModel, insertMessage, now, rawProvider, type MessageRow } from './data';
import { chatOnce } from './llm';

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

// ---------- 归档前总结 ----------
const SUMMARY_SYSTEM = [
  '你在为一段陪伴式聊天整理长期记忆，供以后回忆时使用。',
  '把下面这段对话压缩成 1-3 句中文陈述，只保留以后可能用得到的信息：',
  '人物的近况、时间与计划、偏好与口味、承诺与约定、情绪转折、关系进展。',
  '要求：',
  '1. 用第三人称陈述，用户统一称「对方」，角色用自己的名字；',
  '2. 不要写「用户说」「角色回答」这类过程描述，直接写事实；',
  '3. 不要编造，原文没提的不要补；',
  '4. 只输出记忆本身，不要前缀、编号、解释或引号。',
].join('\n');

async function resolveChatProvider() {
  const cur = await currentModel();
  if (!cur) return null;
  const row = await rawProvider(cur.providerId);
  if (!row) return null;
  const config = {
    type: (row.type === 'ollama' ? 'ollama' : 'openai') as 'openai' | 'ollama',
    baseUrl: row.base_url,
    apiKey: row.api_key,
    supportsTools: !!row.supports_tools,
  };
  if (config.type === 'openai' && !config.apiKey) return null;
  return { config, model: cur.model };
}

/** 把一段原文压成记忆陈述；不可用时返回 null，调用方回退原文 */
async function summarizeChunk(raw: string, characterName: string): Promise<string | null> {
  const text = String(raw || '').trim();
  if (text.length < 60) return null;
  const resolved = await resolveChatProvider();
  if (!resolved) return null;
  try {
    const out = await chatOnce({
      provider: resolved.config,
      model: resolved.model,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: `角色：${characterName || '角色'}\n\n对话原文：\n${text}` },
      ],
    });
    const clean = String(out.text || '')
      .replace(/^["'「『]|["'」』]$/g, '')
      .replace(/^\s*[-*\d.、]+/, '')
      .trim();
    if (clean.length < 8 || clean.length > 600) return null;
    return clean;
  } catch {
    return null;
  }
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

export async function pendingMessages(
  characterId: number,
  opts: { flush?: boolean } = {},
): Promise<MessageRow[]> {
  const maxId = await maxMessageId(characterId);
  // flush = 清空上下文前，把还没滑出窗口的也一起归档
  const cutoff = opts.flush ? maxId : maxId - WINDOW;
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

export async function ingest(
  characterId: number,
  characterName: string,
  opts: { force?: boolean; flush?: boolean } = {},
) {
  const msgs = await pendingMessages(characterId, { flush: opts.flush });
  if (!msgs.length) return { created: 0, skipped: 0 };
  if (!opts.force && !opts.flush && msgs.length < MIN_BATCH) {
    return { created: 0, skipped: 0, waiting: MIN_BATCH - msgs.length };
  }

  const chunks = buildChunks(msgs, characterName);

  // 先总结再入库：摘要当 content，原文进 raw_content；模型不可用时按原文存
  const MAX_SUMMARIZE = 4;
  const prepared: Array<Chunk & { raw: string | null }> = [];
  let summarized = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const summary = i < MAX_SUMMARIZE ? await summarizeChunk(c.content, characterName) : null;
    if (summary) summarized += 1;
    prepared.push({
      ...c,
      content: summary || c.content,
      embedText: summary || c.embedText,
      raw: summary ? c.content : null,
    });
  }

  const { vectors, model } = await embedTexts(prepared.map((c) => c.embedText));

  let created = 0;
  for (let i = 0; i < prepared.length; i++) {
    const c = prepared[i];
    const vec = vectors[i] || null;
    const r = await run(
      `INSERT OR IGNORE INTO memory_chunks
        (id, character_id, session_id, content, embed_text, msg_from, msg_to, token_count, content_hash,
         embed_model, embed_dim, vector, embedded_at, created_at, raw_content, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'chat')`,
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
        c.raw,
      ],
    );
    created += r.changes;
  }
  return { created, skipped: prepared.length - created, embedded: vectors.length, summarized };
}

/** 直接写一条记忆（用户手动添加 / 模型调用 memory_write） */
export async function insertChunk(
  characterId: number,
  content: string,
  opts: { source?: string } = {},
) {
  const text = String(content || '').trim().slice(0, 2000);
  if (!text) throw new Error('记忆内容不能为空');
  const { vectors, model } = await embedTexts([text]);
  const vec = vectors[0] || null;
  const id = uuid();
  await run(
    `INSERT INTO memory_chunks
      (id, character_id, session_id, content, embed_text, msg_from, msg_to, token_count, content_hash,
       embed_model, embed_dim, vector, embedded_at, created_at, raw_content, source)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    [
      id,
      characterId,
      new Date().toISOString().slice(0, 10),
      text,
      text,
      Math.max(1, Math.round(text.length / 2)),
      `${hashText(`${text}|${id}`)}-${text.length}`,
      vec ? model : null,
      vec ? vec.length : null,
      vec ? vecToB64(vec) : null,
      vec ? now() : null,
      now(),
      ['model', 'game', 'post', 'chat'].includes(opts.source || '') ? opts.source! : 'manual',
    ],
  );
  return { id, content: text, embedded: Boolean(vec) };
}

export async function deleteChunk(id: string) {
  const rows = await all<{ id: string }>('SELECT id FROM memory_chunks WHERE id = ?', [id]);
  if (!rows.length) throw new Error('这条记忆不存在了');
  await run('DELETE FROM memory_chunks WHERE id = ?', [id]);
  return { id, removed: 1 };
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
    raw_content: string | null;
    source: string | null;
    created_at: string;
    token_count: number;
    has_vector: number;
  }>(
    `SELECT id, content, raw_content, source, created_at, token_count, (vector IS NOT NULL) AS has_vector
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

export async function recall(
  characterId: number,
  query: string,
  opts: { topK?: number; relax?: boolean } = {},
) {
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
  // 回忆类提问放宽阈值：这类问题靠时间线，不靠字面相似度
  const minCos = opts.relax ? 0.3 : MIN_COS;
  const relCut = opts.relax ? 0.2 : REL_CUT;
  const items = [...merged.values()]
    .filter((it) => it.keyword || (it.vec !== null && it.vec >= minCos && it.vec >= bestVec - relCut))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return { items, debug: { vector: vecHits.length, keyword: kwHits.length, ms: Date.now() - t0, mode } };
}

// 用户明确在翻旧账时放宽召回，并允许用最近记忆兜底
const RECALL_WORDS =
  /(之前|以前|上次|上回|上一回|那次|那天|当时|当年|昨天|前天|前几天|前些天|前阵子|上周|上个星期|上个月|去年|小时候|记得|还记得|回忆|想起来|想起|说过|答应过|提过|刚刚|刚才|最近|这些天|一直以来)/;

export function wantsRecall(text: string) {
  return RECALL_WORDS.test(String(text || ''));
}

const MIN_ITEMS = 5;
const MAX_ITEMS = 10;

export async function recallForPrompt(
  characterId: number,
  query: string,
  budgetTokens = 900,
  opts: { relax?: boolean } = {},
) {
  const { items, debug } = await recall(characterId, query, { topK: MAX_ITEMS, relax: opts.relax });
  const picked: RecallHit[] = [];
  let used = 0;
  for (const it of items) {
    const cost = Math.round(it.content.length / 2);
    if (used + cost > budgetTokens && picked.length >= MIN_ITEMS) break;
    if (picked.length >= MAX_ITEMS) break;
    picked.push(it);
    used += cost;
  }

  // 明确在回忆却没凑够：拿最近的记忆补上
  if (opts.relax && picked.length < MIN_ITEMS) {
    const have = new Set(picked.map((p) => p.id));
    const recent = await all<{ id: string; content: string; created_at: string }>(
      `SELECT id, content, created_at FROM memory_chunks
        WHERE character_id = ? AND deleted_at IS NULL
        ORDER BY created_at DESC, id DESC LIMIT ?`,
      [characterId, MIN_ITEMS * 2],
    );
    for (const r of recent) {
      if (picked.length >= MIN_ITEMS) break;
      if (have.has(r.id)) continue;
      picked.push({ id: r.id, content: r.content, createdAt: r.created_at, score: 0, vec: null, keyword: false });
    }
  }

  return { items: picked, tokens: used, debug };
}

// ---------- 暴露给聊天模型的记忆工具 ----------
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'memory_search',
      description:
        '翻找你们过去的记忆。当对方提到以前的事、你说不清或需要确认细节时调用。不要每句话都调。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '想找什么，用一句话描述' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_write',
      description:
        '把值得长期记住的事写进记忆：对方的计划、重要的人和事、明确的偏好与底线、你们的约定。寒暄不要写。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '一条中文陈述，第三人称，用「对方」指代用户，1-2 句' },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_update',
      description: '修正一条记错或过时的记忆。需要先用 memory_search 拿到它的 id。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '记忆 id，来自 memory_search 结果' },
          content: { type: 'string', description: '修正后的完整内容' },
        },
        required: ['id', 'content'],
      },
    },
  },
];

const TOOL_NAMES = new Set(TOOLS.map((t) => t.function.name));

export function isMemoryTool(name: string) {
  return TOOL_NAMES.has(name);
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseArgs(raw: string | Record<string, unknown>) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function runTool(name: string, rawArgs: string, characterId: number) {
  const args = parseArgs(rawArgs);

  if (name === 'memory_search') {
    const query = String(args.query || '').trim();
    if (!query) return { text: '没有提供要查找的内容。' };
    const { items } = await recall(characterId, query, { topK: 6, relax: true });
    if (!items.length) return { text: '记忆里没有和这个相关的内容。' };
    return {
      text: items.map((it) => `[${it.id}] ${fmtDate(it.createdAt)} ${it.content}`).join('\n'),
      items: items.map((it) => ({ id: it.id, content: it.content })),
    };
  }

  if (name === 'memory_write') {
    const content = String(args.content || '').trim();
    if (!content) return { text: '没有提供要记住的内容。' };
    const r = await insertChunk(characterId, content, { source: 'model' });
    return { text: `已记住（id: ${r.id}）。`, items: [{ id: r.id, content: r.content }] };
  }

  if (name === 'memory_update') {
    const id = String(args.id || '').trim();
    const content = String(args.content || '').trim();
    if (!id || !content) return { text: '缺少 id 或内容。' };
    try {
      const r = await updateChunk(id, content);
      return { text: `已更新（id: ${r.id}）。`, items: [{ id: r.id, content: r.content }] };
    } catch (e) {
      return { text: `更新失败：${(e as Error).message}` };
    }
  }

  return { text: `不认识这个工具：${name}` };
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
