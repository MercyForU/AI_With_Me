/**
 * 模型供应商：可保存多条（OpenAI 兼容 / Ollama），各自缓存模型列表。
 * 当前使用哪条 + 哪个模型存在 settings 里，聊天窗口直接切换。
 */
const { db, now, getSetting, setSetting, deleteSetting } = require('./db');
const { encrypt, decrypt } = require('./crypto');

const TYPES = ['openai', 'ollama'];
const KINDS = ['chat', 'embedding', 'image', 'tts', 'stt'];

function normalizeKind(kind) {
  return KINDS.includes(kind) ? kind : 'chat';
}

function parseModels(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function toPublic(row) {
  return {
    id: row.id,
    label: row.label,
    type: row.type,
    baseUrl: row.base_url,
    hasKey: !!row.api_key,
    kind: row.kind || 'chat',
    supportsVision: !!row.supports_vision,
    // 实际使用的模型（嵌入这类「一堆模型里只用一个」的场景靠它，而不是列表第一个）
    preferredModel: row.preferred_model || '',
    models: parseModels(row.models),
    lastOk: row.last_ok,
  };
}

function list(kind) {
  const rows = kind
    ? db.prepare('SELECT * FROM providers WHERE kind = ? ORDER BY id ASC').all(kind)
    : db.prepare('SELECT * FROM providers ORDER BY id ASC').all();
  return rows.map(toPublic);
}

function raw(id) {
  return db.prepare('SELECT * FROM providers WHERE id = ?').get(Number(id));
}

function getPublic(id) {
  const r = raw(id);
  return r ? toPublic(r) : null;
}

function normalizeType(type) {
  return TYPES.includes(type) ? type : 'openai';
}

function normalizeBase(base) {
  return String(base || '').trim().replace(/\/+$/, '');
}

function nextDefaultLabel() {
  const used = new Set(
    db.prepare('SELECT label FROM providers').all().map((r) => String(r.label)),
  );
  let n = 1;
  while (used.has(`供应商-${n}`)) n += 1;
  return `供应商-${n}`;
}

function create(body) {
  const type = normalizeType(body.type);
  const label = String(body.label || '').trim().slice(0, 40) || nextDefaultLabel();
  const baseUrl = normalizeBase(body.baseUrl);
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('接口地址要以 http:// 或 https:// 开头');
  if (type === 'openai' && !String(body.apiKey || '').trim()) throw new Error('OpenAI 兼容接口需要 API Key');

  // 有些中转服务不实现 /models，允许先手填一个模型名兜底
  const manual = String(body.model || '').trim();
  const initialModels = manual ? JSON.stringify([manual]) : '[]';

  const kind = normalizeKind(body.kind);
  const info = db
    .prepare(
      'INSERT INTO providers (label, kind, type, base_url, api_key, models, supports_vision, preferred_model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      label,
      kind,
      type,
      baseUrl,
      encrypt(String(body.apiKey || '').trim()),
      initialModels,
      body.supportsVision ? 1 : 0,
      manual || null,
      now(),
    );

  return getPublic(Number(info.lastInsertRowid));
}

function update(id, body) {
  const row = raw(id);
  if (!row) throw new Error('供应商不存在');

  const sets = [];
  const values = [];
  if (typeof body.label === 'string' && body.label.trim()) {
    sets.push('label = ?');
    values.push(body.label.trim().slice(0, 40));
  }
  if (typeof body.type === 'string') {
    sets.push('type = ?');
    values.push(normalizeType(body.type));
  }
  if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) {
    const b = normalizeBase(body.baseUrl);
    if (!/^https?:\/\//i.test(b)) throw new Error('接口地址要以 http:// 或 https:// 开头');
    sets.push('base_url = ?');
    values.push(b);
  }
  if (typeof body.kind === 'string') {
    sets.push('kind = ?');
    values.push(normalizeKind(body.kind));
  }
  if (body.supportsVision !== undefined) {
    sets.push('supports_vision = ?');
    values.push(body.supportsVision ? 1 : 0);
  }
  if (typeof body.model === 'string' && body.model.trim()) {
    const cur = parseModels(row.models);
    const m = body.model.trim();
    if (!cur.includes(m)) {
      sets.push('models = ?');
      values.push(JSON.stringify([...cur, m]));
    }
    sets.push('preferred_model = ?');
    values.push(m);
  }
  if (typeof body.apiKey === 'string' && body.apiKey !== '__KEEP__') {
    sets.push('api_key = ?');
    values.push(body.apiKey.trim() ? encrypt(body.apiKey.trim()) : '');
  }
  if (!sets.length) return getPublic(id);

  values.push(Number(id));
  db.prepare(`UPDATE providers SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getPublic(id);
}

function remove(id) {
  db.prepare('DELETE FROM providers WHERE id = ?').run(Number(id));
  // 当前选中的被删掉时清空选择
  if (String(getSetting('current_provider', '')) === String(id)) {
    setSetting('current_provider', '');
    setSetting('current_model', '');
  }
}

function configOf(row) {
  return {
    id: row.id,
    label: row.label,
    type: row.type,
    baseUrl: row.base_url,
    apiKey: decrypt(row.api_key),
    supportsTools: !!row.supports_tools,
    supportsVision: !!row.supports_vision,
  };
}

async function fetchModels(config) {
  const base = config.baseUrl;
  const url = config.type === 'ollama' ? `${base}/api/tags` : `${base}/models`;
  const headers = config.type === 'ollama' ? {} : { Authorization: `Bearer ${config.apiKey}` };

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 160);
    } catch {
      /* ignore */
    }
    throw new Error(`${config.type === 'ollama' ? 'Ollama' : '模型服务'}返回 ${res.status}${detail ? `：${detail}` : ''}`);
  }
  const data = await res.json();
  const ids =
    config.type === 'ollama'
      ? (data.models || []).map((m) => m.name)
      : (data.data || []).map((m) => m.id);
  return [...new Set(ids.filter(Boolean))].sort();
}

/** 测试连通性并缓存模型列表 */
async function test(id) {
  const row = raw(id);
  if (!row) throw new Error('供应商不存在');
  const fetched = await fetchModels(configOf(row));
  // 服务端没返回列表时，保留手填的模型名，避免把可用配置清空
  const existing = parseModels(row.models);
  const models = fetched.length ? fetched : existing;
  db.prepare('UPDATE providers SET models = ?, last_ok = ? WHERE id = ?').run(
    JSON.stringify(models),
    Date.now(),
    Number(id),
  );
  if ((row.kind || 'chat') === 'embedding' && !row.preferred_model && models.length) {
    db.prepare('UPDATE providers SET preferred_model = ? WHERE id = ?').run(models[0], Number(id));
  }
  return models;
}

/** 所有供应商的模型，扁平成一个可选列表 */
function aggregateModels() {
  const out = [];
  for (const p of list('chat')) {
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

/** 当前选中的供应商与模型（会做有效性校验与兜底） */
function current() {
  const pid = Number(getSetting('current_provider', '') || 0);
  const model = getSetting('current_model', '') || '';
  const providers = list('chat');

  let p = providers.find((x) => x.id === pid);
  if (!p) p = providers.find((x) => x.models.length > 0) || providers[0] || null;
  if (!p) return null;

  const models = p.models;
  const picked = models.includes(model) ? model : models[0] || '';
  return { providerId: p.id, providerLabel: p.label, model: picked, hasModels: models.length > 0 };
}

function setCurrent(providerId, model) {
  const p = getPublic(providerId);
  if (!p) throw new Error('供应商不存在');
  setSetting('current_provider', String(p.id));
  setSetting('current_model', String(model || p.models[0] || ''));
  return current();
}

/**
 * 聊天时用：拿到可直接请求的供应商配置 + 模型名。
 * 角色单独指定过模型就优先用它，否则跟随全局默认。
 * @param {{model_id?: string|null}|null} [character]
 */
function resolveForChat(character) {
  if (character && character.model_id) {
    const [pid, ...rest] = String(character.model_id).split('::');
    const model = rest.join('::');
    const row = raw(Number(pid));
    if (row && model) {
      const config = configOf(row);
      // 供应商被删了或没填 Key 就自动退回全局默认，不让聊天直接卡住
      if (config.type !== 'openai' || config.apiKey) {
        return { config, model, boundToCharacter: true };
      }
    }
  }

  const cur = current();
  if (!cur) return null;
  const row = raw(cur.providerId);
  if (!row) return null;
  const config = configOf(row);
  if (config.type === 'openai' && !config.apiKey) return null;
  const model = cur.model || parseModels(row.models)[0];
  if (!model) return null;
  return { config, model, boundToCharacter: false };
}

/** 生图能力：取第一条可用的生图供应商 */
function resolveForImage() {
  const p = list('image')[0];
  if (!p) return null;
  const config = configById(p.id);
  if (!config) return null;
  const model = p.preferredModel || p.models[0] || '';
  if (config.type === 'openai' && !config.apiKey) return null;
  return { provider: config, model, label: p.label };
}

/** 把旧的单条 llm_* 配置迁移成一条供应商记录（只做一次） */
function migrateLegacy() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM providers').get().c;
  if (count > 0) return;

  const baseUrl = getSetting('llm_base_url', '') || '';
  const apiKey = decrypt(getSetting('llm_api_key', '') || '');
  if (!baseUrl) return;

  const type = normalizeType(getSetting('llm_provider', 'openai'));
  const model = getSetting('llm_model', '') || '';
  const info = db
    .prepare('INSERT INTO providers (label, type, base_url, api_key, models, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(
      type === 'ollama' ? '本地 Ollama' : '默认供应商',
      type,
      normalizeBase(baseUrl),
      apiKey ? encrypt(apiKey) : '',
      JSON.stringify(model ? [model] : []),
      now(),
    );
  setSetting('current_provider', String(Number(info.lastInsertRowid)));
  setSetting('current_model', model);

  // 旧的单条配置已迁走，删掉避免明文/重复来源
  for (const key of ['llm_api_key', 'llm_base_url', 'llm_model', 'llm_provider']) deleteSetting(key);
  console.log('  已把旧的模型配置迁移为一条供应商记录');
}

/** 按 id 取解密后的配置（供嵌入等其它能力复用） */
function configById(id) {
  const row = raw(id);
  return row ? configOf(row) : null;
}

/** 发一条最小对话请求，返回上游原始状态与内容（用于排查 5xx） */
async function chatTest(id, model) {
  const row = raw(id);
  if (!row) throw new Error('供应商不存在');
  const c = configOf(row);
  const useModel = String(model || '').trim() || parseModels(row.models)[0];
  if (!useModel) throw new Error('这个供应商还没有模型');
  if (c.type === 'openai' && !c.apiKey) throw new Error('还没有填 API Key');

  const url = c.type === 'ollama' ? `${c.baseUrl}/api/chat` : `${c.baseUrl}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (c.type === 'openai') headers.Authorization = `Bearer ${c.apiKey}`;
  const body =
    c.type === 'ollama'
      ? { model: useModel, messages: [{ role: 'user', content: '你好' }], stream: false }
      : { model: useModel, messages: [{ role: 'user', content: '你好' }], stream: false, max_tokens: 16 };

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = (await res.text()).slice(0, 600);
  return { ok: res.ok, status: res.status, model: useModel, url, body: text };
}

module.exports = {
  KINDS,
  configById,
  resolveForImage,
  chatTest,
  list,
  getPublic,
  create,
  update,
  remove,
  test,
  aggregateModels,
  current,
  setCurrent,
  resolveForChat,
  migrateLegacy,
};
