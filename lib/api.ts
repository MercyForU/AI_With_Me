/**
 * API 客户端。两种运行形态共用同一组调用：
 * - 浏览器：fetch 打 /api/*（电脑上的 server.js）
 * - APK：直接调 lib/local/server.ts 的本地实现，不发网络请求
 *
 * 路由路径与返回结构两边完全一致，所以 store 和组件都不用关心自己跑在哪。
 */
import { isNativeApp } from './base';
import { handle as localHandle, runChat as localChat } from './local/server';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  if (isNativeApp()) {
    const res = await localHandle(
      opts.method || 'GET',
      path,
      (opts.body as Record<string, unknown>) || {},
    );
    if (res.status >= 400) {
      const message = (res.data as { error?: string })?.error || `请求失败（${res.status}）`;
      throw new ApiError(message, res.status);
    }
    return res.data as T;
  }

  const res = await fetch(path, {
    method: opts.method || 'GET',
    credentials: 'include',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const message =
      (data as { error?: string })?.error || `请求失败（${res.status}）`;
    throw new ApiError(message, res.status);
  }
  return data as T;
}

export function errorMessage(error: unknown, fallback = '出了点问题，请稍后再试'): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return fallback;
}

export type ChatStreamHandlers = {
  onUser?: (message: unknown) => void;
  onDelta?: (text: string) => void;
  onAssistant?: (message: unknown, meta: { partial?: boolean; affinity?: number; level?: number }) => void;
  onImage?: (message: unknown, meta: { affinity?: number; level?: number }) => void;
  onError?: (message: string) => void;
};

/**
 * 流式对话：解析后端 SSE。
 * 返回完整文本（服务端已落库，这里只负责渲染）。
 */
export async function streamChat(
  payload: { characterId: number; input: string; persistUser?: boolean },
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  if (isNativeApp()) {
    await localChat(payload.characterId, payload.input, handlers, {
      persistUser: payload.persistUser !== false,
    });
    return;
  }

  const res = await fetch('/api/chat', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });

  if (!res.ok || !res.body) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    let message = `请求失败（${res.status}）`;
    try {
      message = JSON.parse(detail)?.error || message;
    } catch {
      /* ignore */
    }
    throw new ApiError(message, res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';

    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(raw);
      } catch {
        continue;
      }
      if (evt.event === 'user') handlers.onUser?.(evt.message);
      else if (evt.event === 'delta') handlers.onDelta?.(String(evt.text || ''));
      else if (evt.event === 'assistant') {
        handlers.onAssistant?.(evt.message, {
          partial: Boolean(evt.partial),
          affinity: evt.affinity as number | undefined,
          level: evt.level as number | undefined,
        });
      } else if (evt.event === 'image') {
        handlers.onImage?.(evt.message, {
          affinity: evt.affinity as number | undefined,
          level: evt.level as number | undefined,
        });
      } else if (evt.event === 'error') handlers.onError?.(String(evt.error || '回复失败'));
    }
  }
}

/** 触发浏览器下载一段 JSON */
export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
