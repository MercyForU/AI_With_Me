/**
 * 手机版的模型调用。
 *
 * 为什么用 CapacitorHttp 而不是 fetch：
 * WebView 里 fetch 打外部 API 会带上 Origin: https://localhost，
 * 不少模型服务会因此拒绝（CORS）。CapacitorHttp 走原生请求，不受同源策略约束。
 *
 * 代价：拿不到流式响应，只能整段返回。所以手机版是「转圈 → 整段出现」，
 * 没有逐字效果。这是原生 HTTP 桥的固有限制，不是没做。
 */
import { CapacitorHttp } from '@capacitor/core';

export type LlmProvider = {
  type: 'openai' | 'ollama';
  baseUrl: string;
  apiKey?: string;
  supportsTools?: boolean;
};

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** 助手发起工具调用时带上，OpenAI 兼容格式 */
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  /** role = tool 时，对应哪一次调用 */
  tool_call_id?: string;
};

function trimBase(url: string) {
  return String(url || '').replace(/\/+$/, '');
}

async function request(
  url: string,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  data?: unknown,
): Promise<{ status: number; data: unknown; text: string }> {
  const res = await CapacitorHttp.request({
    url,
    method,
    headers,
    data,
    connectTimeout: 15000,
    readTimeout: 180000,
  });
  const raw = res.data;
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  return { status: res.status, data: raw, text };
}

function headersOf(p: LlmProvider): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (p.type === 'openai' && p.apiKey) h.Authorization = `Bearer ${p.apiKey}`;
  return h;
}

/** 拉模型列表（OpenAI 兼容 /models，Ollama /api/tags） */
export async function listModels(p: LlmProvider): Promise<string[]> {
  const base = trimBase(p.baseUrl);
  if (p.type === 'ollama') {
    const r = await request(`${base}/api/tags`, 'GET', headersOf(p));
    if (r.status >= 400) throw new Error(`返回 ${r.status}`);
    const obj = r.data as { models?: Array<{ name?: string }> };
    return (obj?.models || []).map((m) => String(m.name || '')).filter(Boolean);
  }
  const r = await request(`${base}/models`, 'GET', headersOf(p));
  if (r.status >= 400) throw new Error(`返回 ${r.status}`);
  const obj = r.data as { data?: Array<{ id?: string }> };
  return (obj?.data || []).map((m) => String(m.id || '')).filter(Boolean);
}

export type ToolCall = { id: string; name: string; arguments: string };

/** 一次性对话（非流式） */
export async function chatOnce({
  provider,
  model,
  messages,
  tools,
}: {
  provider: LlmProvider;
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
}): Promise<{ text: string; toolCalls: ToolCall[] }> {
  if (!provider) throw new Error('没有可用的模型供应商，请先在设置里配置');
  if (provider.type === 'openai' && !provider.apiKey) throw new Error('这个供应商还没有填 API Key');

  const base = trimBase(provider.baseUrl);
  const url = provider.type === 'ollama' ? `${base}/api/chat` : `${base}/chat/completions`;

  const body: Record<string, unknown> =
    provider.type === 'ollama'
      ? { model, messages, stream: false, options: { temperature: 0.9 } }
      : { model, messages, stream: false, temperature: 0.9 };

  if (provider.type === 'openai' && tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }


  const r = await request(url, 'POST', headersOf(provider), body);

  if (r.status >= 400) {
    let detail = '';
    try {
      const obj = r.data as { error?: { message?: string } | string };
      detail = typeof obj?.error === 'string' ? obj.error : obj?.error?.message || '';
    } catch {
      detail = '';
    }
    throw new Error(`模型服务返回 ${r.status}${detail ? `：${detail.slice(0, 200)}` : ''}`);
  }

  const obj = r.data as {
    choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
    message?: { content?: string };
  };

  const text = obj?.choices?.[0]?.message?.content ?? obj?.message?.content ?? '';
  const calls = obj?.choices?.[0]?.message?.tool_calls || [];
  return {
    text: String(text || ''),
    toolCalls: calls.map((c) => ({
      id: c.id || '',
      name: c.function?.name || '',
      arguments: c.function?.arguments || '',
    })),
  };
}

/**
 * 逐字流式：优先用 fetch 读 SSE（真流式），失败则退回 CapacitorHttp 整段返回，
 * 再把整段按小片吐出去，保证视觉上还是「一个字一个字冒出来」。
 *
 * 为什么要 try fetch：WebView 里 fetch 打外部 API 会带 Origin: https://localhost，
 * 支持 CORS 的服务能直接流式；不支持的会抛错，那时才退。
 */
export async function chatStream({
  provider,
  model,
  messages,
  tools,
  toolChoice,
  onDelta,
  signal,
}: {
  provider: LlmProvider;
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  /** 指定必须调用的工具（生图兜底重试用） */
  toolChoice?: unknown;
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}): Promise<{ text: string; toolCalls: ToolCall[] }> {
  const base = trimBase(provider.baseUrl);

  if (provider.type === 'openai' && provider.apiKey) {
    try {
      const body: Record<string, unknown> = { model, messages, stream: true, temperature: 0.9 };
      if (tools && tools.length) {
        body.tools = tools;
        body.tool_choice = toolChoice || 'auto';
      }
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: headersOf(provider),
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let text = '';
      const toolAcc: ToolCall[] = [];

      const consume = (raw: string) => {
        const line = raw.trim();
        if (!line) return;
        const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
        if (!payload || payload === '[DONE]') return;
        let obj: {
          choices?: Array<{
            delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
            message?: { content?: string };
          }>;
        };
        try {
          obj = JSON.parse(payload);
        } catch {
          return;
        }
        const choice = obj?.choices?.[0];
        const pieces = choice?.delta?.tool_calls;
        if (Array.isArray(pieces)) {
          for (const p of pieces) {
            const i = p.index ?? toolAcc.length;
            const cur = toolAcc[i] || { id: '', name: '', arguments: '' };
            if (p.id) cur.id = p.id;
            if (p.function?.name) cur.name = p.function.name;
            if (p.function?.arguments) cur.arguments += p.function.arguments;
            toolAcc[i] = cur;
          }
        }
        const delta = choice?.delta?.content ?? choice?.message?.content ?? '';
        if (delta) {
          text += delta;
          onDelta?.(delta);
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) consume(line);
      }
      if (buffer.trim()) consume(buffer);

      if (text || toolAcc.filter(Boolean).length) {
        return { text, toolCalls: toolAcc.filter(Boolean) };
      }
      throw new Error('stream empty');
    } catch {
      /* 落到下面的非流式 */
    }
  }

  const r = await chatOnce({ provider, model, messages, tools });
  await reveal(r.text, onDelta);
  return r;
}

/** 把整段文本分片吐出，模拟逐字效果（非流式时的兜底） */
async function reveal(text: string, onDelta?: (t: string) => void) {
  if (!text || !onDelta) return;
  const step = Math.max(1, Math.ceil(text.length / 90));
  for (let i = 0; i < text.length; i += step) {
    onDelta(text.slice(i, i + step));
    await new Promise((r) => setTimeout(r, 12));
  }
}

/** 诊断用：发一句「你好」看上游到底返回什么 */
export async function chatProbe(provider: LlmProvider, model: string) {
  const base = trimBase(provider.baseUrl);
  const url = provider.type === 'ollama' ? `${base}/api/chat` : `${base}/chat/completions`;
  const body =
    provider.type === 'ollama'
      ? { model, messages: [{ role: 'user', content: '你好' }], stream: false }
      : { model, messages: [{ role: 'user', content: '你好' }], stream: false, max_tokens: 16 };
  const r = await request(url, 'POST', headersOf(provider), body);
  return { ok: r.status < 400, status: r.status, model, url, body: r.text.slice(0, 600) };
}
