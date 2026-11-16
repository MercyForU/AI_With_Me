/**
 * 归档前的总结：把一段对话原文压成「以后聊天用得上」的几句陈述。
 *
 * 为什么要总结：原文里大量是语气词、寒暄、重复，直接入库既占 token，
 * 又会让向量被噪声带偏。总结后召回更准，注入上下文也更省。
 *
 * 失败一律回退原文（返回 null），绝不能让记忆功能因为模型抽风而丢内容。
 */
const providers = require('../providers');
const llm = require('../llm');

const SYSTEM = [
  '你在为一段陪伴式聊天整理长期记忆，供以后回忆时使用。',
  '把下面这段对话压缩成 1-3 句中文陈述，只保留以后可能用得到的信息：',
  '人物的近况、时间与计划、偏好与口味、承诺与约定、情绪转折、关系进展。',
  '要求：',
  '1. 用第三人称陈述，用户统一称「对方」，角色用自己的名字；',
  '2. 不要写「用户说」「角色回答」这类过程描述，直接写事实；',
  '3. 不要编造，原文没提的不要补；',
  '4. 只输出记忆本身，不要前缀、编号、解释或引号。',
].join('\n');

const TIMEOUT_MS = 25000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('总结超时')), ms)),
  ]);
}

/**
 * @param {string} raw 对话原文（带时间戳的分块文本）
 * @param {string} characterName 角色名
 * @returns {Promise<string|null>} 摘要；不可用时返回 null
 */
async function summarizeChunk(raw, characterName) {
  const text = String(raw || '').trim();
  if (!text) return null;
  // 太短的块不值得多花一次请求，直接原样存
  if (text.length < 60) return null;

  const resolved = providers.resolveForChat();
  if (!resolved) return null;

  try {
    const out = await withTimeout(
      llm.completeOnce({
        provider: resolved.config,
        model: resolved.model,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `角色：${characterName || '角色'}\n\n对话原文：\n${text}` },
        ],
      }),
      TIMEOUT_MS,
    );
    const clean = String(out || '')
      .replace(/^["'「『]|["'」』]$/g, '')
      .replace(/^\s*[-*\d.、]+/, '')
      .trim();
    // 太短或明显跑偏（比如回了一句「好的」）就当没总结
    if (clean.length < 8 || clean.length > 600) return null;
    return clean;
  } catch (e) {
    console.warn('[memory] 归档总结失败，按原文入库：', e.message);
    return null;
  }
}

module.exports = { summarizeChunk };
