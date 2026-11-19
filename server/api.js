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
const memoryTools = require('./memory/tools');
const games = require('./games');
const imageQueue = require('./imageQueue');
// 启动时把上次没画完的占位收个尾
imageQueue.failStalePlaceholders();
const embedding = require('./embedding');
const rebuild = require('./memory/rebuild');
const { buildSystemPrompt, buildContext, POST_SYSTEM, POST_PROMPT } = require('./prompt');

const MAX_BODY = 5 * 1024 * 1024;

// 生图工具：只有供应商声明支持 tools 时才会随请求下发
const IMAGE_TOOL = {
  type: 'function',
  function: {
    name: 'generate_image',
    description:
      '画一张图发给对方。对方要图时必须调用，不要用文字推脱；聊到具体画面时也可以主动画。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '画面描述，中文，写清内容、光线与氛围' },
      },
      required: ['prompt'],
    },
  },
};

/** 各种可能被模型写出来的「我要画这张图」标记 */
const DRAW_MARKERS = [
  /\[\[\s*(?:img|image|picture|图片|画|图)\s*[:：]\s*([^\]\n]+?)\s*\]\]/i,
  /【\s*(?:img|image|图片|画|图)\s*[:：]\s*([^】]+?)\s*】/i,
  /(?:^|\n)\s*[\[【]\s*(?:img|image|图片|画)\s*[:：]\s*([^\]】\n]+?)\s*[\]】]?\s*(?=\n|$)/i,
];

function unescapeJsonString(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw.replace(/\\n/g, '\n').replace(/\\"/g, '"');
  }
}

/**
 * 从模型回复里取出画图意图。
 * 不再只在 tool 模式看 tool_calls、只在 marker 模式看标记：
 * 中转把工具调用写成文本、模型写错括号、写完标记又补一句话，这些都得兜住。
 */
function extractDrawIntent(toolCalls, text) {
  // 1) 原生 tool_calls
  if (Array.isArray(toolCalls)) {
    const call = toolCalls.find((t) => t && t.name === 'generate_image');
    if (call) {
      try {
        const args = JSON.parse(call.arguments || '{}');
        if (args.prompt && String(args.prompt).trim()) return String(args.prompt).trim();
      } catch {
        /* 参数不合法就往下找文本 */
      }
    }
  }

  const t = String(text || '');

  // 2) 各种括号写法
  for (const re of DRAW_MARKERS) {
    const m = t.match(re);
    if (m && m[1] && m[1].trim()) return m[1].trim();
  }

  // 3) 工具调用被当成文本吐出来：{"name":"generate_image","arguments":"{\"prompt\":\"...\"}"}
  // 注意 prompt 可能被转义成 \"prompt\"，先拍平再找
  const flat = t.replace(/\\"/g, '"');
  if (/generate_image/.test(flat)) {
    const m = flat.match(/"prompt"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
    if (m) {
      const p = unescapeJsonString(m[1]).trim();
      if (p) return p;
    }
  }

  // 4) 整条消息就是一个 {"prompt": "..."}
  const only = t.trim().match(/^\{\s*"prompt"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}\s*$/i);
  if (only) return unescapeJsonString(only[1]).trim();

  return '';
}

/** 把残留的标记 / 被当成文本的工具调用从正文里摘干净 */
function cleanDrawResidue(text) {
  return String(text || '')
    .replace(/\[\[\s*(?:img|image|picture|图片|画|图)\s*[:：][\s\S]*?\]\]/gi, '')
    .replace(/【\s*(?:img|image|图片|画|图)\s*[:：][^】]*】/gi, '')
    .replace(/\{\s*"prompt"\s*:[\s\S]*?\}\s*$/i, '')
    .replace(/\{\s*"name"\s*:\s*"generate_image"[\s\S]*$/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

async function importAll(payload) {
  // 角色卡：人设 + 记忆（手记 + 归档），不含聊天记录
  if (payload && (payload.spec === 'nuan.character.v2' || payload.spec === 'nuan.character.v1')) {
    const created = createCharacter({ ...(payload.character || {}), greeting: payload.character?.greeting ?? null });
    for (const m of payload.memories || []) {
      db.prepare('INSERT INTO memories (character_id, content, kind, importance, created_at) VALUES (?, ?, ?, ?, ?)').run(
        created.id,
        str(m.content, 1000),
        str(m.kind, 20) || 'fact',
        Number(m.importance) || 1,
        now(),
      );
    }
    let archive = 0;
    for (const a of (payload.archive || []).slice(0, 300)) {
      if (!str(a.content, 2000)) continue;
      await memory.insertChunk(created.id, str(a.content, 2000), { source: str(a.source, 20) || 'chat' });
      archive += 1;
    }
    return { imported: 1, ids: [created.id], kind: 'card', archive };
  }

  if (!payload || payload.spec !== 'nuan.backup.v1' || !Array.isArray(payload.characters)) {
    throw new Error('这个文件不是角色卡，也不是备份');
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

  if (chunkHit && method === 'DELETE') {
    try {
      return json(res, 200, memory.deleteChunk(chunkHit[1]));
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  // 手动写一条记忆（记忆管理面板里的「添加」）
  if (path === '/api/memory/chunks' && method === 'POST') {
    const body = await readBody(req);
    const cid = Number(body.characterId || 0);
    if (!cid) return json(res, 400, { error: '缺少 characterId' });
    try {
      return json(res, 200, await memory.insertChunk(cid, body.content, { source: 'manual' }));
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
      return json(res, 200, await importAll(await readBody(req)));
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  // 聊天记录单独导入：追加到指定角色身上
  const chatImport = m(/^\/api\/import\/chat\/(\d+)$/);
  if (chatImport && method === 'POST') {
    const id = Number(chatImport[1]);
    if (!getCharacter(id)) return json(res, 404, { error: '角色不存在' });
    const body = await readBody(req);
    const list = Array.isArray(body.messages) ? body.messages : [];
    if (!list.length) return json(res, 400, { error: '这个文件里没有聊天记录' });
    let count = 0;
    for (const msg of list.slice(0, 5000)) {
      const content = str(msg.content, 8000);
      if (!content || msg.kind === 'system') continue;
      insertMessage(id, msg.role === 'assistant' ? 'assistant' : 'user', content, str(msg.kind, 20) || 'text');
      count += 1;
    }
    return json(res, 200, { imported: count });
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

  // 清空上下文：插一条 system 标记，之后的对话只带这个标记之后的消息。
  // 历史记录不删——界面照旧能往上翻，只是模型那边重新开始。
  match = m(/^\/api\/characters\/(\d+)\/context$/);
  if (match && method === 'POST') {
    const id = Number(match[1]);
    const c = getCharacter(id);
    if (!c) return json(res, 404, { error: '角色不存在' });
    const marker = insertMessage(id, 'system', '', 'system');
    setSetting(`ctx_from_${id}`, String(marker.id));
    // 还没滑出窗口的这一段，趁清空前压成记忆，别白丢
    memory.ingest(id, c.name, { force: true, flush: true }).catch((e) => {
      console.warn('[memory] 清空上下文时归档失败：', e.message);
    });
    return json(res, 200, { message: marker, from: marker.id, archiving: true });
  }

  match = m(/^\/api\/characters\/(\d+)\/data$/);
  if (match && method === 'GET') {
    const id = Number(match[1]);
    return json(res, 200, {
      messages: listMessages(id),
      memories: listMemories(id),
      games: listGames(id),
      archive: memory.listChunks(id, { limit: 500 }).items,
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

  // 给单个角色指定模型（不动全局默认）
  match = m(/^\/api\/characters\/(\d+)\/model$/);
  if (match && method === 'POST') {
    const id = Number(match[1]);
    if (!getCharacter(id)) return json(res, 404, { error: '角色不存在' });
    const body = await readBody(req);
    const pid = Number(body.providerId) || 0;
    const model = str(body.model, 200);
    const binding = pid && model ? `${pid}::${model}` : null;
    db.prepare('UPDATE characters SET model_id = ?, model_label = ?, updated_at = ? WHERE id = ?').run(
      binding,
      binding ? model : null,
      now(),
      id,
    );
    return json(res, 200, { character: getCharacter(id) });
  }

  // 批量查消息状态：前端轮询占位图用
  if (path === '/api/messages/status' && method === 'POST') {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => Number.isFinite(n)).slice(0, 20) : [];
    if (!ids.length) return json(res, 200, { messages: [] });
    const rows = db
      .prepare(`SELECT * FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids)
      .map(mapMessage);
    return json(res, 200, { messages: rows });
  }

  // 单独写一条消息（防抖时先把每条都落库上屏，再统一生成回复）
  match = m(/^\/api\/characters\/(\d+)\/messages$/);
  if (match && method === 'POST') {
    const id = Number(match[1]);
    const body = await readBody(req);
    if (!getCharacter(id)) return json(res, 404, { error: '角色不存在' });
    const role = body.role === 'assistant' ? 'assistant' : 'user';
    const content = str(body.content, 8000).trim();
    if (!content) return json(res, 400, { error: '内容为空' });
    return json(res, 200, {
      message: insertMessage(id, role, content, str(body.kind, 20) || 'text'),
    });
  }

  // ===== 小游戏 =====
  if (path === '/api/game/move' && method === 'POST') {
    const body = await readBody(req);
    const c = getCharacter(Number(body.characterId));
    if (!c) return json(res, 404, { error: '角色不存在' });
    const game = body.game === 'gomoku' ? 'gomoku' : 'rps';
    const state = body.state && typeof body.state === 'object' ? body.state : {};
    if (game === 'gomoku' && !Array.isArray(state.board)) {
      return json(res, 400, { error: '缺少棋盘' });
    }
    try {
      const r = await games.decide({
        character: c,
        game,
        state,
        userName: getSetting('display_name', '我'),
        llm,
        providers,
      });
      return json(res, 200, r);
    } catch (e) {
      return json(res, 502, { error: e.message || '这一手没想出来' });
    }
  }

  if (path === '/api/game/finish' && method === 'POST') {
    const body = await readBody(req);
    const id = Number(body.characterId);
    const c = getCharacter(id);
    if (!c) return json(res, 404, { error: '角色不存在' });
    const game = body.game === 'gomoku' ? 'gomoku' : 'rps';
    const result = ['win', 'lose', 'draw'].includes(body.result) ? body.result : 'draw';
    const note = str(body.note, 200);
    try {
      const { factual, line } = await games.finish({
        character: c,
        game,
        result,
        note,
        userName: getSetting('display_name', '我'),
        llm,
        providers,
      });
      db.prepare('INSERT INTO game_records (character_id, game_key, result, summary, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        game,
        result,
        factual,
        now(),
      );
      // 结果提示：角色是 system（不进上下文、不被切块），kind 是 game（渲染成居中提示条）
      const label = game === 'gomoku' ? '五子棋' : '石头剪刀布';
      const resultText = result === 'win' ? '你赢了' : result === 'lose' ? `${c.name}赢了` : '平局';
      const marker = insertMessage(
        id,
        'system',
        `${label} · ${resultText}${note ? ` · ${note}` : ''}`,
        'game',
      );
      const message = insertMessage(id, 'assistant', line, 'text');
      // 这一局进记忆，之后她会记得
      await memory.insertChunk(id, factual, { source: 'game' }).catch((e) => {
        console.warn('[game] 记进记忆失败：', e.message);
      });
      return json(res, 200, { line, summary: factual, message, marker });
    } catch (e) {
      return json(res, 502, { error: e.message || '总结失败' });
    }
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
      const resolved = providers.resolveForChat(c);
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
      // 发过的动态也算她的经历，写进记忆
      memory
        .insertChunk(id, `${c.name}在圈子里发了一条动态：「${content.slice(0, 120)}」`, { source: 'post' })
        .catch((e) => console.warn('[post] 写进记忆失败：', e.message));
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
    // 防抖模式：消息已经先落库了（连发几条合成一轮），这里只负责生成
    const persistUser = body.persistUser !== false;
    const c = getCharacter(id);
    if (!c) return json(res, 404, { error: '角色不存在' });
    if (persistUser && !input) return json(res, 400, { error: '内容为空' });

    // 角色单独指定过模型就用它，否则跟随全局默认
    const resolved = providers.resolveForChat(c);
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

    // 清空过上下文的话，只用标记之后的消息拼上下文，人设与记忆照旧
    const ctxFrom = Number(getSetting(`ctx_from_${id}`, '0')) || 0;
    const history = listMessages(id, 60).filter((m) => m.id > ctxFrom);
    if (persistUser) {
      const userMessage = insertMessage(id, 'user', input, 'text');
      send({ event: 'user', message: userMessage });
    }

    try {
      // 用户明说「以前/上次/前几天」时放宽召回：这类问题靠的是时间线，不是字面相似度
      const relax = memorySearch.wantsRecall(input);
      let recalled = [];
      try {
        const r = await memorySearch.recallForPrompt(id, input, 900, { relax });
        recalled = r.items;
      } catch (e) {
        console.warn('[memory] 召回失败，按无记忆继续：', e.message);
      }
      // 有生图供应商才给画图能力：能调工具就走原生，否则退回标记协议
      const img = providers.resolveForImage();
      const toolOk = resolved.config.type === 'openai' && resolved.config.supportsTools;
      const drawMode = img ? (toolOk ? 'tool' : 'marker') : null;
      const tools = toolOk
        ? [...(img ? [IMAGE_TOOL] : []), ...memoryTools.TOOLS]
        : undefined;

      const systemPrompt = buildSystemPrompt(c, listMemories(id), recalled, {
        draw: drawMode,
        memoryTools: toolOk,
        userName: getSetting('display_name', '我'),
      });
      const conversation = [
        { role: 'system', content: systemPrompt },
        ...buildContext(history),
      ];
      // 消息已经落库时不再补一条，history 末尾就是刚发的那几句
      if (persistUser) conversation.push({ role: 'user', content: input });

      // 对方明说要图时，把要求写在这一轮的最后一条上（只影响本次请求，不入库）：
      // 光靠 system prompt 有时还不够，模型会答「我不会画」
      const wantsImage = /(画[一张个幅]|来张|发张|照片|自拍|配图|生成.{0,4}图|涂鸦)/.test(input);
      if (wantsImage && drawMode && conversation.length) {
        const last = conversation[conversation.length - 1];
        const how = drawMode === 'tool' ? '调用 generate_image' : '在最后一行写 [[img: 画面描述]]';
        conversation[conversation.length - 1] = {
          ...last,
          content: `${last.content}\n\n（对方在要图：直接${how}把图画出来，不要说不会、不要只用文字描述）`,
        };
      }

      // 工具循环：模型可能先查记忆/记东西，再开口说话。
      // 最多两轮，避免模型在工具里绕不出来。
      let preText = '';
      let result = await llm.streamChat({
        provider: resolved.config,
        model: resolved.model,
        messages: conversation,
        tools,
        signal: controller.signal,
        onDelta: (delta) => send({ event: 'delta', text: delta }),
      });

      for (let round = 0; round < 2; round++) {
        const calls = (result.toolCalls || []).filter((t) => memoryTools.isMemoryTool(t.name));
        if (!calls.length) break;
        preText += result.text || '';
        const withIds = calls.map((t, i) => ({
          ...t,
          id: t.id || `call_mem_${round}_${i}`,
        }));
        conversation.push({
          role: 'assistant',
          content: result.text || '',
          tool_calls: withIds.map((t) => ({
            id: t.id,
            type: 'function',
            function: { name: t.name, arguments: t.arguments || '{}' },
          })),
        });
        for (const call of withIds) {
          let out;
          try {
            out = await memoryTools.runTool(call.name, call.arguments, id);
          } catch (e) {
            out = { text: `记忆操作失败：${e.message}` };
          }
          conversation.push({ role: 'tool', tool_call_id: call.id, content: out.text });
        }
        result = await llm.streamChat({
          provider: resolved.config,
          model: resolved.model,
          messages: conversation,
          tools,
          signal: controller.signal,
          onDelta: (delta) => send({ event: 'delta', text: delta }),
        });
      }

      const rawText = preText + (result.text || '');
      // 残留的标记、被当成文本吐出来的工具调用，一律从正文里摘掉
      let finalText = cleanDrawResidue(rawText);
      let drawPrompt = extractDrawIntent(result.toolCalls, rawText);

      // 对方明明要图，模型却回了一大段文字（常是把提示词当成了回复）：
      // 强制再要一次工具调用，免得把提示词原样发进聊天
      if (!drawPrompt && img && wantsImage && drawMode === 'tool' && !/[?？]/.test(result.text || '')) {
        try {
          const forced = await llm.streamChat({
            provider: resolved.config,
            model: resolved.model,
            messages: [
              ...conversation,
              { role: 'assistant', content: (result.text || '').slice(0, 800) || '（我这就画）' },
              { role: 'user', content: '（直接用 generate_image 把上面这段画出来，不要再解释）' },
            ],
            tools,
            toolChoice: { type: 'function', function: { name: 'generate_image' } },
            signal: controller.signal,
            onDelta: () => {},
          });
          const p = extractDrawIntent(forced.toolCalls, forced.text);
          if (p) {
            drawPrompt = p;
            // 原来那段大概率就是画面描述，留着会像「把提示词发出来了」
            if ((result.text || '').length > 40) finalText = '好，我画一张给你看。';
          }
        } catch (e) {
          console.warn('[image] 强制画图重试失败：', e.message);
        }
      }

      if (!finalText && !drawPrompt) throw new Error('模型没有返回内容');

      // 出图改成后台任务：先占位，生成好了再把图填进去，对话不用等
      let imageMessage = null;
      if (drawPrompt) {
        imageMessage = imageQueue.enqueue({
          characterId: id,
          prompt: drawPrompt,
          provider: img.provider,
          model: img.model,
        });
      }

      let assistantMessage = null;
      if (finalText) assistantMessage = insertMessage(id, 'assistant', finalText, 'text');

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
