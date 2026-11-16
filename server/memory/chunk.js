/**
 * 分块：把「已滑出上下文窗口」的消息压成记忆块。
 *
 * 切分规则：
 *   - 只处理 role ∈ (user, assistant)，kind ∈ (text, game)
 *   - 时间间隔 > 30 分钟 视为新会话
 *   - 单块最多 8 条 / 400 token
 *   - 相邻块重叠 1 条，避免语义被切断
 */
const MAX_MSGS = 5;
const MAX_TOKENS = 300;
const SESSION_GAP_MS = 30 * 60 * 1000;

function ts(msg) {
  const t = Date.parse(msg.created_at || '');
  return Number.isFinite(t) ? t : 0;
}

function dayLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

function renderContent(msgs, characterName) {
  return msgs
    .map((m) => {
      const who = m.role === 'user' ? '用户' : characterName || '角色';
      const text = m.kind === 'game' ? `（${m.content.replace(/^（|）$/g, '')}）` : m.content;
      return `[${dayLabel(m.created_at)}] ${who}：${text}`;
    })
    .join('\n');
}

/** 用于嵌入的文本：去掉时间戳（所有块都有，纯噪声），保留说话人 */
function renderEmbedText(msgs, characterName) {
  return msgs
    .map((m) => {
      const who = m.role === 'user' ? '用户' : characterName || '角色';
      return `${who}：${m.content}`;
    })
    .join('\n');
}

/**
 * @param {Array} messages 按 id 升序、且都已滑出窗口的消息
 * @param {object} opts { characterName, countTokens(text) => number }
 * @returns {Array<{ content, msgFrom, msgTo, sessionId, tokenCount, hash }>}
 */
function buildChunks(messages, opts = {}) {
  const list = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  const countTokens = opts.countTokens || ((t) => t.length);
  const out = [];

  let i = 0;
  while (i < list.length) {
    const group = [list[i]];
    let tokens = countTokens(renderContent(group, opts.characterName));
    let j = i + 1;

    while (j < list.length && group.length < MAX_MSGS) {
      const gap = ts(list[j]) - ts(list[j - 1]);
      if (gap > SESSION_GAP_MS) break;
      const nextTokens = countTokens(renderContent([...group, list[j]], opts.characterName));
      if (nextTokens > MAX_TOKENS) break;
      group.push(list[j]);
      tokens = nextTokens;
      j += 1;
    }

    const content = renderContent(group, opts.characterName);
    const first = group[0];
    const last = group[group.length - 1];
    out.push({
      content,
      embedText: renderEmbedText(group, opts.characterName),
      msgFrom: first.id,
      msgTo: last.id,
      sessionId: `${first.character_id}-${new Date(ts(first)).toISOString().slice(0, 10)}`,
      tokenCount: tokens,
      hash: hashText(content),
    });

    // 重叠 1 条；若整组只有 1 条则前进 1
    i = group.length > 1 ? i + group.length - 1 : i + 1;
  }

  return out;
}

function hashText(text) {
  // 简单稳定的字符串哈希（FNV-1a 32bit 变体 + 长度），足够做去重
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16)}-${text.length}`;
}

module.exports = { buildChunks, renderContent, renderEmbedText, hashText, MAX_MSGS, MAX_TOKENS, SESSION_GAP_MS };
