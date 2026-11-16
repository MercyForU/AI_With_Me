/**
 * HTTP API：单用户、Cookie 会话、JSON 传输，/api/chat 走 SSE 流式。
 */
const fs = require('node:fs');
const pathMod = require('node:path');
const { db, now, getSetting, setSetting, DB_PATH } = require('./db');
const auth = require('./auth');
const llm = require('./llm');
const image = require('./image');
const providers = require('./providers');
const memory = require('./memory');
const memorySearch = require('./memory/search');
const embedding = require('./embedding');
const rebuild = require('./memory/rebuild');
const { buildSystemPrompt, buildContext, POST_SYSTEM, POST_PROMPT } = require('./prompt');

const MAX_BODY = 5 * 1024 * 1024;

// 生图工具：只有供应商声明支持 tools 时才会随请求下发
const IMAGE_TOOL = {
  type: 'function',
  function: {
    name: 'generate_image',
    description: '画一张图发给对方。当对方要你画、或你想分享一个具体画面时使用。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '画面描述，中文，写清内容、光线与氛围' },
      },
      required: ['prompt'],
    },
  },
};

/** 从模型回复里取出画图意图：原生 tool_calls 优先，其次 [[img: ...]] 标记 */
function extractDrawIntent(toolCalls, text, mode) {
  if (mode === 'tool' && Array.isArray(toolCalls) && toolCalls.length) {
    const call = toolCalls.find((t) => t.name === 'generate_image');
    if (call) {
      try {
        const args = JSON.parse(call.arguments || '{}');
        if (args.prompt && String(args.prompt).trim()) return String(args.prompt).trim();
      } catch {
        /* 参数不合法就当作没画 */
      }
    }
  }
  const m = text.match(/\[\[img:\s*([^\]]+)\]\]/i);
  return m ? m[1].trim() : '';
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function str(v, max = 4000) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

// ---------- 角色 ----------
const CHAR_COLS =
  'id, name, emoji, accent, avatar_url, tagline, personality, scenario, greeting, model_id, model_label, memory_note, relationship_level, affinity, archived, created_at, updated_at';

function getCharacter(id) {
  return db.prepare(`SELECT ${CHAR_COLS} FROM characters WHERE id = ?`).get(Number(id));
}

function listCharacters() {
  return db.prepare(`SELECT ${CHAR_COLS} FROM characters WHERE archived = 0 ORDER BY id ASC`).all();
}

function createCharacter(body) {
  const name = str(body.name, 40).trim();
  if (!name) throw new Error('角色需要一个名字');
  const t = now();
  const info = db
    .prepare(
      `INSERT INTO characters
        (name, emoji, accent, avatar_url, tagline, personality, scenario, greeting, model_id, model_label, memory_note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      name,
      str(body.emoji, 8) || '🌙',
      str(body.accent, 16) || 'violet',
      str(body.avatar_url, 300) || null,
      str(body.tagline, 120) || null,
      str(body.personality, 4000) || null,
      str(body.scenario, 2000) || null,
      str(body.greeting, 500) || null,
      str(body.model_id, 200) || null,
      str(body.model_label, 200) || null,
      str(body.memory_note, 1000) || null,
      t,
      t,
    );
  const id = Number(info.lastInsertRowid);
  if (body.greeting) {
    insertMessage(id, 'assistant', str(body.greeting, 500), 'text');
  }
  return getCharacter(id);
}

function updateCharacter(id, body) {
  const allowed = [
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
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (!(key in body)) continue;
    sets.push(`${key} = ?`);
    if (key === 'archived') values.push(body[key] ? 1 : 0);
    else if (key === 'relationship_level' || key === 'affinity') values.push(Number(body[key]) || 0);
    else values.push(typeof body[key] === 'string' ? body[key].slice(0, 4000) : body[key]);
  }
  if (!sets.length) return getCharacter(id);
  sets.push('updated_at = ?');
  values.push(now(), Number(id));
  db.prepare(`UPDATE characters SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getCharacter(id);
}

function mapMessage(row) {
  if (!row) return row;
  let attachments = [];
  if (row.attachments) {
    try {
      const parsed = JSON.parse(row.attachments);
      if (Array.isArray(parsed)) attachments = parsed;
    } catch {
      /* 脏数据当作没有附件 */
    }
  }
  return { ...row, attachments };
}

function insertMessage(characterId, role, content, kind = 'text', attachments = null) {
  const t = now();
  const payload = attachments && attachments.length ? JSON.stringify(attachments) : null;
  const info = db
    .prepare('INSERT INTO messages (character_id, role, content, kind, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(Number(characterId), role, content, kind, payload, t);
  return {
    id: Number(info.lastInsertRowid),
    character_id: Number(characterId),
    role,
    content,
    kind,
    attachments: attachments || [],
    created_at: t,
  };
}

function listMessages(characterId, limit = 200) {
  return db
    .prepare('SELECT * FROM messages WHERE character_id = ? ORDER BY id DESC LIMIT ?')
    .all(Number(characterId), limit)
    .reverse()
    .map(mapMessage);
}

function listMemories(characterId) {
  return db
    .prepare('SELECT * FROM memories WHERE character_id = ? ORDER BY id DESC')
    .all(Number(characterId));
}

function listGames(characterId) {
  return db
    .prepare('SELECT * FROM game_records WHERE character_id = ? ORDER BY id DESC')
    .all(Number(characterId));
}

function listPosts() {
  return db.prepare('SELECT * FROM posts ORDER BY id DESC LIMIT 100').all();
}

// ---------- 首启种子 ----------
const SEEDS = [
  {
    name: '大肥鱼',
    emoji: '🐋',
    accent: 'mint',
    avatarAsset: 'dafeiyu.jpg',
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
    memory_note: '我叫大肥鱼，曾经是深海里的一只鲸鱼；最喜欢大白饭（Token）；自称「我」，绝不自称「小助手」或「AI 助手」。',
  },
];

function seedIfEmpty() {
  if (getSetting('seeded') === '1') return;
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM characters').get();
  if (c === 0) {
    for (const s of SEEDS) {
      const body = { ...s };
      delete body.avatarAsset;
      delete body.memory_note;

      if (s.avatarAsset) {
        try {
          const dir = pathMod.join(pathMod.dirname(DB_PATH), 'uploads');
          fs.mkdirSync(dir, { recursive: true });
          const target = pathMod.join(dir, `preset-${s.avatarAsset}`);
          if (!fs.existsSync(target)) {
            fs.copyFileSync(pathMod.join(__dirname, '..', 'assets', s.avatarAsset), target);
          }
          body.avatar_url = `/uploads/preset-${s.avatarAsset}`;
        } catch {
          /* 头像复制失败不影响角色创建 */
        }
      }

      const created = createCharacter(body);
      if (s.memory_note) {
        db.prepare('INSERT INTO memories (character_id, content, kind, importance, created_at) VALUES (?, ?, ?, ?, ?)').run(
          created.id,
          s.memory_note,
          'fact',
          2,
          now(),
        );
      }
    }
  }
  setSetting('seeded', '1');
}

// ---------- 导出 / 导入 ----------
function exportAll() {
  const characters = listCharacters().map((c) => ({
    ...c,
    messages: listMessages(c.id, 100000),
    memories: listMemories(c.id),
    games: listGames(c.id),
  }));
  return {
    spec: 'nuan.backup.v1',
    version: 1,
    exportedAt: now(),
    name: getSetting('display_name', '我'),
    characters,
    posts: listPosts(),
  };
}

function importAll(payload) {
  if (!payload || payload.spec !== 'nuan.backup.v1' || !Array.isArray(payload.characters)) {
    throw new Error('不是本应用导出的备份文件');
  }
  let count = 0;
  const ids = [];
  for (const c of payload.characters) {
    const created = createCharacter({ ...c, greeting: null });
    ids.push(created.id);
    for (const m of c.messages || []) {
      insertMessage(created.id, m.role === 'user' ? 'user' : 'assistant', str(m.content, 8000), m.kind || 'text');
    }
    for (const m of c.memories || []) {
      db.prepare('INSERT INTO memories (character_id, content, kind, importance, created_at) VALUES (?, ?, ?, ?, ?)').run(
        created.id,
        str(m.content, 1000),
        m.kind || 'fact',
        Number(m.importance) || 1,
        now(),
      );
    }
    for (const g of c.games || []) {
      db.prepare('INSERT INTO game_records (character_id, game_key, result, summary, created_at) VALUES (?, ?, ?, ?, ?)').run(
        created.id,
        str(g.game_key, 40) || 'rps',
        str(g.result, 20) || 'draw',
        str(g.summary, 200) || null,
        now(),
      );
    }
    count += 1;
  }
  for (const p of payload.posts || []) {
    db.prepare('INSERT INTO posts (character_id, content, likes, liked, created_at) VALUES (?, ?, ?, ?, ?)').run(
      null,
      str(p.content, 2000),
      Number(p.likes) || 0,
      p.liked ? 1 : 0,
      now(),
    );
  }
  return { imported: count, ids };
}

// ---------- 路由 ----------
async function handle(req, res, url) {
  const path = url.pathname;
  const method = req.method || 'GET';
  const m = (re) => path.match(re);

  // ===== 公开：登录态 =====
  if (path === '/api/auth/status' && method === 'GET') {
    return json(res, 200, {
      needsSetup: !auth.isConfigured(),
      authed: auth.isAuthed(req),
      name: getSetting('display_name', '我'),
    });
  }

  if (path === '/api/auth/setup' && method === 'POST') {
    if (auth.isConfigured()) return json(res, 400, { error: '已经设置过密码了' });
    const body = await readBody(req);
    try {
      auth.setPassword(body.password);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    if (typeof body.name === 'string' && body.name.trim()) {
      setSetting('display_name', body.name.trim().slice(0, 20));
    }
    auth.setSessionCookie(res, auth.createSession());
    seedIfEmpty();
    return json(res, 200, { ok: true });
  }

  if (path === '/api/auth/login' && method === 'POST') {
    const ip = req.socket.remoteAddress || 'local';
    if (auth.tooManyAttempts(ip)) return json(res, 429, { error: '尝试次数过多，请等一分钟' });
    const body = await readBody(req);
    if (!auth.verifyPassword(body.password)) {
      auth.recordAttempt(ip);
      return json(res, 401, { error: '密码不对' });
    }
    auth.setSessionCookie(res, auth.createSession());
    return json(res, 200, { ok: true });
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    auth.clearSessionCookie(res, req);
    return json(res, 200, { ok: true });
  }

  if (path === '/api/health') return json(res, 200, { ok: true });

  // ===== 以下都需要登录 =====
  if (!auth.isAuthed(req)) return json(res, 401, { error: '未登录' });

  if (path === '/api/bootstrap' && method === 'GET') {
    seedIfEmpty();
    return json(res, 200, {
      name: getSetting('display_name', '我'),
      avatar: getSetting('user_avatar', ''),
      characters: listCharacters(),
      posts: listPosts(),
      providers: providers.list(),
      current: providers.current(),
      models: providers.aggregateModels(),
      embedding: embedding.info(),
      rebuild: rebuild.status(),
      dbPath: require('./db').DB_PATH,
    });
  }

  if (path === '/api/settings' && method === 'GET') {
    return json(res, 200, {
      name: getSetting('display_name', '我'),
      avatar: getSetting('user_avatar', ''),
      providers: providers.list(),
      current: providers.current(),
      models: providers.aggregateModels(),
    });
  }

  if (path === '/api/settings' && method === 'PUT') {
    const body = await readBody(req);
    if (typeof body.name === 'string' && body.name.trim()) {
      setSetting('display_name', body.name.trim().slice(0, 20));
    }
    if (typeof body.avatar === 'string') {
      const a = body.avatar.trim();
      if (a === '' || a.startsWith('/uploads/')) setSetting('user_avatar', a);
    }
    let rebuildInfo = null;
    if (typeof body.embedSource === 'string' && body.embedSource.trim()) {
      // 判断依据是「最终模型标识」而不是「供应商 id」：
      // 同一个供应商里换一个嵌入模型，同样需要重建
      const before = embedding.currentModelId();
      setSetting('embed_source', body.embedSource.trim());
      const after = embedding.currentModelId();
      if (after !== before) rebuildInfo = rebuild.start('switch');
    }
    return json(res, 200, {
      name: getSetting('display_name', '我'),
      avatar: getSetting('user_avatar', ''),
      embedding: embedding.info(),
      rebuild: rebuildInfo ? rebuild.status() : null,
    });
  }

  // ---- 模型供应商 ----
  if (path === '/api/providers' && method === 'GET') {
    const kind = url.searchParams.get('kind') || '';
    return json(res, 200, {
      providers: providers.list(kind || undefined),
      current: providers.current(),
      models: providers.aggregateModels(),
      embedding: embedding.info(),
    });
  }

  if (path === '/api/providers' && method === 'POST') {
    try {
      const created = providers.create(await readBody(req));
      // 新建后自动拉一次模型，失败不影响保存
      try {
        await providers.test(created.id);
      } catch {
        /* 连接失败留给用户点测试 */
      }
      return json(res, 200, {
        provider: providers.getPublic(created.id),
        providers: providers.list(),
        current: providers.current(),
        models: providers.aggregateModels(),
      });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  let matchP = m(/^\/api\/providers\/(\d+)$/);
  if (matchP) {
    const pid = Number(matchP[1]);
    if (method === 'PATCH') {
      try {
        // 改的若是「正在用的嵌入供应商」，模型标识会变，需要重建历史向量
        const before = embedding.currentModelId();
        providers.update(pid, await readBody(req));
        const after = embedding.currentModelId();
        if (after !== before) rebuild.start('provider-change');
        return json(res, 200, {
          providers: providers.list(),
          current: providers.current(),
          models: providers.aggregateModels(),
          embedding: embedding.info(),
          rebuild: after !== before ? rebuild.status() : null,
        });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
    if (method === 'DELETE') {
      const wasCurrent = getSetting('embed_source', 'builtin') === String(pid);
      providers.remove(pid);
      let rebuildState = null;
      if (wasCurrent) {
        // 删掉正在用的嵌入供应商：退回内置，并重建回 512 维
        setSetting('embed_source', 'builtin');
        rebuild.start('provider-deleted');
        rebuildState = rebuild.status();
      }
      return json(res, 200, {
        providers: providers.list(),
        current: providers.current(),
        models: providers.aggregateModels(),
        embedding: embedding.info(),
        rebuild: rebuildState,
      });
    }
  }

  matchP = m(/^\/api\/providers\/(\d+)\/test$/);
  if (matchP && method === 'POST') {
    const pid = Number(matchP[1]);
    try {
      const fetched = await providers.test(pid);
      return json(res, 200, {
        // fetched 是这个供应商本次拉到的模型名；models 是全局可选列表（结构不同，别混用）
        fetched,
        provider: providers.getPublic(pid),
        providers: providers.list(),
        current: providers.current(),
        models: providers.aggregateModels(),
      });
    } catch (e) {
      return json(res, 200, {
        error: e.message,
        provider: providers.getPublic(pid),
        providers: providers.list(),
        current: providers.current(),
        models: providers.aggregateModels(),
      });
    }
  }

  matchP = m(/^\/api\/providers\/(\d+)\/chat-test$/);
  if (matchP && method === 'POST') {
    const body = await readBody(req);
    try {
      const result = await providers.chatTest(Number(matchP[1]), body.model);
      return json(res, 200, result);
    } catch (e) {
      return json(res, 200, { ok: false, status: 0, body: e.message });
    }
  }

  if (path === '/api/current-model' && method === 'PUT') {
    const body = await readBody(req);
    try {
      const cur = providers.setCurrent(Number(body.providerId), String(body.model || ''));
      return json(res, 200, { current: cur, models: providers.aggregateModels() });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (path === '/api/models' && method === 'GET') {
    return json(res, 200, { models: providers.aggregateModels(), current: providers.current() });
  }

  // ---- 生图（手动触发 / 调试用） ----
  if (path === '/api/images' && method === 'POST') {
    const body = await readBody(req);
    const prompt = str(body.prompt, 600).trim();
    if (!prompt) return json(res, 400, { error: '缺少画面描述' });
    const img = providers.resolveForImage();
    if (!img) return json(res, 400, { error: '还没有配置生图供应商' });
    try {
      const out = await image.generate({ provider: img.provider, model: img.model, prompt });
      return json(res, 200, { url: out.url, bytes: out.bytes });
    } catch (e) {
      return json(res, 200, { error: e.message });
    }
  }

  // ---- 记忆 ----
  if (path === '/api/memory/status' && method === 'GET') {
    const cid = Number(url.searchParams.get('characterId') || 0);
    return json(res, 200, {
      ...memory.stats(cid || undefined),
      window: memory.WINDOW,
      rebuild: rebuild.status(),
    });
  }

  if (path === '/api/memory/rebuild' && method === 'GET') {
    return json(res, 200, rebuild.status());
  }

  if (path === '/api/memory/rebuild' && method === 'POST') {
    return json(res, 200, { ...rebuild.start('manual'), state: rebuild.status() });
  }

  if (path === '/api/memory/clear' && method === 'POST') {
    const body = await readBody(req);
    const cid = Number(body.characterId || 0);
    return json(res, 200, memory.clear(cid || undefined));
  }

  if (path === '/api/memory/search' && method === 'GET') {
    const cid = Number(url.searchParams.get('characterId') || 0);
    const q = url.searchParams.get('q') || '';
    if (!cid || !q) return json(res, 400, { error: '缺少 characterId 或 q' });
    const result = await memorySearch.recall(cid, q, { topK: 8 });
    return json(res, 200, result);
  }

  // 记忆块列表：带 q 时走召回（看看这句话会捞出什么），不带 q 时按时间倒序列出最近几块
  if (path === '/api/memory/chunks' && method === 'GET') {
    const cid = Number(url.searchParams.get('characterId') || 0);
    if (!cid) return json(res, 400, { error: '缺少 characterId' });
    const q = (url.searchParams.get('q') || '').trim();
    const limit = Math.min(50, Number(url.searchParams.get('limit') || 20) || 20);
    const offset = Math.max(0, Number(url.searchParams.get('offset') || 0) || 0);
    if (q) {
      const r = await memorySearch.recall(cid, q, { topK: limit });
      return json(res, 200, { items: r.items, total: r.items.length, mode: 'recall', debug: r.debug });
    }
    return json(res, 200, { ...memory.listChunks(cid, { limit, offset }), mode: 'recent' });
  }

  const chunkHit = m(/^\/api\/memory\/chunks\/([A-Za-z0-9-]+)$/);
  if (chunkHit && method === 'PATCH') {
    const body = await readBody(req);
    try {
      return json(res, 200, await memory.updateChunk(chunkHit[1], body.content));
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (path === '/api/memory/ingest' && method === 'POST') {
    const body = await readBody(req);
    const cid = Number(body.characterId || 0);
    const c = getCharacter(cid);
    if (!c) return json(res, 404, { error: '角色不存在' });
    return json(res, 200, await memory.ingest(cid, c.name, { force: true }));
  }

  // ---- 图片上传（头像） ----
  if (path === '/api/uploads' && method === 'POST') {
    const body = await readBody(req);
    const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : '';
    const matchImg = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/);
    if (!matchImg) return json(res, 400, { error: '只支持 PNG / JPG / WEBP / GIF 图片' });
    const ext = matchImg[1] === 'jpeg' ? 'jpg' : matchImg[1];
    const buf = Buffer.from(matchImg[2], 'base64');
    if (buf.length > 3 * 1024 * 1024) return json(res, 400, { error: '图片不能超过 3MB' });
    const cryptoMod = require('node:crypto');
    const dir = pathMod.join(pathMod.dirname(require('./db').DB_PATH), 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const name = `${Date.now().toString(36)}-${cryptoMod.randomBytes(6).toString('hex')}.${ext}`;
    fs.writeFileSync(pathMod.join(dir, name), buf);
    return json(res, 200, { url: `/uploads/${name}` });
  }

  if (path === '/api/export' && method === 'GET') {
    return json(res, 200, exportAll());
  }

  if (path === '/api/import' && method === 'POST') {
    try {
      return json(res, 200, importAll(await readBody(req)));
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  // 角色列表 / 创建
  if (path === '/api/characters' && method === 'GET') {
    return json(res, 200, { characters: listCharacters() });
  }
  if (path === '/api/characters' && method === 'POST') {
    try {
      return json(res, 200, { character: createCharacter(await readBody(req)) });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  let match = m(/^\/api\/characters\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);
    if (!getCharacter(id)) return json(res, 404, { error: '角色不存在' });
    if (method === 'PATCH') return json(res, 200, { character: updateCharacter(id, await readBody(req)) });
    if (method === 'DELETE') {
      db.prepare('DELETE FROM characters WHERE id = ?').run(id);
      return json(res, 200, { ok: true });
    }
  }

  match = m(/^\/api\/characters\/(\d+)\/data$/);
  if (match && method === 'GET') {
    const id = Number(match[1]);
    return json(res, 200, {
      messages: listMessages(id),
      memories: listMemories(id),
      games: listGames(id),
    });
  }

  match = m(/^\/api\/characters\/(\d+)\/messages$/);
  if (match && method === 'POST') {
    const id = Number(match[1]);
    const body = await readBody(req);
    const role = body.role === 'assistant' ? 'assistant' : 'user';
    const content = str(body.content, 8000).trim();
    if (!content) return json(res, 400, { error: '内容为空' });
    return json(res, 200, {
      message: insertMessage(id, role, content, str(body.kind, 20) || 'text'),
    });
  }

  match = m(/^\/api\/characters\/(\d+)\/memories$/);
  if (match && method === 'POST') {
    const id = Number(match[1]);
    const body = await readBody(req);
    const content = str(body.content, 1000).trim();
    if (!content) return json(res, 400, { error: '内容为空' });
    const t = now();
    const info = db
      .prepare('INSERT INTO memories (character_id, content, kind, importance, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, content, 'fact', 2, t);
    return json(res, 200, {
      memory: { id: Number(info.lastInsertRowid), character_id: id, content, kind: 'fact', importance: 2, created_at: t },
    });
  }

  match = m(/^\/api\/memories\/(\d+)$/);
  if (match && method === 'DELETE') {
    db.prepare('DELETE FROM memories WHERE id = ?').run(Number(match[1]));
    return json(res, 200, { ok: true });
  }

  match = m(/^\/api\/characters\/(\d+)\/games$/);
  if (match && method === 'POST') {
    const id = Number(match[1]);
    const body = await readBody(req);
    const result = ['win', 'lose', 'draw'].includes(body.result) ? body.result : 'draw';
    const summary = str(body.summary, 200);
    const t = now();
    const info = db
      .prepare('INSERT INTO game_records (character_id, game_key, result, summary, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'rps', result, summary, t);
    const message = insertMessage(id, 'user', `（我们刚玩了一局石头剪刀布，${summary}）`, 'game');
    return json(res, 200, {
      game: { id: Number(info.lastInsertRowid), character_id: id, game_key: 'rps', result, summary, created_at: t },
      message,
    });
  }

  // 角色动态
  match = m(/^\/api\/characters\/(\d+)\/posts$/);
  if (match && method === 'POST') {
    const id = Number(match[1]);
    const c = getCharacter(id);
    if (!c) return json(res, 404, { error: '角色不存在' });
    try {
      const recent = listMessages(id, 6);
      const resolved = providers.resolveForChat();
      if (!resolved) throw new Error('还没有配置可用的模型供应商');
      const text = await llm.completeOnce({
        provider: resolved.config,
        model: resolved.model,
        messages: [
          { role: 'system', content: POST_SYSTEM(c) },
          { role: 'user', content: POST_PROMPT(recent) },
        ],
      });
      const content = text.replace(/^["「]|["」]$/g, '').trim();
      if (!content) throw new Error('生成内容为空');
      const t = now();
      const info = db
        .prepare('INSERT INTO posts (character_id, content, likes, liked, created_at) VALUES (?, ?, 0, 0, ?)')
        .run(id, content.slice(0, 2000), t);
      return json(res, 200, {
        post: {
          id: Number(info.lastInsertRowid),
          character_id: id,
          content,
          likes: 0,
          liked: 0,
          created_at: t,
        },
      });
    } catch (e) {
      return json(res, 502, { error: e.message || '生成动态失败' });
    }
  }

  if (path === '/api/posts' && method === 'GET') return json(res, 200, { posts: listPosts() });

  match = m(/^\/api\/posts\/(\d+)$/);
  if (match && method === 'DELETE') {
    db.prepare('DELETE FROM posts WHERE id = ?').run(Number(match[1]));
    return json(res, 200, { ok: true });
  }

  match = m(/^\/api\/posts\/(\d+)\/like$/);
  if (match && method === 'POST') {
    const id = Number(match[1]);
    const row = db.prepare('SELECT liked, likes FROM posts WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: '动态不存在' });
    const liked = row.liked ? 0 : 1;
    const likes = Math.max(0, row.likes + (liked ? 1 : -1));
    db.prepare('UPDATE posts SET liked = ?, likes = ? WHERE id = ?').run(liked, likes, id);
    return json(res, 200, { liked: !!liked, likes });
  }

  // ===== 流式对话 =====
  if (path === '/api/chat' && method === 'POST') {
    const body = await readBody(req);
    const id = Number(body.characterId);
    const input = str(body.input, 8000).trim();
    const c = getCharacter(id);
    if (!c) return json(res, 404, { error: '角色不存在' });
    if (!input) return json(res, 400, { error: '内容为空' });

    const resolved = providers.resolveForChat();
    if (!resolved) {
      return json(res, 400, { error: '还没有可用的模型，请先在设置里添加供应商并选择模型' });
    }

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    const history = listMessages(id, 20);
    const userMessage = insertMessage(id, 'user', input, 'text');
    send({ event: 'user', message: userMessage });

    try {
      let recalled = [];
      try {
        const r = await memorySearch.recallForPrompt(id, input, 600);
        recalled = r.items;
      } catch (e) {
        console.warn('[memory] 召回失败，按无记忆继续：', e.message);
      }
      // 有生图供应商才给画图能力：能调工具就走原生，否则退回标记协议
      const img = providers.resolveForImage();
      const useTools = !!img && resolved.config.type === 'openai' && resolved.config.supportsTools;
      const drawMode = img ? (useTools ? 'tool' : 'marker') : null;

      const systemPrompt = buildSystemPrompt(c, listMemories(id), recalled, { draw: drawMode });
      const result = await llm.streamChat({
        provider: resolved.config,
        model: resolved.model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...buildContext(history),
          { role: 'user', content: input },
        ],
        tools: useTools ? [IMAGE_TOOL] : undefined,
        signal: controller.signal,
        onDelta: (delta) => send({ event: 'delta', text: delta }),
      });

      const drawPrompt = extractDrawIntent(result.toolCalls, result.text, drawMode);
      // 标记协议下要把标记从正文里摘掉，别让用户看到 [[img: ...]]
      let finalText = drawMode === 'marker' ? result.text.replace(/\[\[img:[^\]]*\]\]/gi, '').trim() : result.text.trim();

      if (!finalText && !drawPrompt) throw new Error('模型没有返回内容');

      // 先出图再落文本：生图失败时把「画好了」这类话改写成诚实的降级句，
      // 而不是留下一条说谎的消息再补一条道歉
      let imageResult = null;
      if (drawPrompt) {
        try {
          imageResult = await image.generate({
            provider: img.provider,
            model: img.model,
            prompt: drawPrompt,
            signal: controller.signal,
          });
        } catch (e) {
          console.warn('[image] 生图失败：', e.message);
          const fallback = '（本来想画给你看，画笔却出问题了…）';
          // 短回复多半就是「画好啦」这类话，留着会和降级句自相矛盾，直接换掉
          finalText = finalText && finalText.length > 40 ? `${finalText}\n${fallback}` : fallback;
        }
      }

      let assistantMessage = null;
      if (finalText) assistantMessage = insertMessage(id, 'assistant', finalText, 'text');

      let imageMessage = null;
      if (imageResult) {
        imageMessage = insertMessage(id, 'assistant', drawPrompt, 'image', [
          { type: 'image', url: imageResult.url, bytes: imageResult.bytes },
        ]);
      }

      const affinity = c.affinity + 1;
      const level = Math.min(5, 1 + Math.floor(affinity / 8));
      db.prepare('UPDATE characters SET affinity = ?, relationship_level = ?, updated_at = ? WHERE id = ?').run(
        affinity,
        level,
        now(),
        id,
      );
      if (assistantMessage) send({ event: 'assistant', message: assistantMessage, affinity, level });
      if (imageMessage) send({ event: 'image', message: imageMessage, affinity, level });

      // 把已滑出窗口的消息压成记忆（不阻塞回复）
      memory.ingest(id, c.name).catch((e) => console.warn('[memory] 入库失败：', e.message));
    } catch (e) {
      const partial = e.partial && e.partial.trim();
      if (partial) {
        const saved = insertMessage(id, 'assistant', partial, 'text');
        send({ event: 'assistant', message: saved, partial: true });
      }
      send({ event: 'error', error: controller.signal.aborted ? '已停止生成' : e.message || '回复失败' });
    }

    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  return json(res, 404, { error: '接口不存在' });
}

module.exports = { handle, seedIfEmpty };
