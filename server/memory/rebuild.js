/**
 * 嵌入模型切换后的静默重建。
 *
 * 设计要点（与设计文档「vector_v2 影子列 + 原子切换」的差异说明）：
 * 检索时向量路本来就按 `embed_model = 当前模型` 过滤，所以「新旧向量混着比」这件事
 * 天然不会发生。既然如此，逐行就地改写（vector 与 embed_model 在同一条 UPDATE 里）
 * 比维护一份影子列更简单，也不会把向量存储翻倍：
 *
 *   - 每条 chunk 在任一时刻都是自洽的（要么旧模型 + 旧向量，要么新模型 + 新向量）
 *   - 已重建的块立刻参与向量检索，未重建的块退化为关键词检索 → 检索全程不中断
 *   - 进程中途被杀也不会留下脏数据，下次启动按状态续跑
 */
const { db, now } = require('../db');

const BATCH = 16; // 每批条数：太大阻塞事件循环，太小请求开销高
const DELAY_MS = 150; // 批间隔，让出事件循环（低优先级后台任务）
const MAX_ROUNDS = 20000; // 兜底，防止异常情况下死循环

let generation = 0;
let running = false;

function readRow() {
  return db.prepare('SELECT * FROM memory_rebuild WHERE id = 1').get() || null;
}

function ensureRow() {
  db.prepare(
    `INSERT OR IGNORE INTO memory_rebuild (id, target_model, total, status, started_at, updated_at, error)
     VALUES (1, '', 0, 'idle', NULL, ?, NULL)`,
  ).run(now());
}

/** 还差多少块没换成目标模型（含从未成功嵌入的块） */
function countPending(target) {
  return db
    .prepare(
      `SELECT COUNT(*) AS c FROM memory_chunks
        WHERE deleted_at IS NULL AND (embed_model IS NULL OR embed_model != ?)`,
    )
    .get(target).c;
}

function setState(patch) {
  const fields = Object.keys(patch);
  const sets = fields.map((f) => `${f} = ?`).join(', ');
  db.prepare(`UPDATE memory_rebuild SET ${sets}, updated_at = ? WHERE id = 1`).run(
    ...fields.map((f) => patch[f]),
    now(),
  );
}

/** 对外状态：pending 实时算，避免计数漂移 */
function status() {
  ensureRow();
  const row = readRow();
  const embedding = require('../embedding');
  const current = embedding.currentModelId();
  const pending = countPending(current);
  const total = row.total || 0;
  const done = Math.max(0, total - pending);

  // 状态自愈：进程被杀导致卡在 running，但实际已经没活了
  if (row.status === 'running' && !running && pending === 0) {
    setState({ status: 'done' });
  }

  const fresh = readRow();
  return {
    status: fresh.status,
    target: fresh.target_model || current,
    model: current,
    total,
    done: pending === 0 ? total : done,
    pending,
    error: fresh.error,
    startedAt: fresh.started_at,
    updatedAt: fresh.updated_at,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loop(gen, target) {
  const embedding = require('../embedding');

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (gen !== generation) return; // 被新的切换顶掉

    const rows = db
      .prepare(
        `SELECT id, embed_text, content FROM memory_chunks
          WHERE deleted_at IS NULL AND (embed_model IS NULL OR embed_model != ?)
          ORDER BY created_at ASC LIMIT ?`,
      )
      .all(target, BATCH);

    if (!rows.length) {
      setState({ status: 'done', error: null });
      running = false;
      return;
    }

    let vectors = null;
    try {
      vectors = await embedding.embed(rows.map((r) => r.embed_text || r.content));
    } catch (first) {
      // 一次重试：网络抖动不该让整个重建中止
      await sleep(800);
      if (gen !== generation) return;
      try {
        vectors = await embedding.embed(rows.map((r) => r.embed_text || r.content));
      } catch (e) {
        // 彻底失败：保持旧向量不动，只把状态置错，用户可以稍后重试
        setState({ status: 'error', error: e.message || String(first) });
        running = false;
        return;
      }
    }

    if (gen !== generation) return;

    const update = db.prepare(
      'UPDATE memory_chunks SET vector = ?, embed_model = ?, embed_dim = ?, embedded_at = ? WHERE id = ?',
    );
    const buf = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

    db.exec('BEGIN');
    try {
      rows.forEach((row, i) => {
        const vec = vectors[i];
        if (!vec) return;
        update.run(buf(vec), target, vec.length, now(), row.id);
      });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      setState({ status: 'error', error: `写库失败：${e.message}` });
      running = false;
      return;
    }

    setState({ status: 'running' });
    await sleep(DELAY_MS);
  }

  setState({ status: 'error', error: '重建轮次超出上限，已停止' });
  running = false;
}

/**
 * 开始重建到「当前嵌入模型」。重复调用会顶掉正在跑的任务。
 * 不 await：立刻返回，后台慢慢跑。
 */
function start(reason = 'switch') {
  ensureRow();
  const embedding = require('../embedding');

  // 切换模型后，之前「嵌入不可用」的粘性标记必须清掉，否则新模型永远不会被尝试
  try {
    require('./index').resetEmbedFailure();
    require('./search').resetEmbedFailure();
  } catch {
    /* 忽略 */
  }

  const target = embedding.currentModelId();
  const total = countPending(target);

  generation += 1;
  const gen = generation;
  running = total > 0;

  setState({
    target_model: target,
    total,
    status: total > 0 ? 'running' : 'done',
    started_at: now(),
    error: null,
  });

  if (total > 0) {
    loop(gen, target).catch((e) => {
      setState({ status: 'error', error: e.message });
      running = false;
    });
  }

  return { target, total, reason };
}

/** 进程重启后，如果上次没跑完就接着跑 */
function resume() {
  ensureRow();
  const row = readRow();
  if (!row || row.status !== 'running') return { resumed: false };

  const embedding = require('../embedding');
  const target = embedding.currentModelId();
  // 上次的目标模型和当前不一致（用户又切了），直接按当前模型重建
  const total = countPending(target);

  generation += 1;
  const gen = generation;
  running = total > 0;
  setState({
    target_model: target,
    total,
    status: total > 0 ? 'running' : 'done',
    started_at: now(),
    error: null,
  });
  if (total > 0) {
    loop(gen, target).catch((e) => {
      setState({ status: 'error', error: e.message });
      running = false;
    });
  }
  return { resumed: true, total };
}

module.exports = { start, status, resume, countPending };
