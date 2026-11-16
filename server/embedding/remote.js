/**
 * 自定义嵌入供应商：OpenAI 兼容的 /v1/embeddings。
 * 返回的向量统一做 L2 归一化，与内置模型保持同一口径（余弦=点积）。
 */
function l2normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

async function embedRemote(provider, texts) {
  const list = Array.isArray(texts) ? texts : [texts];
  if (!list.length) return [];

  const base = String(provider.baseUrl || '').replace(/\/+$/, '');
  const url = `${base}/embeddings`;
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: provider.model, input: list }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    throw new Error(`嵌入服务返回 ${res.status}${detail ? `：${detail}` : ''}`);
  }

  const data = await res.json();
  const rows = Array.isArray(data?.data) ? data.data : [];
  if (rows.length !== list.length) {
    throw new Error(`嵌入服务返回条数不匹配（期望 ${list.length}，实际 ${rows.length}）`);
  }
  return rows
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((r) => l2normalize(Float32Array.from(r.embedding)));
}

module.exports = { embedRemote };
