/**
 * 手机版的图片处理：生图调用 + 压缩。
 *
 * 与电脑端的差别：手机没有 data/uploads 目录可给 WebView 直接访问，
 * 所以图片统一压缩后以 data URL 存进数据库（768px / JPEG 0.85，约 80–150KB）。
 * 这样不需要额外的文件系统插件，备份和将来同步也只需要搬数据库。
 */
import { CapacitorHttp } from '@capacitor/core';

/** 把图片压到指定最长边，返回 data URL */
export async function compressDataUrl(input: string, maxSize = 768, quality = 0.85): Promise<string> {
  const img = await loadImage(input);
  const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return input;
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', quality);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

export type ImageProvider = { type: 'openai' | 'ollama'; baseUrl: string; apiKey?: string };

/** 调生图服务，返回可直接放进 <img> 的 data URL */
export async function generateImage(
  provider: ImageProvider,
  model: string,
  prompt: string,
): Promise<{ url: string; bytes: number }> {
  if (!provider) throw new Error('还没有配置生图供应商');
  if (!prompt.trim()) throw new Error('缺少画面描述');

  const base = String(provider.baseUrl || '').replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

  const res = await CapacitorHttp.request({
    url: `${base}/images/generations`,
    method: 'POST',
    headers,
    data: {
      model: model || undefined,
      prompt: prompt.trim(),
      n: 1,
      size: '1024x1024',
      response_format: 'b64_json',
    },
    connectTimeout: 15000,
    readTimeout: 180000,
  });

  if (res.status >= 400) {
    const detail = typeof res.data === 'string' ? res.data.slice(0, 200) : JSON.stringify(res.data).slice(0, 200);
    throw new Error(`生图服务返回 ${res.status}${detail ? `：${detail}` : ''}`);
  }

  const obj = res.data as { data?: Array<{ b64_json?: string; url?: string }> };
  const item = obj?.data?.[0];
  if (!item) throw new Error('生图服务没有返回图片');

  let src = '';
  if (item.b64_json) src = `data:image/png;base64,${item.b64_json}`;
  else if (item.url) src = item.url;
  if (!src) throw new Error('生图服务返回的图片为空');

  // 压缩后再入库，避免一张图把数据库撑大
  let url = src;
  try {
    url = await compressDataUrl(src, 768, 0.85);
  } catch {
    // 外链图片可能因为跨域无法读像素，那就直接用原链接
    url = src;
  }
  return { url, bytes: url.length };
}
