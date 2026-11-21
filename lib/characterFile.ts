import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import type { Attachment, Character, Memory, MemoryChunkItem, Message } from './types';
import { assetUrl } from './base';

/** 角色卡：人设 + 记忆（不含聊天记录） */
export const CARD_SPEC = 'nuan.character.v2';
/** 聊天记录：单独一份文件，导入时合并到某个角色 */
export const CHAT_SPEC = 'nuan.chat.v1';

export type CardFile = {
  spec: typeof CARD_SPEC;
  version: 2;
  exportedAt: string;
  character: {
    name: string;
    emoji: string;
    accent: string;
    tagline: string;
    personality: string;
    scenario: string;
    greeting: string;
    memory_note: string;
    model_id: string | null;
    model_label: string | null;
    relationship_level: number;
    affinity: number;
  };
  /** 手记：平时随手记下的要点 */
  memories: { content: string; kind: string; importance: number; created_at: string }[];
  /** 归档记忆：对话总结出来的那些 */
  archive: { content: string; source: string; created_at: string }[];
};

export type ChatFile = {
  spec: typeof CHAT_SPEC;
  version: 1;
  exportedAt: string;
  character: { name: string; emoji: string };
  messages: {
    role: 'user' | 'assistant';
    content: string;
    kind: string;
    created_at: string;
    attachments?: Attachment[];
  }[];
};

export function buildCardFile(
  character: Character,
  memories: Memory[],
  archive: MemoryChunkItem[],
): CardFile {
  return {
    spec: CARD_SPEC,
    version: 2,
    exportedAt: new Date().toISOString(),
    character: {
      name: character.name,
      emoji: character.emoji,
      accent: character.accent,
      tagline: character.tagline ?? '',
      personality: character.personality ?? '',
      scenario: character.scenario ?? '',
      greeting: character.greeting ?? '',
      memory_note: character.memory_note ?? '',
      // 供应商 id 是这台机器上的，导到别处大概率对不上，所以不带出去
      model_id: null,
      model_label: null,
      relationship_level: character.relationship_level,
      affinity: character.affinity,
    },
    memories: memories.map((m) => ({
      content: m.content,
      kind: m.kind,
      importance: m.importance,
      created_at: m.created_at,
    })),
    archive: archive.map((a) => ({
      content: a.content,
      source: a.source || 'chat',
      created_at: a.createdAt || '',
    })),
  };
}

export function buildChatFile(character: Character, messages: Message[]): ChatFile {
  return {
    spec: CHAT_SPEC,
    version: 1,
    exportedAt: new Date().toISOString(),
    character: { name: character.name, emoji: character.emoji },
    messages: messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .filter((m) => m.kind !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
        kind: m.kind,
        created_at: m.created_at,
        ...(m.attachments && m.attachments.length ? { attachments: m.attachments } : {}),
      })),
  };
}

const MAX_EMBED_IMAGES = 40;
const MAX_EMBED_BYTES = 40 * 1024 * 1024;

async function blobToDataUrl(blob: Blob): Promise<string> {
  // 不用 FileReader：它在部分运行环境里没有，arrayBuffer + btoa 到处都能跑
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(bin)}`;
}

/**
 * 把聊天里的图片内嵌成 data URL。
 *
 * 电脑端的图片是 `/uploads/chat/xxx.png`，只存了路径——导出到别的机器/手机上就是死链。
 * 这里在导出前把文件读成 base64 塞进 JSON，单个 .chat.json 才是自带的。
 * 有总量上限，超出的保留原路径（至少还能在本机看到）。
 */
export async function embedChatImages(
  file: ChatFile,
): Promise<{ count: number; truncated: boolean }> {
  let count = 0;
  let bytes = 0;

  for (const m of file.messages) {
    const list = m.attachments || [];
    for (const att of list) {
      if (att.type !== 'image' || !att.url || att.url.startsWith('data:')) continue;
      if (att.status === 'pending' || att.status === 'failed') continue;
      if (count >= MAX_EMBED_IMAGES || bytes >= MAX_EMBED_BYTES) {
        return { count, truncated: true };
      }
      try {
        const res = await fetch(assetUrl(att.url));
        if (!res.ok) continue;
        const blob = await res.blob();
        if (bytes + blob.size > MAX_EMBED_BYTES) return { count, truncated: true };
        att.url = await blobToDataUrl(blob);
        bytes += blob.size;
        count += 1;
      } catch {
        /* 单张失败就保留路径，不影响整体导出 */
      }
    }
  }

  return { count, truncated: false };
}

/** 读文件：只做格式校验，具体怎么导入交给调用方按 spec 分发 */
export function parseJsonFile(text: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('这不是有效的 JSON 文件');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('文件内容不是一个对象');
  }
  const obj = data as Record<string, unknown>;
  if (!obj.spec) throw new Error('这个文件不是本应用导出的');
  return obj;
}

export function safeFileName(name: string): string {
  return (name || 'character').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
}

/**
 * 存成真文件。
 * 手机端：先写进应用缓存目录，再唤起系统分享——存到「文件」、发微信、存网盘都行，
 * 拿到的是一个完整 .json，而不是一段剪贴板文本。
 */
export async function downloadJsonFile(
  data: unknown,
  baseName: string,
  suffix: string,
): Promise<'shared' | 'downloaded' | 'copied'> {
  const text = JSON.stringify(data, null, 2);
  const filename = `${safeFileName(baseName)}.${suffix}.json`;

  if (Capacitor.isNativePlatform()) {
    try {
      const saved = await Filesystem.writeFile({
        path: filename,
        data: text,
        directory: Directory.Cache,
        encoding: Encoding.UTF8,
      });
      await Share.share({ title: filename, url: saved.uri, dialogTitle: '保存或发送文件' });
      return 'shared';
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      // 用户在分享面板点了取消，不算失败
      if (/cancel/i.test(msg)) return 'shared';
      try {
        await navigator.clipboard.writeText(text);
        return 'copied';
      } catch {
        throw new Error('写文件失败，也没有剪贴板权限');
      }
    }
  }

  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return 'downloaded';
}
