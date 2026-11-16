/**
 * 召回：向量路 + 关键词路，RRF(k=60) 融合。
 *
 * - 向量路只比对 embed_model = 当前模型 的块（重建期间旧向量不参与，避免跨模型比较）
 * - 关键词路用 FTS5 trigram；查询短于 3 字时 trigram 不命中，退化为 LIKE
 * - 两条路都限定 character_id，杜绝跨角色串味
 */
const { db } = require('../db');
const { bufferToVector, countTokens } = require('./index');

const RRF_K = 60;
const POOL = 20;

let embedFailed = false;

function resetEmbedFailure() {
  embedFailed = false;
}

async function embedQuery(text) {
  if (embedFailed) return null;
  try {
    const embedding = require('../embedding');
    const [vec] = await embedding.embed([text]);
    return { vec, model: embedding.currentModelId() };
  } catch (e) {
    embedFailed = true;
    console.warn('[memory] 查询向量失败，降级为仅关键词检索：', e.message);
    return null;
  }
}

function vectorCandidates(characterId, qvec, model) {
  const rows = db
    .prepare(
      `SELECT id, content, vector, created_at FROM memory_chunks
        WHERE character_id = ? AND embed_model = ? AND vector IS NOT NULL AND deleted_at IS NULL`,
    )
    .all(characterId, model);

  const scored = [];
  for (const row of rows) {
    const vec = bufferToVector(row.vector);
    if (vec.length !== qvec.length) continue;
    let dot = 0;
    for (let i = 0; i < vec.length; i++) dot += vec[i] * qvec[i];
    scored.push({ id: row.id, content: row.content, createdAt: row.created_at, score: dot });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, POOL);
}

function keywordCandidates(characterId, query) {
  const clean = String(query || '').replace(/["']/g, ' ').trim();
  if (!clean) return [];

  if (clean.length >= 3) {
    try {
      const rows = db
        .prepare(
          `SELECT c.id, c.content, c.created_at, bm25(memory_fts) AS rank
             FROM memory_fts f JOIN memory_chunks c ON c.id = f.chunk_id
            WHERE memory_fts MATCH ? AND c.character_id = ? AND c.deleted_at IS NULL
            ORDER BY rank LIMIT ?`,
        )
        .all(`"${clean}"`, characterId, POOL);
      if (rows.length) {
        return rows.map((r) => ({ id: r.id, content: r.content, createdAt: r.created_at }));
      }
    } catch {
      /* 查询语法异常时走 LIKE */
    }
  }

  const rows = db
    .prepare(
      `SELECT id, content, created_at FROM memory_chunks
        WHERE character_id = ? AND deleted_at IS NULL AND content LIKE ?
        ORDER BY id DESC LIMIT ?`,
    )
    .all(characterId, `%${clean}%`, POOL);
  return rows.map((r) => ({ id: r.id, content: r.content, createdAt: r.created_at }));
}

/**
 * @returns {{ items: Array, debug: { vector:number, keyword:number, ms:number, mode:string } }}
 */
async function recall(characterId, query, opts = {}) {
  const t0 = Date.now();
  const topK = opts.topK || 6;
  const text = String(query || '').trim();
  if (!text || !characterId) {
    return { items: [], debug: { vector: 0, keyword: 0, ms: 0, mode: 'empty' } };
  }

  const q = await embedQuery(text);
  const vecHits = q ? vectorCandidates(characterId, q.vec, q.model) : [];
  const kwHits = keywordCandidates(characterId, text);

  const merged = new Map();
  const add = (hit, rank, source) => {
    const cur = merged.get(hit.id) || {
      id: hit.id,
      content: hit.content,
      createdAt: hit.createdAt,
      score: 0,
      vec: null,
      keyword: false,
    };
    cur.score += 1 / (RRF_K + rank + 1);
    if (source === 'v') cur.vec = hit.score;
    if (source === 'k') cur.keyword = true;
    merged.set(hit.id, cur);
  };
  vecHits.forEach((h, i) => add(h, i, 'v'));
  kwHits.forEach((h, i) => add(h, i, 'k'));

  // bge-small-zh 在短中文上的绝对相似度普遍偏低（0.3–0.6），
  // 所以用「绝对下限 + 相对头名」双重过滤，避免沾边就注入
  const MIN_COS = 0.38;
  const REL_CUT = 0.12;
  const bestVec = Math.max(0, ...vecHits.map((h) => h.score));
  const items = [...merged.values()]
    .filter(
      (it) =>
        it.keyword ||
        (it.vec !== null && it.vec >= MIN_COS && it.vec >= bestVec - REL_CUT),
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return {
    items,
    debug: {
      vector: vecHits.length,
      keyword: kwHits.length,
      ms: Date.now() - t0,
      mode: q ? 'hybrid' : 'keyword-only',
    },
  };
}

/** 按 token 预算裁剪，供注入 system prompt */
async function recallForPrompt(characterId, query, budgetTokens = 600) {
  const { items, debug } = await recall(characterId, query, { topK: 8 });
  const picked = [];
  let used = 0;
  for (const item of items) {
    const cost = countTokens(item.content);
    if (used + cost > budgetTokens) break;
    picked.push(item);
    used += cost;
  }
  return { items: picked, tokens: used, debug };
}

module.exports = { recall, recallForPrompt, resetEmbedFailure };
