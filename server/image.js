/**
 * 生图：调 OpenAI 兼容的 /v1/images/generations，把结果落到 data/uploads/chat/。
 *
 * 为什么存文件而不是 base64 进库：聊天图片属于「聊天域」，不进同步、不进角色卡，
 * 存文件可以让 app.db 保持轻量。真正发给用户的是 /uploads/chat/xxx.png 这个路径。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DB_PATH } = require('./db');

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

function chatDir() {
  const dir = path.join(path.dirname(DB_PATH), 'uploads', 'chat');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 按文件头判断真实格式，不信任 Content-Type */
function extOf(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return 'webp';
  return 'png';
}

function save(buf) {
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('生成的图片过大（超过 12MB）');
  const name = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}.${extOf(buf)}`;
  fs.writeFileSync(path.join(chatDir(), name), buf);
  return `/uploads/chat/${name}`;
}

/**
 * @param {{provider:{baseUrl:string,apiKey?:string,type?:string}, model:string, prompt:string, size?:string, signal?:AbortSignal}} opts
 * @returns {Promise<{url:string, bytes:number}>}
 */
async function generate({ provider, model, prompt, size = '1024x1024', signal }) {
  if (!provider) throw new Error('还没有配置生图供应商');
  if (!prompt || !prompt.trim()) throw new Error('缺少画面描述');

  const base = String(provider.baseUrl || '').replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

  const res = await fetch(`${base}/images/generations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model || undefined,
      prompt: prompt.trim(),
      n: 1,
      size,
      response_format: 'b64_json',
    }),
    signal: signal || AbortSignal.timeout(120000),
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new Error(`生图服务返回 ${res.status}${detail ? `：${detail}` : ''}`);
  }

  const data = await res.json();
  const item = Array.isArray(data?.data) ? data.data[0] : null;
  if (!item) throw new Error('生图服务没有返回图片');

  let buf = null;
  if (item.b64_json) {
    buf = Buffer.from(item.b64_json, 'base64');
  } else if (item.url) {
    // 有的服务只给外链，拉回来存本地，避免链接过期后图片消失
    const img = await fetch(item.url, { signal: signal || AbortSignal.timeout(120000) });
    if (!img.ok) throw new Error(`下载生成的图片失败：${img.status}`);
    buf = Buffer.from(await img.arrayBuffer());
  }

  if (!buf || !buf.length) throw new Error('生图服务返回的图片为空');

  return { url: save(buf), bytes: buf.length };
}

module.exports = { generate };
