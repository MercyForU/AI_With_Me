/**
 * 暴露给聊天模型的记忆工具。
 *
 * 三个动作对应人回忆时的真实行为：
 *   memory_search —— 想不起来，翻一翻
 *   memory_write  —— 这件事值得记住，记下来
 *   memory_update —— 记错了/过时了，改掉
 *
 * 只在供应商声明 supports_tools 时下发，否则中转会直接 400。
 */
const memory = require('./index');
const memorySearch = require('./search');

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'memory_search',
      description:
        '翻找你们过去的记忆。当对方提到以前的事、你说不清或需要确认细节时调用。不要每句话都调，只在确实需要回忆时用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '想找什么，用一句话描述，例如「他面试的事」' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_write',
      description:
        '把值得长期记住的事写进记忆。适合：对方的计划与安排、重要的人和事、明确的偏好与底线、你们之间的约定。日常寒暄不要写。',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: '一条中文陈述，第三人称，用「对方」指代用户，1-2 句，只写事实',
          },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_update',
      description: '修正一条记错或过时的记忆。需要先用 memory_search 拿到它的 id。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '记忆的 id，来自 memory_search 的结果' },
          content: { type: 'string', description: '修正后的完整内容' },
        },
        required: ['id', 'content'],
      },
    },
  },
];

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * 执行一次工具调用。
 * @returns {{ text: string, items?: Array<{id:string,content:string}> }}
 */
async function runTool(name, rawArgs, characterId) {
  const args = parseArgs(rawArgs);

  if (name === 'memory_search') {
    const query = String(args.query || '').trim();
    if (!query) return { text: '没有提供要查找的内容。' };
    const { items } = await memorySearch.recall(characterId, query, { topK: 6, relax: true });
    if (!items.length) return { text: '记忆里没有和这个相关的内容。' };
    const text = items
      .map((it) => `[${it.id}] ${fmtDate(it.createdAt)} ${it.content}`)
      .join('\n');
    return { text, items: items.map((it) => ({ id: it.id, content: it.content })) };
  }

  if (name === 'memory_write') {
    const content = String(args.content || '').trim();
    if (!content) return { text: '没有提供要记住的内容。' };
    const r = await memory.insertChunk(characterId, content, { source: 'model' });
    return { text: `已记住（id: ${r.id}）。`, items: [{ id: r.id, content: r.content }] };
  }

  if (name === 'memory_update') {
    const id = String(args.id || '').trim();
    const content = String(args.content || '').trim();
    if (!id || !content) return { text: '缺少 id 或内容。' };
    try {
      const r = await memory.updateChunk(id, content);
      return { text: `已更新（id: ${r.id}）。`, items: [{ id: r.id, content: r.content }] };
    } catch (e) {
      return { text: `更新失败：${e.message}` };
    }
  }

  return { text: `不认识这个工具：${name}` };
}

const NAMES = new Set(TOOLS.map((t) => t.function.name));

function isMemoryTool(name) {
  return NAMES.has(name);
}

module.exports = { TOOLS, runTool, isMemoryTool };
