/**
 * 手机版提示词构造：与电脑端 server/prompt.js 保持同一口径。
 * 两边必须同步修改，否则同一个角色在手机和电脑上性格会不一样。
 */
export type PromptCharacter = {
  name: string;
  tagline?: string | null;
  personality?: string | null;
  scenario?: string | null;
  memory_note?: string | null;
  relationship_level: number;
};

export function buildSystemPrompt(
  character: PromptCharacter,
  memories: Array<{ content: string }> = [],
  recalled: Array<{ content: string }> = [],
  opts: { draw?: 'marker' | 'tool' | null } = {},
): string {
  const lines: string[] = [];
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
      `你记得的这些往事（按时间排列，只在和当前话题相关时自然提起，不要逐条复述、不要念时间戳）：\n${recalled
        .map((r) => `- ${r.content}`)
        .join('\n')}`,
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

export function buildContext(
  messages: Array<{ role: string; content: string }>,
  limit = 16,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-limit)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
}

export const POST_SYSTEM = (c: PromptCharacter) =>
  `你是「${c.name}」。${c.personality || ''}\n你正在自己的小圈子里写一条动态，1-3 句话，第一人称，中文，口语化，不要提自己是AI，不要用标签或表情符号堆砌。`;

export const POST_PROMPT = (recent: Array<{ role: string; content: string }>) =>
  recent.length
    ? `最近你们的对话片段：\n${recent
        .map((m) => `${m.role === 'user' ? '对方' : '你'}：${m.content}`)
        .join('\n')}\n\n请据此写一条你今天想发的动态。`
    : '请写一条你今天的动态，关于你在等对方回来时的心情。';
