import type { Character, CharacterDraft, GameRecord, Memory, Message } from './types';

export const CARD_SPEC = 'nuan.character.v1';

export type CardFile = {
  spec: typeof CARD_SPEC;
  version: 1;
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
  memories: { content: string; kind: string; importance: number; created_at: string }[];
  messages: { role: 'user' | 'assistant'; content: string; kind: string; created_at: string }[];
  games: { game_key: string; result: string; summary: string | null; created_at: string }[];
};

export function buildCardFile(
  character: Character,
  memories: Memory[],
  messages: Message[],
  games: GameRecord[],
): CardFile {
  return {
    spec: CARD_SPEC,
    version: 1,
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
      model_id: character.model_id,
      model_label: character.model_label,
      relationship_level: character.relationship_level,
      affinity: character.affinity,
    },
    memories: memories.map((m) => ({
      content: m.content,
      kind: m.kind,
      importance: m.importance,
      created_at: m.created_at,
    })),
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
      kind: m.kind,
      created_at: m.created_at,
    })),
    games: games.map((g) => ({
      game_key: g.game_key,
      result: g.result,
      summary: g.summary,
      created_at: g.created_at,
    })),
  };
}

export function safeFileName(name: string): string {
  return (name || 'character').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
}

export async function downloadCard(file: CardFile, name: string): Promise<'downloaded' | 'shared' | 'copied'> {
  const text = JSON.stringify(file, null, 2);
  const filename = `${safeFileName(name)}.character.json`;

  // 手机版（WebView）里 a[download] 不生效，依次尝试系统分享、复制到剪贴板
  const native = typeof window !== 'undefined' &&
    Boolean((window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.());
  if (native) {
    try {
      const nav = navigator as Navigator & {
        canShare?: (d: { files?: File[] }) => boolean;
        share?: (d: { files?: File[]; title?: string; text?: string }) => Promise<void>;
      };
      if (nav.share && nav.canShare) {
        const f = new File([text], filename, { type: 'application/json' });
        if (nav.canShare({ files: [f] })) {
          await nav.share({ files: [f], title: filename });
          return 'shared';
        }
      }
    } catch {
      /* 用户取消分享也走复制 */
    }
    try {
      await navigator.clipboard.writeText(text);
      return 'copied';
    } catch {
      return 'downloaded';
    }
  }

  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return 'downloaded';
}

export type ParsedCard = {
  draft: CharacterDraft;
  memories: { content: string; kind: string; importance: number }[];
  messages: { role: 'user' | 'assistant'; content: string; kind: string }[];
  games: { game_key: string; result: string; summary: string | null }[];
};

type Loose = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * 宽容解析：
 * 1) 本产品标准文件（nuan.character.v1）
 * 2) Character Card V2 / V3（chara_card_v2 / v3）
 * 3) 扁平 { name, personality, ... } 对象
 */
export function parseCardFile(text: string): ParsedCard {
  let raw: Loose;
  try {
    raw = JSON.parse(text) as Loose;
  } catch {
    throw new Error('文件不是合法的 JSON');
  }
  if (!raw || typeof raw !== 'object') throw new Error('文件内容无法识别');

  const emptyExtras = { memories: [], messages: [], games: [] };

  if (raw.spec === CARD_SPEC && raw.character && typeof raw.character === 'object') {
    const c = raw.character as Loose;
    if (!str(c.name).trim()) throw new Error('角色文件缺少名称');
    return {
      draft: {
        name: str(c.name).slice(0, 40),
        emoji: str(c.emoji) || '🌙',
        accent: str(c.accent) || 'violet',
        tagline: str(c.tagline),
        personality: str(c.personality),
        scenario: str(c.scenario),
        greeting: str(c.greeting),
        memory_note: str(c.memory_note),
        model_id: null,
        model_label: null,
      },
      memories: Array.isArray(raw.memories)
        ? (raw.memories as Loose[]).map((m) => ({
            content: str(m.content),
            kind: str(m.kind) || 'fact',
            importance: Number(m.importance) || 1,
          })).filter((m) => m.content)
        : [],
      messages: Array.isArray(raw.messages)
        ? (raw.messages as Loose[])
            .map((m) => ({
              role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
              content: str(m.content),
              kind: str(m.kind) || 'text',
            }))
            .filter((m) => m.content)
        : [],
      games: Array.isArray(raw.games)
        ? (raw.games as Loose[]).map((g) => ({
            game_key: str(g.game_key) || 'rps',
            result: str(g.result) || 'draw',
            summary: str(g.summary) || null,
          }))
        : [],
    };
  }

  // Character Card V2 / V3
  const data = (raw.data && typeof raw.data === 'object' ? raw.data : raw) as Loose;
  const name = str(data.name) || str(data.char_name);
  if (!name.trim()) throw new Error('角色文件缺少名称');
  const description = str(data.description);
  const personality = str(data.personality);
  const scenario = str(data.scenario);
  return {
    draft: {
      name: name.slice(0, 40),
      emoji: '🌙',
      accent: 'violet',
      tagline: description.slice(0, 40),
      personality: [personality, description].filter(Boolean).join('\n\n'),
      scenario,
      greeting: str(data.first_mes) || str(data.greeting),
      memory_note: '',
      model_id: null,
      model_label: null,
    },
    ...emptyExtras,
  };
}
