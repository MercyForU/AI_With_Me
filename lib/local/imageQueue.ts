/**
 * 手机版的生图队列：和电脑端同构。
 * 差别只在存储——手机把图压成 data URL 塞进 attachments，不留文件。
 */
import { generateImage } from './image';
import { all, run } from './sqlite';
import { now } from './data';

type Job = { messageId: number; prompt: string; provider: any; model: string };

const queues = new Map<number, { items: Job[]; running: boolean }>();

async function setAttachments(messageId: number, attachments: unknown[]) {
  await run('UPDATE messages SET attachments = ? WHERE id = ?', [JSON.stringify(attachments), messageId]);
}

export async function enqueue({
  characterId,
  prompt,
  provider,
  model,
}: {
  characterId: number;
  prompt: string;
  provider: any;
  model: string;
}) {
  const placeholder = [{ type: 'image', status: 'pending', prompt }];
  const r = await run(
    `INSERT INTO messages (character_id, role, content, kind, attachments, created_at)
     VALUES (?, 'assistant', ?, 'image', ?, ?)`,
    [characterId, prompt, JSON.stringify(placeholder), now()],
  );
  const messageId = r.lastId;

  const queue = queues.get(characterId) || { items: [], running: false };
  queue.items.push({ messageId, prompt, provider, model });
  queues.set(characterId, queue);
  if (!queue.running) void pump(characterId);

  return {
    id: messageId,
    character_id: characterId,
    role: 'assistant',
    content: prompt,
    kind: 'image',
    attachments: placeholder,
    created_at: now(),
  };
}

async function pump(characterId: number) {
  const queue = queues.get(characterId);
  if (!queue || queue.running) return;
  queue.running = true;

  while (queue.items.length) {
    const job = queue.items.shift()!;
    try {
      const out = await generateImage(job.provider, job.model, job.prompt);
      await setAttachments(job.messageId, [
        { type: 'image', status: 'done', prompt: job.prompt, url: out.url, bytes: out.bytes },
      ]);
    } catch (e) {
      await setAttachments(job.messageId, [
        { type: 'image', status: 'failed', prompt: job.prompt, error: (e as Error).message || '生成失败' },
      ]);
    }
  }

  queue.running = false;
}

/** 上次没跑完的占位：重启后标成失败，免得前端一直转圈 */
export async function failStalePlaceholders() {
  const rows = await all<{ id: number; attachments: string | null }>(
    "SELECT id, attachments FROM messages WHERE kind = 'image' ORDER BY id DESC LIMIT 300",
  );
  for (const row of rows) {
    let list: any[] = [];
    try {
      list = JSON.parse(row.attachments || '[]');
    } catch {
      continue;
    }
    if (list[0]?.status !== 'pending') continue;
    await setAttachments(row.id, [{ ...list[0], status: 'failed', error: '应用重启，这张没画完' }]);
  }
}

/** 队列里还有几张（含正在画的那张） */
export function pendingCount(characterId: number) {
  const q = queues.get(characterId);
  return q ? q.items.length + (q.running ? 1 : 0) : 0;
}

export async function statusOf(ids: number[]) {
  if (!ids.length) return [];
  const rows = await all<{
    id: number;
    character_id: number;
    role: string;
    content: string;
    kind: string;
    attachments: string | null;
    created_at: string;
  }>(`SELECT * FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  return rows.map((r) => {
    let attachments: unknown[] = [];
    try {
      const parsed = JSON.parse(r.attachments || '[]');
      if (Array.isArray(parsed)) attachments = parsed;
    } catch {
      /* ignore */
    }
    return { ...r, attachments };
  });
}
