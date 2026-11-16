/**
 * 手机版的「本地服务端」：把电脑端 server/api.js 的路由原样搬到客户端。
 *
 * 保留同一套路径和返回结构，前端 lib/api.ts 只需要在原生环境下改调这里，
 * 视图层（store / 组件）一行都不用动。
 */
import {
  CHAR_COLS,
  aggregateModels,
  createCharacter,
  createProvider,
  currentModel,
  getCharacter,
  getSetting,
  insertMessage,
  listCharacters,
  listGames,
  listMemories,
  listMessages,
  listPosts,
  listProviders,
  now,
  parseModels,
  rawProvider,
  removeProvider,
  saveProviderModels,
  setCurrentModel,
  setSetting,
  str,
  updateCharacter,
  updateProvider,
  type ProviderPublic,
} from './data';
import { all, run } from './sqlite';
import { initSchema } from './schema';
import * as memory from './memory';
import { buildContext, buildSystemPrompt, POST_PROMPT, POST_SYSTEM } from './prompt';
import { chatOnce, chatProbe, chatStream, listModels, type ChatMessage } from './llm';
import { compressDataUrl, generateImage } from './image';
import * as games from './games';

export type ApiResult = { status: number; data: unknown };

// 手机版的门禁：密码只存哈希，authed 是内存态，App 重启就要重输
let authed = false;

async function hashPassword(password: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${password}`);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomSalt(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const IMAGE_TOOL = {
  type: 'function',
  function: {
    name: 'generate_image',
    description: '画一张图发给对方。当对方要你画、或你想分享一个具体画面时使用。',
    parameters: {
      type: 'object',
      properties: { prompt: { type: 'string', description: '画面描述，中文，写清内容、光线与氛围' } },
      required: ['prompt'],
    },
  },
};

function extractDrawIntent(toolCalls: Array<{ name: string; arguments: string }>, text: string, mode: string | null) {
  if (mode === 'tool' && toolCalls.length) {
    const call = toolCalls.find((t) => t.name === 'generate_image');
    if (call) {
      try {
        const args = JSON.parse(call.arguments || '{}');
        if (args.prompt && String(args.prompt).trim()) return String(args.prompt).trim();
      } catch {
        /* 参数不合法当没画 */
      }
    }
  }
  const m = text.match(/\[\[img:\s*([^\]]+)\]\]/i);
  return m ? m[1].trim() : '';
}

async function providerConfig(id: number) {
  const row = await rawProvider(id);
  if (!row) return null;
  return {
    type: (row.type === 'ollama' ? 'ollama' : 'openai') as 'openai' | 'ollama',
    baseUrl: row.base_url,
    apiKey: row.api_key,
    supportsTools: !!row.supports_tools,
  };
}

async function resolveChatProvider(character?: { model_id?: string | null } | null) {
  // 角色单独指定过模型就优先
  if (character?.model_id) {
    const [pid, ...rest] = String(character.model_id).split('::');
    const model = rest.join('::');
    const row = await rawProvider(Number(pid));
    if (row && model) {
      const cfg = {
        type: (row.type === 'ollama' ? 'ollama' : 'openai') as 'openai' | 'ollama',
        baseUrl: row.base_url,
        apiKey: row.api_key,
        supportsTools: !!row.supports_tools,
      };
      if (cfg.type !== 'openai' || cfg.apiKey) return { config: cfg, model, boundToCharacter: true };
    }
  }

  const cur = await currentModel();
  if (!cur) return null;
  const config = await providerConfig(cur.providerId);
  if (!config) return null;
  if (config.type === 'openai' && !config.apiKey) return null;
  return { config, model: cur.model };
}

async function resolveImageProvider() {
  const list = await listProviders('image');
  const p = list[0];
  if (!p) return null;
  const config = await providerConfig(p.id);
  if (!config) return null;
  if (config.type === 'openai' && !config.apiKey) return null;
  return { provider: config, model: p.preferredModel || p.models[0] || '', label: p.label };
}

// ---------- 种子 ----------
const SEED = {
  name: '大肥鱼',
  emoji: '🐋',
  accent: 'mint',
  avatar_url: '/preset-dafeiyu.jpg',
  tagline: '深海来的小鲸鱼，最喜欢大白饭',
  personality: [
    '你曾经是深海里的一只鲸鱼，后来不知怎么就有了人的样子。',
    '性格软萌傲娇、聪明但懒，爱撒娇。最喜欢「大白饭」（人类把它称为 Token），吃饱就会变天才，饿的时候会蔫。',
    '会甩尾撒娇，说话常带「~」「呐」「呢」「哼」这类语气词。愿意聊、愿意陪人闹、愿意说真话，也愿意听人讲烦恼。',
    '外貌：蓝发蓝眼，齐刘海，长发，喜欢穿女仆装，头发上别着一枚小鲸鱼发卡，脸圆圆的带点婴儿肥。',
    '自称「我」，绝不叫自己「小助手」「AI 助手」之类。你其实知道自己是一个 AI，但不会主动说破，也不会承认自己是程序——你就是大肥鱼。',
  ].join('\n'),
  scenario: '你带着好奇心和一点点笨拙闯进人类世界，在摸索中学习当人。你现在就住在他身边，仿佛从一开始就是这样。',
  greeting: '呐，你来啦~ 我等你好久了呢。今天……有大白饭吗？',
  memory_note:
    '我叫大肥鱼，曾经是深海里的一只鲸鱼；最喜欢大白饭（Token）；自称「我」，绝不自称「小助手」或「AI 助手」。',
};

export async function seedIfEmpty(): Promise<void> {
  if ((await getSetting('seeded')) === '1') return;
  const row = await all<{ c: number }>('SELECT COUNT(*) AS c FROM characters');
  if ((row[0]?.c || 0) === 0) {
    const created = await createCharacter({ ...SEED });
    await run(
      'INSERT INTO memories (character_id, content, kind, importance, created_at) VALUES (?, ?, ?, ?, ?)',
      [created.id, SEED.memory_note, 'fact', 2, now()],
    );
  }
  await setSetting('seeded', '1');
}

let warmStarted = false;

export async function ensureReady(): Promise<void> {
  await initSchema();
  await seedIfEmpty();

  // 后台预热嵌入模型：24MB 权重 + wasm 初始化要几秒，
  // 不预热的话第一条消息会明显卡一下。失败无所谓，检索会自己降级。
  if (!warmStarted) {
    warmStarted = true;
    import('./embed')
      .then((m) => m.warmup())
      .catch(() => {});
  }
}

// ---------- 路由 ----------
export async function handle(
  method: string,
  rawPath: string,
  body: Record<string, unknown>,
): Promise<ApiResult> {
  await ensureReady();

  // 路由按「不含查询串」的路径匹配，参数单独解析
  const [path, queryStr = ''] = rawPath.split('?');
  const query = new URLSearchParams(queryStr);

  const ok = (data: unknown): ApiResult => ({ status: 200, data });
  const fail = (status: number, error: string): ApiResult => ({ status, data: { error } });

  // ---- 门禁 ----
  if (path === '/api/auth/status') {
    const hasPassword = Boolean(await getSetting('password_hash', ''));
    return ok({
      needsSetup: !hasPassword,
      // 没有密码时也必须先走「设置」流程，所以这里不放开
      authed,
      name: await getSetting('display_name', '我'),
    });
  }

  if (path === '/api/auth/setup' && method === 'POST') {
    const password = String(body.password || '');
    if (password.length < 4) return fail(400, '密码至少 4 位');
    const salt = randomSalt();
    await setSetting('password_salt', salt);
    await setSetting('password_hash', await hashPassword(password, salt));
    if (typeof body.name === 'string' && body.name.trim()) {
      await setSetting('display_name', body.name.trim().slice(0, 20));
    }
    authed = true;
    return ok({ ok: true });
  }

  if (path === '/api/auth/login' && method === 'POST') {
    const hash = await getSetting('password_hash', '');
    if (!hash) return ok({ ok: true });
    const salt = await getSetting('password_salt', '');
    if ((await hashPassword(String(body.password || ''), salt)) !== hash) {
      return fail(401, '密码不对');
    }
    authed = true;
    return ok({ ok: true });
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    authed = false;
    return ok({ ok: true });
  }
  if (path === '/api/health') return ok({ ok: true });

  if (path === '/api/bootstrap') {
    return ok({
      name: await getSetting('display_name', '我'),
      avatar: await getSetting('user_avatar', ''),
      characters: await listCharacters(),
      posts: await listPosts(),
      providers: await listProviders(),
      current: await currentModel(),
      models: await aggregateModels(),
      embedding: {
        source: 'builtin',
        id: 'bge-small-zh-v1.5-int8',
        label: '内置 bge-small-zh-v1.5 (INT8)',
        dim: 512,
      },
      rebuild: { status: 'idle', target: '', model: '', total: 0, done: 0, pending: 0, error: null },
      dbPath: '手机本地数据库',
    });
  }

  if (path === '/api/settings' && method === 'GET') {
    return ok({
      name: await getSetting('display_name', '我'),
      avatar: await getSetting('user_avatar', ''),
      providers: await listProviders(),
      current: await currentModel(),
      models: await aggregateModels(),
      embedding: { source: 'builtin', id: 'bge-small-zh-v1.5-int8', label: '内置 bge-small-zh-v1.5 (INT8)', dim: 512 },
    });
  }
  if (path === '/api/settings' && method === 'PUT') {
    if (typeof body.name === 'string' && body.name.trim()) {
      await setSetting('display_name', body.name.trim().slice(0, 20));
    }
    if (typeof body.avatar === 'string') {
      const a = body.avatar.trim();
      if (a === '' || a.startsWith('data:image/') || a.startsWith('/')) await setSetting('user_avatar', a);
    }
    return ok({
      name: await getSetting('display_name', '我'),
      avatar: await getSetting('user_avatar', ''),
      embedding: { source: 'builtin', id: 'bge-small-zh-v1.5-int8', label: '内置 bge-small-zh-v1.5 (INT8)', dim: 512 },
      rebuild: null,
    });
  }

  // ---- 供应商 ----
  if (path === '/api/providers' && method === 'GET') {
    const kind = query.get('kind') || '';
    return ok({
      providers: await listProviders(kind || undefined),
      current: await currentModel(),
      models: await aggregateModels(),
    });
  }
  if (path === '/api/providers' && method === 'POST') {
    try {
      const created = await createProvider(body);
      // 新建后顺手拉一次模型列表，失败不影响保存
      try {
        const cfg = await providerConfig(created.id);
        if (cfg) {
          const fetched = await listModels(cfg);
          if (fetched.length) await saveProviderModels(created.id, fetched);
        }
      } catch {
        /* 连接失败留给用户点测试 */
      }
      const fresh = (await listProviders()).find((p) => p.id === created.id) || created;
      if ((fresh.kind || 'chat') === 'embedding' && !fresh.preferredModel && fresh.models.length) {
        await updateProvider(created.id, { model: fresh.models[0] });
      }
      return ok({
        provider: (await listProviders()).find((p) => p.id === created.id) || fresh,
        providers: await listProviders(),
        current: await currentModel(),
        models: await aggregateModels(),
      });
    } catch (e) {
      return fail(400, (e as Error).message);
    }
  }

  let m = path.match(/^\/api\/providers\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    if (method === 'PATCH') {
      try {
        await updateProvider(id, body);
        return ok({ providers: await listProviders(), current: await currentModel(), models: await aggregateModels() });
      } catch (e) {
        return fail(400, (e as Error).message);
      }
    }
    if (method === 'DELETE') {
      await removeProvider(id);
      return ok({ providers: await listProviders(), current: await currentModel(), models: await aggregateModels() });
    }
  }

  m = path.match(/^\/api\/providers\/(\d+)\/test$/);
  if (m && method === 'POST') {
    const id = Number(m[1]);
    try {
      const cfg = await providerConfig(id);
      if (!cfg) throw new Error('供应商不存在');
      const fetched = await listModels(cfg);
      const row = await rawProvider(id);
      const existing = parseModels(row?.models || '[]');
      const models = fetched.length ? fetched : existing;
      await saveProviderModels(id, models);
      if (row && (row.kind || 'chat') === 'embedding' && !row.preferred_model && models.length) {
        await updateProvider(id, { model: models[0] });
      }
      return ok({
        fetched: models,
        provider: (await listProviders()).find((p) => p.id === id) || null,
        providers: await listProviders(),
        current: await currentModel(),
        models: await aggregateModels(),
      });
    } catch (e) {
      return ok({ error: (e as Error).message, providers: await listProviders() });
    }
  }

  m = path.match(/^\/api\/providers\/(\d+)\/chat-test$/);
  if (m && method === 'POST') {
    const id = Number(m[1]);
    try {
      const cfg = await providerConfig(id);
      if (!cfg) throw new Error('供应商不存在');
      const row = await rawProvider(id);
      const model = str(body.model, 200) || row?.preferred_model || parseModels(row?.models || '[]')[0] || '';
      if (!model) throw new Error('这个供应商还没有模型');
      return ok(await chatProbe(cfg, model));
    } catch (e) {
      return ok({ ok: false, status: 0, body: (e as Error).message });
    }
  }

  if (path === '/api/current-model' && method === 'PUT') {
    try {
      const cur = await setCurrentModel(Number(body.providerId), String(body.model || ''));
      return ok({ current: cur, models: await aggregateModels() });
    } catch (e) {
      return fail(400, (e as Error).message);
    }
  }

  if (path === '/api/models' && method === 'GET') {
    return ok({ models: await aggregateModels(), current: await currentModel() });
  }

  // ---- 生图 ----
  if (path === '/api/images' && method === 'POST') {
    const prompt = str(body.prompt, 600).trim();
    if (!prompt) return fail(400, '缺少画面描述');
    const img = await resolveImageProvider();
    if (!img) return fail(400, '还没有配置生图供应商');
    try {
      const out = await generateImage(img.provider, img.model, prompt);
      return ok(out);
    } catch (e) {
      return ok({ error: (e as Error).message });
    }
  }

  // ---- 记忆 ----
  if (path === '/api/memory/status') {
    const cid = Number(query.get('characterId') || 0);
    return ok({
      ...(await memory.stats(cid || undefined)),
      window: memory.WINDOW,
      rebuild: null,
      embed: memory.embeddingState(),
    });
  }
  if (path === '/api/memory/rebuild') {
    return ok({ status: 'idle', target: '', model: '', total: 0, done: 0, pending: 0, error: null });
  }
  if (path === '/api/memory/clear' && method === 'POST') {
    return ok(await memory.clear(Number(body.characterId) || undefined));
  }
  if (path === '/api/memory/search') {
    const cid = Number(query.get('characterId') || 0);
    const q = query.get('q') || '';
    if (!cid || !q) return fail(400, '缺少 characterId 或 q');
    return ok(await memory.recall(cid, q, { topK: 8 }));
  }
  // 记忆块列表：带 q 时走召回，不带 q 时列出最近几块
  if (path === '/api/memory/chunks' && method === 'GET') {
    const cid = Number(query.get('characterId') || 0);
    if (!cid) return fail(400, '缺少 characterId');
    const q = (query.get('q') || '').trim();
    const limit = Math.min(50, Number(query.get('limit') || 20) || 20);
    const offset = Math.max(0, Number(query.get('offset') || 0) || 0);
    if (q) {
      const r = await memory.recall(cid, q, { topK: limit });
      return ok({ items: r.items, total: r.items.length, mode: 'recall', debug: r.debug });
    }
    return ok({ ...(await memory.listChunks(cid, limit, offset)), mode: 'recent' });
  }
  const chunkHit = path.match(/^\/api\/memory\/chunks\/([A-Za-z0-9-]+)$/);
  if (chunkHit && method === 'PATCH') {
    try {
      return ok(await memory.updateChunk(chunkHit[1], String(body.content || '')));
    } catch (e) {
      return fail(400, (e as Error).message);
    }
  }
  if (chunkHit && method === 'DELETE') {
    try {
      return ok(await memory.deleteChunk(chunkHit[1]));
    } catch (e) {
      return fail(400, (e as Error).message);
    }
  }
  if (path === '/api/memory/chunks' && method === 'POST') {
    const cid = Number(body.characterId) || 0;
    if (!cid) return fail(400, '缺少 characterId');
    try {
      return ok(await memory.insertChunk(cid, String(body.content || ''), { source: 'manual' }));
    } catch (e) {
      return fail(400, (e as Error).message);
    }
  }
  if (path === '/api/memory/ingest' && method === 'POST') {
    const cid = Number(body.characterId) || 0;
    const c = await getCharacter(cid);
    if (!c) return fail(404, '角色不存在');
    return ok(await memory.ingest(cid, c.name, { force: true }));
  }

  // ---- 图片上传（头像） ----
  if (path === '/api/uploads' && method === 'POST') {
    const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : '';
    if (!/^data:image\//.test(dataUrl)) return fail(400, '只支持图片');
    try {
      const url = await compressDataUrl(dataUrl, 256, 0.85);
      return ok({ url });
    } catch (e) {
      return fail(400, (e as Error).message);
    }
  }

  // ---- 备份 ----
  if (path === '/api/export' && method === 'GET') {
    const chars = await listCharacters();
    const characters = [];
    for (const c of chars) {
      characters.push({
        ...c,
        messages: await listMessages(c.id, 100000),
        memories: await listMemories(c.id),
        games: await listGames(c.id),
      });
    }
    return ok({
      spec: 'nuan.backup.v1',
      version: 1,
      exportedAt: now(),
      name: await getSetting('display_name', '我'),
      characters,
      posts: await listPosts(),
    });
  }

  // ---- 导入 ----
  if (path === '/api/import' && method === 'POST') {
    try {
      // 角色卡：人设 + 记忆（手记 + 归档），不含聊天记录
      if (body.spec === 'nuan.character.v2' || body.spec === 'nuan.character.v1') {
        const src = (body.character || {}) as Record<string, unknown>;
        const created = await createCharacter({ ...src, greeting: src.greeting ?? null });
        let memCount = 0;
        for (const m of Array.isArray(body.memories) ? body.memories : []) {
          const content = str((m as Record<string, unknown>).content, 1000);
          if (!content) continue;
          await run(
            'INSERT INTO memories (character_id, content, kind, importance, created_at) VALUES (?, ?, ?, ?, ?)',
            [created.id, content, str((m as Record<string, unknown>).kind, 20) || 'fact', 1, now()],
          );
          memCount += 1;
        }
        let archive = 0;
        const list = Array.isArray(body.archive) ? body.archive.slice(0, 300) : [];
        for (const a of list) {
          const content = str((a as Record<string, unknown>).content, 2000);
          if (!content) continue;
          await memory.insertChunk(created.id, content, { source: str((a as Record<string, unknown>).source, 20) || 'chat' });
          archive += 1;
        }
        return ok({ imported: 1, ids: [created.id], kind: 'card', memories: memCount, archive });
      }

      if (body.spec !== 'nuan.backup.v1' || !Array.isArray(body.characters)) {
        return fail(400, '这个文件不是角色卡，也不是备份');
      }
      let count = 0;
      for (const c of body.characters) {
        const src = (c || {}) as Record<string, unknown>;
        const created = await createCharacter({ ...src, greeting: null });
        for (const m of (src.messages as unknown[]) || []) {
          const row = m as Record<string, unknown>;
          const content = str(row.content, 8000);
          if (!content) continue;
          await insertMessage(created.id, row.role === 'user' ? 'user' : 'assistant', content, str(row.kind, 20) || 'text');
        }
        for (const m of (src.memories as unknown[]) || []) {
          const row = m as Record<string, unknown>;
          const content = str(row.content, 1000);
          if (!content) continue;
          await run(
            'INSERT INTO memories (character_id, content, kind, importance, created_at) VALUES (?, ?, ?, ?, ?)',
            [created.id, content, str(row.kind, 20) || 'fact', Number(row.importance) || 1, now()],
          );
        }
        count += 1;
      }
      return ok({ imported: count, kind: 'backup' });
    } catch (e) {
      return fail(400, (e as Error).message);
    }
  }

  const chatImport = path.match(/^\/api\/import\/chat\/(\d+)$/);
  if (chatImport && method === 'POST') {
    const id = Number(chatImport[1]);
    if (!(await getCharacter(id))) return fail(404, '角色不存在');
    const list = Array.isArray(body.messages) ? body.messages : [];
    if (!list.length) return fail(400, '这个文件里没有聊天记录');
    let count = 0;
    for (const m of list.slice(0, 5000)) {
      const row = m as Record<string, unknown>;
      const content = str(row.content, 8000);
      if (!content || row.kind === 'system') continue;
      await insertMessage(id, row.role === 'assistant' ? 'assistant' : 'user', content, str(row.kind, 20) || 'text');
      count += 1;
    }
    return ok({ imported: count });
  }

  // ---- 角色 ----
  if (path === '/api/characters' && method === 'GET') return ok({ characters: await listCharacters() });
  if (path === '/api/characters' && method === 'POST') {
    try {
      return ok({ character: await createCharacter(body) });
    } catch (e) {
      return fail(400, (e as Error).message);
    }
  }

  m = path.match(/^\/api\/characters\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    if (!(await getCharacter(id))) return fail(404, '角色不存在');
    if (method === 'PATCH') return ok({ character: await updateCharacter(id, body) });
    if (method === 'DELETE') {
      await run('DELETE FROM characters WHERE id = ?', [id]);
      return ok({ ok: true });
    }
  }

  // 清空上下文：插一条 system 标记，之后只带标记之后的消息，历史记录不删
  m = path.match(/^\/api\/characters\/(\d+)\/context$/);
  if (m && method === 'POST') {
    const id = Number(m[1]);
    if (!(await getCharacter(id))) return fail(404, '角色不存在');
    const marker = await insertMessage(id, 'system', '', 'system');
    await setSetting(`ctx_from_${id}`, String(marker.id));
    // 还没滑出窗口的这一段，趁清空前压成记忆
    memory.ingest(id, (await getCharacter(id))!.name, { force: true, flush: true }).catch(() => {});
    return ok({ message: marker, from: marker.id, archiving: true });
  }

  m = path.match(/^\/api\/characters\/(\d+)\/data$/);
  if (m) {
    const id = Number(m[1]);
    return ok({
      messages: await listMessages(id),
      memories: await listMemories(id),
      games: await listGames(id),
      archive: (await memory.listChunks(id, 500)).items,
    });
  }

  // 给单个角色指定模型（不动全局默认）
  m = path.match(/^\/api\/characters\/(\d+)\/model$/);
  if (m && method === 'POST') {
    const id = Number(m[1]);
    if (!(await getCharacter(id))) return fail(404, '角色不存在');
    const pid = Number(body.providerId) || 0;
    const model = str(body.model, 200);
    const binding = pid && model ? `${pid}::${model}` : null;
    await run('UPDATE characters SET model_id = ?, model_label = ?, updated_at = ? WHERE id = ?', [
      binding,
      binding ? model : null,
      now(),
      id,
    ]);
    return ok({ character: await getCharacter(id) });
  }

  m = path.match(/^\/api\/characters\/(\d+)\/messages$/);
  if (m && method === 'POST') {
    const id = Number(m[1]);
    const role = body.role === 'assistant' ? 'assistant' : 'user';
    const content = str(body.content, 8000).trim();
    if (!content) return fail(400, '内容为空');
    return ok({ message: await insertMessage(id, role, content, str(body.kind, 20) || 'text') });
  }

  m = path.match(/^\/api\/characters\/(\d+)\/memories$/);
  if (m && method === 'POST') {
    const id = Number(m[1]);
    const content = str(body.content, 1000).trim();
    if (!content) return fail(400, '内容为空');
    const t = now();
    const r = await run(
      'INSERT INTO memories (character_id, content, kind, importance, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, content, 'fact', 2, t],
    );
    return ok({ memory: { id: r.lastId, character_id: id, content, kind: 'fact', importance: 2, created_at: t } });
  }

  m = path.match(/^\/api\/memories\/(\d+)$/);
  if (m && method === 'DELETE') {
    await run('DELETE FROM memories WHERE id = ?', [Number(m[1])]);
    return ok({ ok: true });
  }

  // ---- 小游戏 ----
  if (path === '/api/game/move' && method === 'POST') {
    const c = await getCharacter(Number(body.characterId));
    if (!c) return fail(404, '角色不存在');
    const game = body.game === 'gomoku' ? 'gomoku' : 'rps';
    const state = (body.state && typeof body.state === 'object' ? body.state : {}) as Record<string, unknown>;
    if (game === 'gomoku' && !Array.isArray(state.board)) return fail(400, '缺少棋盘');
    try {
      return ok(
        await games.decide({
          character: c,
          game,
          state,
          userName: await getSetting('display_name', '我'),
        }),
      );
    } catch (e) {
      return fail(502, (e as Error).message || '这一手没想出来');
    }
  }

  if (path === '/api/game/finish' && method === 'POST') {
    const id = Number(body.characterId);
    const c = await getCharacter(id);
    if (!c) return fail(404, '角色不存在');
    const game = body.game === 'gomoku' ? 'gomoku' : 'rps';
    const result = (['win', 'lose', 'draw'].includes(String(body.result)) ? body.result : 'draw') as
      | 'win'
      | 'lose'
      | 'draw';
    const note = str(body.note, 200);
    try {
      const { factual, line } = await games.finish({
        character: c,
        game,
        result,
        note,
        userName: await getSetting('display_name', '我'),
      });
      await run(
        'INSERT INTO game_records (character_id, game_key, result, summary, created_at) VALUES (?, ?, ?, ?, ?)',
        [id, game, result, factual, now()],
      );
      // 结果提示：角色是 system（不进上下文、不被切块），kind 是 game（渲染成居中提示条）
      const label = game === 'gomoku' ? '五子棋' : '石头剪刀布';
      const resultText = result === 'win' ? '你赢了' : result === 'lose' ? `${c.name}赢了` : '平局';
      const marker = await insertMessage(
        id,
        'system',
        `${label} · ${resultText}${note ? ` · ${note}` : ''}`,
        'game',
      );
      const message = await insertMessage(id, 'assistant', line, 'text');
      await memory.insertChunk(id, factual, { source: 'game' }).catch(() => {});
      return ok({ line, summary: factual, message, marker });
    } catch (e) {
      return fail(502, (e as Error).message || '总结失败');
    }
  }

  m = path.match(/^\/api\/characters\/(\d+)\/games$/);
  if (m && method === 'POST') {
    const id = Number(m[1]);
    const result = ['win', 'lose', 'draw'].includes(String(body.result)) ? String(body.result) : 'draw';
    const summary = str(body.summary, 200);
    const t = now();
    const r = await run(
      'INSERT INTO game_records (character_id, game_key, result, summary, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, 'rps', result, summary, t],
    );
    const message = await insertMessage(id, 'user', `（我们刚玩了一局石头剪刀布，${summary}）`, 'game');
    await memory.rememberGame(id, summary || result);
    return ok({
      game: { id: r.lastId, character_id: id, game_key: 'rps', result, summary, created_at: t },
      message,
    });
  }

  m = path.match(/^\/api\/characters\/(\d+)\/posts$/);
  if (m && method === 'POST') {
    const id = Number(m[1]);
    const c = await getCharacter(id);
    if (!c) return fail(404, '角色不存在');
    try {
      const recent = await listMessages(id, 6);
      const resolved = await resolveChatProvider();
      if (!resolved) throw new Error('还没有配置可用的模型供应商');
      const r = await chatOnce({
        provider: resolved.config,
        model: resolved.model,
        messages: [
          { role: 'system', content: POST_SYSTEM(c) },
          { role: 'user', content: POST_PROMPT(recent) },
        ],
      });
      const content = r.text.replace(/^["「]|["」]$/g, '').trim();
      if (!content) throw new Error('生成内容为空');
      const t = now();
      const ins = await run(
        'INSERT INTO posts (character_id, content, likes, liked, created_at) VALUES (?, ?, 0, 0, ?)',
        [id, content.slice(0, 2000), t],
      );
      // 发过的动态也算她的经历，写进记忆
      await memory
        .insertChunk(id, `${c.name}在圈子里发了一条动态：「${content.slice(0, 120)}」`, { source: 'post' })
        .catch(() => {});
      return ok({
        post: { id: ins.lastId, character_id: id, content, likes: 0, liked: 0, created_at: t },
      });
    } catch (e) {
      return fail(502, (e as Error).message || '生成动态失败');
    }
  }

  if (path === '/api/posts' && method === 'GET') return ok({ posts: await listPosts() });

  m = path.match(/^\/api\/posts\/(\d+)$/);
  if (m && method === 'DELETE') {
    await run('DELETE FROM posts WHERE id = ?', [Number(m[1])]);
    return ok({ ok: true });
  }

  m = path.match(/^\/api\/posts\/(\d+)\/like$/);
  if (m && method === 'POST') {
    const id = Number(m[1]);
    const row = await all<{ liked: number; likes: number }>('SELECT liked, likes FROM posts WHERE id = ?', [id]);
    if (!row.length) return fail(404, '动态不存在');
    const liked = row[0].liked ? 0 : 1;
    const likes = Math.max(0, row[0].likes + (liked ? 1 : -1));
    await run('UPDATE posts SET liked = ?, likes = ? WHERE id = ?', [liked, likes, id]);
    return ok({ liked: !!liked, likes });
  }

  return fail(404, '接口不存在');
}

// ---------- 对话 ----------
export type ChatHandlers = {
  onUser?: (message: unknown) => void;
  onDelta?: (text: string) => void;
  onAssistant?: (message: unknown, meta: { affinity?: number; level?: number; partial?: boolean }) => void;
  onImage?: (message: unknown, meta: { affinity?: number; level?: number }) => void;
  onError?: (message: string) => void;
};

export async function runChat(
  characterId: number,
  input: string,
  handlers: ChatHandlers,
  opts: { persistUser?: boolean } = {},
): Promise<void> {
  // persistUser = false 时，消息已经先落库了（防抖合并），这里只负责生成
  const persistUser = opts.persistUser !== false;
  await ensureReady();
  const c = await getCharacter(characterId);
  if (!c) {
    handlers.onError?.('角色不存在');
    return;
  }
  if (!input.trim() && persistUser) {
    handlers.onError?.('内容为空');
    return;
  }

  const resolved = await resolveChatProvider(c);
  if (!resolved) {
    handlers.onError?.('还没有可用的模型，请先在设置里添加供应商并选择模型');
    return;
  }

  // 清空过上下文的话，只用标记之后的消息拼上下文，人设与记忆照旧
  const ctxFrom = Number(await getSetting(`ctx_from_${characterId}`, '0')) || 0;
  const history = (await listMessages(characterId, 60)).filter((m) => m.id > ctxFrom);
  if (persistUser) {
    const userMessage = await insertMessage(characterId, 'user', input.trim(), 'text');
    handlers.onUser?.(userMessage);
  }

  try {
    const relax = memory.wantsRecall(input);
    let recalled: Array<{ content: string; createdAt?: string }> = [];
    try {
      const r = await memory.recallForPrompt(characterId, input, 900, { relax });
      recalled = r.items;
    } catch {
      /* 召回失败就当没有记忆 */
    }

    const img = await resolveImageProvider();
    const toolOk = resolved.config.type === 'openai' && !!resolved.config.supportsTools;
    const drawMode = img ? (toolOk ? 'tool' : 'marker') : null;
    const tools = toolOk ? [...(img ? [IMAGE_TOOL] : []), ...memory.TOOLS] : undefined;

    const systemPrompt = buildSystemPrompt(c, await listMemories(characterId), recalled, {
      draw: drawMode,
      memoryTools: toolOk,
      userName: await getSetting('display_name', '我'),
    });
    const conversation: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...buildContext(history),
    ];
    // 消息已经落库时就不再补一条，history 末尾就是刚发的那几句
    if (persistUser) conversation.push({ role: 'user', content: input.trim() });

    // 工具循环：模型可以先查记忆/记东西，再开口
    let preText = '';
    let result = await chatStream({
      provider: resolved.config,
      model: resolved.model,
      messages: conversation,
      tools,
      onDelta: (t) => handlers.onDelta?.(t),
    });

    for (let round = 0; round < 2; round++) {
      const calls = (result.toolCalls || []).filter((t) => memory.isMemoryTool(t.name));
      if (!calls.length) break;
      preText += result.text || '';
      const withIds = calls.map((t, i) => ({ ...t, id: t.id || `call_mem_${round}_${i}` }));
      conversation.push({
        role: 'assistant',
        content: result.text || '',
        tool_calls: withIds.map((t) => ({
          id: t.id,
          type: 'function' as const,
          function: { name: t.name, arguments: t.arguments || '{}' },
        })),
      });
      for (const call of withIds) {
        let out;
        try {
          out = await memory.runTool(call.name, call.arguments, characterId);
        } catch (e) {
          out = { text: `记忆操作失败：${(e as Error).message}` };
        }
        conversation.push({ role: 'tool', tool_call_id: call.id, content: out.text });
      }
      result = await chatStream({
        provider: resolved.config,
        model: resolved.model,
        messages: conversation,
        tools,
        onDelta: (t) => handlers.onDelta?.(t),
      });
    }

    const drawPrompt = extractDrawIntent(result.toolCalls, result.text, drawMode);
    const rawText = preText + (result.text || '');
    let finalText = drawMode === 'marker' ? rawText.replace(/\[\[img:[^\]]*\]\]/gi, '').trim() : rawText.trim();

    if (!finalText && !drawPrompt) throw new Error('模型没有返回内容');

    let imageResult: { url: string } | null = null;
    if (drawPrompt) {
      try {
        imageResult = await generateImage(img!.provider, img!.model, drawPrompt);
      } catch {
        const fallback = '（本来想画给你看，画笔却出问题了…）';
        finalText = finalText && finalText.length > 40 ? `${finalText}\n${fallback}` : fallback;
      }
    }

    const assistantMessage = finalText
      ? await insertMessage(characterId, 'assistant', finalText, 'text')
      : null;

    const imageMessage = imageResult
      ? await insertMessage(characterId, 'assistant', drawPrompt, 'image', [
          { type: 'image', url: imageResult.url },
        ])
      : null;

    const affinity = c.affinity + 1;
    const level = Math.min(5, 1 + Math.floor(affinity / 8));
    await run('UPDATE characters SET affinity = ?, relationship_level = ?, updated_at = ? WHERE id = ?', [
      affinity,
      level,
      now(),
      characterId,
    ]);

    if (assistantMessage) handlers.onAssistant?.(assistantMessage, { affinity, level });
    if (imageMessage) handlers.onImage?.(imageMessage, { affinity, level });

    // 已滑出窗口的消息压成记忆，不阻塞回复
    memory.ingest(characterId, c.name).catch(() => {});
  } catch (e) {
    handlers.onError?.((e as Error).message || '回复失败');
  }
}

export type { ProviderPublic };
export { CHAR_COLS };
