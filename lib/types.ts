export type Character = {
  id: number;
  owner_id?: string;
  name: string;
  emoji: string;
  accent: string;
  avatar_url?: string | null;
  tagline: string | null;
  personality: string | null;
  scenario: string | null;
  greeting: string | null;
  model_id: string | null;
  model_label: string | null;
  memory_note: string | null;
  relationship_level: number;
  affinity: number;
  archived: boolean;
  created_at: string;
  updated_at: string;
};

export type MessageRole = 'user' | 'assistant';
export type MessageKind = 'text' | 'game' | 'system' | 'error' | 'image';

export type Attachment = {
  type: 'image';
  url: string;
  bytes?: number;
};

export type Message = {
  id: number;
  character_id: number;
  role: MessageRole;
  content: string;
  kind: MessageKind;
  attachments?: Attachment[];
  created_at: string;
};

export type Memory = {
  id: number;
  character_id: number;
  content: string;
  kind: string;
  importance: number;
  created_at: string;
};

export type Post = {
  id: number;
  owner_name?: string | null;
  character_id: number | null;
  content: string;
  likes: number;
  liked: boolean;
  created_at: string;
};

export type GameRecord = {
  id: number;
  character_id: number;
  game_key: string;
  result: string;
  summary: string | null;
  created_at: string;
};

export type ModelOption = {
  key: string;
  providerId: number;
  providerLabel: string;
  providerType: string;
  id: string;
  name: string;
};

export type ProviderKind = 'chat' | 'embedding' | 'image' | 'tts' | 'stt';

export type Provider = {
  id: number;
  label: string;
  kind: ProviderKind;
  supportsVision: boolean;
  supportsTools: boolean;
  preferredModel: string;
  type: 'openai' | 'ollama';
  baseUrl: string;
  hasKey: boolean;
  models: string[];
  lastOk: number;
};

export type EmbeddingInfo = {
  source: 'builtin' | 'provider';
  id: string;
  label: string;
  dim: number | null;
  providerId?: number;
};

export type RebuildState = {
  status: 'idle' | 'running' | 'done' | 'error';
  target: string;
  model: string;
  total: number;
  done: number;
  pending: number;
  error: string | null;
  startedAt: string | null;
  updatedAt: string | null;
};

export type MemoryStats = {
  chunks: number;
  withVector: number;
  tokens: number;
  pending: number;
  model: string | null;
  window: number;
  rebuild?: RebuildState;
};

/** 一条归档的对话记忆块（可逐条编辑） */
export type MemoryChunkItem = {
  id: string;
  content: string;
  /** 归档前的对话原文（总结过才有，手动写的没有） */
  raw?: string | null;
  /** chat = 自动归档，manual = 用户写的，model = 模型写的 */
  source?: 'chat' | 'manual' | 'model' | string;
  createdAt?: string;
  tokens?: number;
  hasVector?: boolean;
  score?: number;
  vec?: number | null;
  keyword?: boolean;
};

export type CurrentModel = {
  providerId: number;
  providerLabel: string;
  model: string;
  hasModels: boolean;
} | null;

export type SessionUser = {
  id?: string;
  name?: string;
  avatarUrl?: string;
  email?: string;
  phone?: string;
};

export type Session = { user: SessionUser } | null;

export type CharacterDraft = {
  name: string;
  emoji: string;
  accent: string;
  avatar_url?: string | null;
  tagline: string;
  personality: string;
  scenario: string;
  greeting: string;
  memory_note: string;
  model_id: string | null;
  model_label: string | null;
};

export const ACCENTS: Record<string, { from: string; to: string }> = {
  violet: { from: '#8b5cf6', to: '#3b82f6' },
  amber: { from: '#f59e0b', to: '#ef4444' },
  mint: { from: '#10b981', to: '#0ea5e9' },
  rose: { from: '#f43f5e', to: '#a855f7' },
  slate: { from: '#64748b', to: '#334155' },
};

export const ACCENT_KEYS = Object.keys(ACCENTS);

export function accentGradient(accent: string | null | undefined): string {
  const a = ACCENTS[accent || 'violet'] || ACCENTS.violet;
  return `linear-gradient(135deg, ${a.from}, ${a.to})`;
}
