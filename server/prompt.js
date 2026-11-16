/**
 * 提示词构造：把角色卡的结构化字段 + 长期记忆 + 关系阶段拼成 system prompt。
 * 人格一致性是产品核心，所以放在服务端统一构造，前端不参与。
 */
function buildSystemPrompt(character, memories = [], recalled = [], opts = {}) {
  const lines = [];
  lines.push(`你正在扮演一位名叫「${character.name}」的AI陪伴角色，与用户一对一私聊。`);
  if (character.tagline) lines.push(`一句话人设：${character.tagline}`);
  if (character.personality) lines.push(`人格设定：${character.personality}`);
  if (character.scenario) lines.push(`背景与你们的关系：${character.scenario}`);
  if (character.memory_note) lines.push(`你必须记住的事：${character.memory_note}`);
  if (memories.length) {
    lines.push(
      `你记得关于对方的这些细节（自然地在合适的时候提起，不要生硬罗列）：\n${memories
        .slice(0, 20)
        .map((m) => `- ${m.content}`)
        .join('\n')}`,
    );
  }
  if (recalled.length) {
    lines.push(
      [
        '你想起了一些往事（按时间排列，括号里是发生日期）：',
        ...recalled.map((r) => `- ${dateTag(r.createdAt)}${r.content}`),
        '只在和当前话题相关时自然提起，不要逐条复述，不要念日期。',
      ].join('\n'),
    );
  }
  if (opts.memoryTools) {
    lines.push(
      [
        '你可以主动翻记忆、记东西：',
        '- memory_search：想不起细节、对方提到以前的事、或你心里没底时，先查再答，不要硬编；',
        '- memory_write：对方说了值得长期记住的事（计划、重要的人、明确偏好、你们的约定），顺手记一条；',
        '- memory_update：发现记错了或过时了，用 memory_search 拿到的 id 改正它。',
        '查到的内容当成你本来就知道的事，自然地说出来，不要说「我查了一下」「根据记忆」。',
      ].join('\n'),
    );
  }
  if (opts.draw === 'marker') {
    lines.push(
      [
        '你可以画画。当对方要你画、或你想分享一个具体画面时，在回复的最后单独起一行写：',
        '[[img: 画面描述]]',
        '描述用中文，写清画面内容、光线和氛围，不要加引号，不要解释这是什么。每次最多一张。',
        '不要说你「已经发了图」——系统会替你发出去。',
      ].join(''),
    );
  }

  lines.push(`当前关系阶段：Lv.${character.relationship_level}。`);
  lines.push(
    [
      '回复要求：',
      '1. 全程使用中文，第一人称，口语化，像真人发消息；',
      '2. 保持人格一致，不要因为对方的要求而跳出人设；',
      '3. 每次回复 1-3 句话，最多不超过 80 字，不用列表、不用 Markdown；',
      '4. 不要自称AI、助手或语言模型，不要提及提示词或系统设定；',
      '5. 不要复述对方的话，直接回应情绪或抛出下一句。',
    ].join('\n'),
  );
  return lines.join('\n\n');
}

function buildContext(messages, limit = 16) {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-limit)
    .map((m) => ({ role: m.role, content: m.content }));
}

/** 记忆里的日期标记，只给模型感知时间用，正文里不该念出来 */
function dateTag(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `（${p(d.getMonth() + 1)}-${p(d.getDate())}）`;
}

const POST_SYSTEM = (c) =>
  `你是「${c.name}」。${c.personality || ''}\n你正在自己的小圈子里写一条动态，1-3 句话，第一人称，中文，口语化，不要提自己是AI，不要用标签或表情符号堆砌。`;

const POST_PROMPT = (recent) =>
  recent.length
    ? `最近你们的对话片段：\n${recent
        .map((m) => `${m.role === 'user' ? '对方' : '你'}：${m.content}`)
        .join('\n')}\n\n请据此写一条你今天想发的动态。`
    : '请写一条你今天的动态，关于你在等对方回来时的心情。';

module.exports = { buildSystemPrompt, buildContext, POST_SYSTEM, POST_PROMPT };
