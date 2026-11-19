/**
 * 生图队列：让「画图」变成后台任务，不再卡住对话。
 *
 * 流程：模型决定画图 → 立刻插一条占位消息（attachments 里 status=pending）→
 * 对话照常结束 → 后台按角色排队出图 → 画好后把同一条消息的 attachments 换成真图。
 * 前端轮询占位消息的状态，拿到 done 就把占位替换成图片。
 *
 * 为什么排队而不是并发：中转的生图接口大多有并发限制，一次一张最稳，
 * 而且同一个角色同时蹦出三张图也没人看得过来。
 */
const image = require('./image');
const { db, now } = require('./db');

/** characterId -> { items: Job[], running: boolean } */
const queues = new Map();

function setAttachments(messageId, attachments) {
  db.prepare('UPDATE messages SET attachments = ? WHERE id = ?').run(JSON.stringify(attachments), messageId);
}

/**
 * 插入占位消息并排队。
 * @returns 占位消息（attachments[0].status = 'pending'）
 */
function enqueue({ characterId, prompt, provider, model }) {
  const placeholder = [{ type: 'image', status: 'pending', prompt }];
  const info = db
    .prepare(
      `INSERT INTO messages (character_id, role, content, kind, attachments, created_at)
       VALUES (?, 'assistant', ?, 'image', ?, ?)`,
    )
    .run(Number(characterId), prompt, JSON.stringify(placeholder), now());
  const messageId = Number(info.lastInsertRowid);

  const queue = queues.get(characterId) || { items: [], running: false };
  queue.items.push({ messageId, prompt, provider, model });
  queues.set(characterId, queue);
  if (!queue.running) void pump(characterId);

  return {
    id: messageId,
    character_id: Number(characterId),
    role: 'assistant',
    content: prompt,
    kind: 'image',
    attachments: placeholder,
    created_at: now(),
  };
}

async function pump(characterId) {
  const queue = queues.get(characterId);
  if (!queue || queue.running) return;
  queue.running = true;

  while (queue.items.length) {
    const job = queue.items.shift();
    try {
      const result = await image.generate({
        provider: job.provider,
        model: job.model,
        prompt: job.prompt,
      });
      setAttachments(job.messageId, [
        { type: 'image', status: 'done', prompt: job.prompt, url: result.url, bytes: result.bytes },
      ]);
    } catch (e) {
      console.warn('[image] 出图失败：', e.message);
      setAttachments(job.messageId, [
        { type: 'image', status: 'failed', prompt: job.prompt, error: e.message || '生成失败' },
      ]);
    }
  }

  queue.running = false;
}

/** 队列里还有几张在排（给前端显示「还有 2 张在画」这种提示） */
function pendingCount(characterId) {
  const q = queues.get(characterId);
  return q ? q.items.length + (q.running ? 1 : 0) : 0;
}

/**
 * 上次进程没跑完的占位：重启后没人会再去画，标成失败，
 * 免得前端一直转圈等一张永远不来的图。
 */
function failStalePlaceholders() {
  const rows = db
    .prepare("SELECT id, attachments FROM messages WHERE kind = 'image' ORDER BY id DESC LIMIT 300")
    .all();
  let fixed = 0;
  for (const row of rows) {
    let list;
    try {
      list = JSON.parse(row.attachments || '[]');
    } catch {
      continue;
    }
    if (!Array.isArray(list) || list[0]?.status !== 'pending') continue;
    setAttachments(row.id, [{ ...list[0], status: 'failed', error: '应用重启，这张没画完' }]);
    fixed += 1;
  }
  if (fixed) console.log(`[image] ${fixed} 张占位图标记为失败（重启前没画完）`);
  return fixed;
}

module.exports = { enqueue, pendingCount, failStalePlaceholders };
