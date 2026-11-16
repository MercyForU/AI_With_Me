/**
 * 手机版的数据访问：角色 / 消息 / 记忆 / 对局 / 动态 / 供应商 / 设置。
 * 字段与电脑端一致，逻辑照搬 server/api.js 与 server/providers.js。
 */
import { all, get, run } from './sqlite';

export function now(): string {
  return new Date().toISOString();
}

export function str(v: unknown, max = 4000): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

// ---------- 设置 ----------
export async function getSetting(key: string, fallback = ''): Promise<string> {
  const row = await get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  return row?.value ?? fallback;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
}

// ---------- 角色 ----------
export const CHAR_COLS =
  'id, name, emoji, accent, avatar_url, tagline, personality, scenario, greeting, model_id, model_label, memory_note, relationship_level, affinity, archived, created_at, updated_at';

export type CharacterRow = {
  id: number;
  name: string;
  emoji: string;
  accent: string;
  avatar_url: string | null;
  tagline: string | null;
  personality: string | null;
  scenario: string | null;
  greeting: string | null;
  model_id: string | null;
  model_label: string | null;
  memory_note: string | null;
  relationship_level: number;
  affinity: number;
  archived: number;
  created_at: string;
  updated_at: string;
};

export function getCharacter(id: number) {
  return get<CharacterRow>(`SELECT ${CHAR_COLS} FROM characters WHERE id = ?`, [Number(id)]);
}

export function listCharacters() {
  return all<CharacterRow>(`SELECT ${CHAR_COLS} FROM characters WHERE archived = 0 ORDER BY id ASC`);
}

export async function createCharacter(body: Record<string, unknown>): Promise<CharacterRow> {
  const name = str(body.name, 40).trim();
  if (!name) throw new Error('角色需要一个名字');
  const t = now();
  const r = await run(
    `INSERT INTO characters
      (name, emoji, accent, avatar_url, tagline, personality, scenario, greeting, model_id, model_label, memory_note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      str(body.emoji, 8) || '🌙',
      str(body.accent, 16) || 'violet',
      str(body.avatar_url, 3000) || null,
      str(body.tagline, 120) || null,
      str(body.personality, 4000) || null,
      str(body.scenario, 2000) || null,
      str(body.greeting, 500) || null,
      str(body.model_id, 200) || null,
      str(body.model_label, 200) || null,
      str(body.memory_note, 1000) || null,
      t,
      t,
    ],
  );
  const id = r.lastId;
  if (body.greeting) await insertMessage(id, 'assistant', str(body.greeting, 500), 'text');
  const created = await getCharacter(id);
  if (!created) throw new Error('创建角色失败');
  return created;
}

const CHAR_FIELDS = [
  'name',
  'emoji',
  'accent',
  'avatar_url',
  'tagline',
  'personality',
  'scenario',
  'greeting',
  'model_id',
  'model_label',
  'memory_note',
  'relationship_level',
  'affinity',
  'archived',
];

export async function updateCharacter(id: number, body: Record<string, unknown>) {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of CHAR_FIELDS) {
    if (!(key in body)) continue;
    sets.push(`${key} = ?`);
    if (key === 'archived') values.push(body[key] ? 1 : 0);
    else if (key === 'relationship_level' || key === 'affinity') values.push(Number(body[key]) || 0);
    else values.push(typeof body[key] === 'string' ? (body[key] as string).slice(0, 4000) : body[key]);
  }
  if (sets.length) {
    sets.push('updated_at = ?');
    values.push(now(), Number(id));
    await run(`UPDATE characters SET ${sets.join(', ')} WHERE id = ?`, values);
  }
  return getCharacter(id);
}

// ---------- 消息 ----------
export type MessageRow = {
  id: number;
  character_id: number;
  role: string;
  content: string;
  kind: string;
  attachments?: string | null;
  created_at: string;
};

export function mapMessage(row: MessageRow) {
  let attachments: unknown[] = [];
  if (row.attachments) {
    try {
      const parsed = JSON.parse(row.attachments);
      if (Array.isArray(parsed)) attachments = parsed;
    } catch {
      /* 脏数据当没有附件 */
    }
  }
  return { ...row, attachments };
}

export async function insertMessage(
  characterId: number,
  role: string,
  content: string,
  kind = 'text',
  attachments: unknown[] | null = null,
) {
  const t = now();
  const payload = attachments && attachments.length ? JSON.stringify(attachments) : null;
  const r = await run(
    'INSERT INTO messages (character_id, role, content, kind, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [Number(characterId), role, content, kind, payload, t],
  );
  return {
    id: r.lastId,
    character_id: Number(characterId),
    role,
    content,
    kind,
    attachments: attachments || [],
    created_at: t,
  };
}

export async function listMessages(characterId: number, limit = 200) {
  const rows = await all<MessageRow>(
    'SELECT * FROM messages WHERE character_id = ? ORDER BY id DESC LIMIT ?',
    [Number(characterId), limit],
  );
  return rows.reverse().map((r) => mapMessage(r));
}

// ---------- 记忆 / 对局 / 动态 ----------
export type MemoryRow = {
  id: number;
  character_id: number;
  content: string;
  kind: string;
  importance: number;
  created_at: string;
};

export function listMemories(characterId: number) {
  return all<MemoryRow>('SELECT * FROM memories WHERE character_id = ? ORDER BY id DESC', [Number(characterId)]);
}

export function listGames(characterId: number) {
  return all('SELECT * FROM game_records WHERE character_id = ? ORDER BY id DESC', [Number(characterId)]);
}

export function listPosts() {
  return all('SELECT * FROM posts ORDER BY id DESC LIMIT 100');
}

// ---------- 供应商 ----------
export type ProviderRow = {
  id: number;
  label: string;
  kind: string;
  type: string;
  base_url: string;
  api_key: string;
  models: string;
  preferred_model: string | null;
  supports_vision: number;
  supports_tools: number;
  last_ok: number;
  created_at: string;
};

export type ProviderPublic = {
  id: number;
  label: string;
  kind: string;
  type: 'openai' | 'ollama';
  baseUrl: string;
  hasKey: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
  preferredModel: string;
  models: string[];
  lastOk: number;
};

export function parseModels(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function toPublic(row: ProviderRow): ProviderPublic {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind || 'chat',
    type: row.type === 'ollama' ? 'ollama' : 'openai',
    baseUrl: row.base_url,
    hasKey: !!row.api_key,
    supportsVision: !!row.supports_vision,
    supportsTools: !!row.supports_tools,
    preferredModel: row.preferred_model || '',
    models: parseModels(row.models),
    lastOk: row.last_ok,
  };
}

export async function listProviders(kind?: string) {
  const rows = kind
    ? await all<ProviderRow>('SELECT * FROM providers WHERE kind = ? ORDER BY id ASC', [kind])
    : await all<ProviderRow>('SELECT * FROM providers ORDER BY id ASC');
  return rows.map(toPublic);
}

export function rawProvider(id: number) {
  return get<ProviderRow>('SELECT * FROM providers WHERE id = ?', [Number(id)]);
}

export async function createProvider(body: Record<string, unknown>): Promise<ProviderPublic> {
  const kind = ['chat', 'embedding', 'image', 'tts', 'stt'].includes(String(body.kind))
    ? String(body.kind)
    : 'chat';
  const used = new Set((await all<{ label: string }>('SELECT label FROM providers')).map((r) => r.label));
  let n = 1;
  while (used.has(`供应商-${n}`)) n += 1;
  const label = str(body.label, 40).trim() || `供应商-${n}`;

  let baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('接口地址要以 http:// 或 https:// 开头');

  const manual = String(body.model || '').trim();
  const r = await run(
    `INSERT INTO providers (label, kind, type, base_url, api_key, models, preferred_model, supports_vision, supports_tools, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      label,
      kind,
      body.type === 'ollama' ? 'ollama' : 'openai',
      baseUrl,
      String(body.apiKey || '').trim(),
      manual ? JSON.stringify([manual]) : '[]',
      manual || null,
      body.supportsVision ? 1 : 0,
      body.supportsTools ? 1 : 0,
      now(),
    ],
  );
  const created = await rawProvider(r.lastId);
  if (!created) throw new Error('创建供应商失败');
  return toPublic(created);
}

export async function updateProvider(id: number, body: Record<string, unknown>) {
  const row = await rawProvider(id);
  if (!row) throw new Error('供应商不存在');
  const sets: string[] = [];
  const values: unknown[] = [];

  if (typeof body.label === 'string' && body.label.trim()) {
    sets.push('label = ?');
    values.push(body.label.trim().slice(0, 40));
  }
  if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) {
    sets.push('base_url = ?');
    values.push(body.baseUrl.trim().replace(/\/+$/, ''));
  }
  if (body.type === 'openai' || body.type === 'ollama') {
    sets.push('type = ?');
    values.push(body.type);
  }
  if (typeof body.kind === 'string' && ['chat', 'embedding', 'image', 'tts', 'stt'].includes(body.kind)) {
    sets.push('kind = ?');
    values.push(body.kind);
  }
  if (body.supportsVision !== undefined) {
    sets.push('supports_vision = ?');
    values.push(body.supportsVision ? 1 : 0);
  }
  if (body.supportsTools !== undefined) {
    sets.push('supports_tools = ?');
    values.push(body.supportsTools ? 1 : 0);
  }
  if (typeof body.model === 'string' && body.model.trim()) {
    const m = body.model.trim();
    const cur = parseModels(row.models);
    if (!cur.includes(m)) {
      sets.push('models = ?');
      values.push(JSON.stringify([...cur, m]));
    }
    sets.push('preferred_model = ?');
    values.push(m);
  }
  if (typeof body.apiKey === 'string' && body.apiKey !== '__KEEP__') {
    sets.push('api_key = ?');
    values.push(body.apiKey.trim());
  }
  if (sets.length) {
    values.push(Number(id));
    await run(`UPDATE providers SET ${sets.join(', ')} WHERE id = ?`, values);
  }
  const updated = await rawProvider(id);
  return updated ? toPublic(updated) : null;
}

export async function removeProvider(id: number) {
  await run('DELETE FROM providers WHERE id = ?', [Number(id)]);
}

export async function saveProviderModels(id: number, models: string[]) {
  await run('UPDATE providers SET models = ?, last_ok = ? WHERE id = ?', [
    JSON.stringify(models),
    Date.now(),
    Number(id),
  ]);
}

// ---------- 当前模型 ----------
export type ModelOption = {
  key: string;
  providerId: number;
  providerLabel: string;
  providerType: string;
  id: string;
  name: string;
};

export async function aggregateModels(): Promise<ModelOption[]> {
  const list = await listProviders('chat');
  const out: ModelOption[] = [];
  for (const p of list) {
    for (const m of p.models) {
      out.push({
        key: `${p.id}::${m}`,
        providerId: p.id,
        providerLabel: p.label,
        providerType: p.type,
        id: m,
        name: m,
      });
    }
  }
  return out;
}

export async function currentModel() {
  const models = await aggregateModels();
  const pid = Number(await getSetting('current_provider', '0'));
  const model = await getSetting('current_model', '');
  const hit = models.find((m) => m.providerId === pid && m.id === model) || models[0] || null;
  if (!hit) return null;
  return {
    providerId: hit.providerId,
    providerLabel: hit.providerLabel,
    model: hit.id,
    hasModels: true,
  };
}

export async function setCurrentModel(providerId: number, model: string) {
  const list = await listProviders('chat');
  const p = list.find((x) => x.id === Number(providerId));
  if (!p) throw new Error('供应商不存在');
  const picked = p.models.includes(model) ? model : p.models[0];
  if (!picked) throw new Error('这个供应商还没有模型');
  await setSetting('current_provider', String(p.id));
  await setSetting('current_model', picked);
  return {
    providerId: p.id,
    providerLabel: p.label,
    model: picked,
    hasModels: true,
  };
}
