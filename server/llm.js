/**
 * 模型调用：把请求转发到指定的供应商（OpenAI 兼容 或 Ollama）。
 * 供应商配置由 providers.js 提供，Key 已解密，只在服务端内存里存在。
 */

function endpointOf(provider) {
  return provider.type === 'ollama'
    ? `${provider.baseUrl}/api/chat`
    : `${provider.baseUrl}/chat/completions`;
}

function bodyOf(provider, model, messages, stream, tools, toolChoice) {
  if (provider.type === 'ollama') {
    return { model, messages, stream, options: { temperature: 0.9 } };
  }
  const body = { model, messages, stream, temperature: 0.9 };
  // 只有声明支持工具调用的供应商才带 tools，否则中转可能直接 400
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = toolChoice || 'auto';
  }
  return body;
}

/** 累积流式返回的 tool_calls（按 index 合并分片） */
function mergeToolCall(acc, piece) {
  const i = piece.index ?? acc.length;
  const cur = acc[i] || { id: '', name: '', arguments: '' };
  if (piece.id) cur.id = piece.id;
  if (piece.function?.name) cur.name = piece.function.name;
  if (piece.function?.arguments) cur.arguments += piece.function.arguments;
  acc[i] = cur;
}

/**
 * 流式对话。onDelta 收到增量文本；返回完整文本。
 * 上游中断会抛错，已产生的文本放在 error.partial 里。
 */
async function streamChat({ provider, model, messages, signal, onDelta, tools, toolChoice }) {
  if (!provider) throw new Error('没有可用的模型供应商，请先在设置里配置');
  if (provider.type === 'openai' && !provider.apiKey) {
    throw new Error('这个供应商还没有填 API Key');
  }

  const headers = { 'Content-Type': 'application/json' };
  if (provider.type === 'openai') headers.Authorization = `Bearer ${provider.apiKey}`;

  const res = await fetch(endpointOf(provider), {
    method: 'POST',
    headers,
    body: JSON.stringify(bodyOf(provider, model, messages, true, tools, toolChoice)),
    signal,
  });

  if (!res.ok || !res.body) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }

    // 不少聚合代理不支持 stream=true，会直接 5xx。回退一次非流式再判断。
    let plainText = '';
    let plainStatus = 0;
    let plainDetail = '';
    let plainTools = [];
    try {
      const plain = await fetch(endpointOf(provider), {
        method: 'POST',
        headers,
        body: JSON.stringify(bodyOf(provider, model, messages, false, tools, toolChoice)),
        signal,
      });
      plainStatus = plain.status;
      if (plain.ok) {
        const data = await plain.json();
        plainText =
          data?.choices?.[0]?.message?.content ??
          data?.message?.content ??
          (typeof data?.response === 'string' ? data.response : '');
        const calls = data?.choices?.[0]?.message?.tool_calls;
        if (Array.isArray(calls)) {
          plainTools = calls.map((c) => ({
            id: c.id || '',
            name: c.function?.name || '',
            arguments: c.function?.arguments || '',
          }));
        }
      } else {
        try {
          plainDetail = (await plain.text()).slice(0, 300);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* 回退请求本身失败，按原始错误抛出 */
    }

    if (plainText || plainTools.length) {
      if (plainText) onDelta?.(plainText, plainText);
      return { text: plainText, toolCalls: plainTools };
    }

    if (plainStatus && plainStatus !== res.status) {
      throw new Error(
        `流式请求 ${res.status}${detail ? `（${detail}）` : ''}；非流式重试 ${plainStatus}${
          plainDetail ? `（${plainDetail}）` : ''
        }`,
      );
    }

    throw new Error(`模型服务返回 ${res.status}${detail ? `：${detail}` : ''}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const toolAcc = [];

  const consume = (raw) => {
    const line = raw.trim();
    if (!line) return;
    const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
    if (!payload || payload === '[DONE]') return;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      return;
    }
    const choice = obj?.choices?.[0];
    const pieces = choice?.delta?.tool_calls || choice?.message?.tool_calls;
    if (Array.isArray(pieces)) {
      for (const piece of pieces) mergeToolCall(toolAcc, piece);
    }

    const delta =
      choice?.delta?.content ??
      choice?.message?.content ??
      obj?.message?.content ??
      (typeof obj?.response === 'string' ? obj.response : '');
    if (delta) {
      text += delta;
      onDelta?.(delta, text);
    }
  };

  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const raw of lines) consume(raw);
    }
    // 有些代理会忽略 stream，直接返回一段没有换行结尾的 JSON，这里兜住残留
    if (buffer.trim()) consume(buffer);
  } catch (e) {
    e.partial = text;
    throw e;
  }

  return { text, toolCalls: toolAcc.filter(Boolean) };
}

/** 一次性生成（角色动态用）：只要文本 */
async function completeOnce({ provider, model, messages }) {
  const r = await streamChat({ provider, model, messages });
  return r.text;
}

module.exports = { streamChat, completeOnce };
