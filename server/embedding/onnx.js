/**
 * 本地嵌入模型：bge-small-zh-v1.5 INT8（ONNX）。
 *
 * 硬约束：EXE / APK 必须加载同一份 model_int8.onnx（字节级一致）。
 * 池化方式：CLS token（不是 mean pooling），随后 L2 归一化。
 */
const fs = require('node:fs');
const path = require('node:path');
const ort = require('onnxruntime-node');
const { loadTokenizer } = require('./tokenizer');

const MODEL_ID = 'bge-small-zh-v1.5-int8';
const DEFAULT_DIR = path.join(__dirname, '..', '..', 'models', 'bge-small-zh');
const MAX_TOKENS = 512;

let sessionPromise = null;
let tokenizer = null;
let modelDirResolved = null;

function resolveDir(dir) {
  const target = dir || process.env.EMBED_MODEL_DIR || DEFAULT_DIR;
  const onnx = path.join(target, 'model_int8.onnx');
  if (!fs.existsSync(onnx)) {
    throw new Error(`找不到嵌入模型：${onnx}（请先运行 node scripts/fetch-model.mjs）`);
  }
  return target;
}

async function getSession(dir) {
  const target = resolveDir(dir);
  if (!sessionPromise || modelDirResolved !== target) {
    modelDirResolved = target;
    tokenizer = loadTokenizer(target);
    sessionPromise = ort.InferenceSession.create(path.join(target, 'model_int8.onnx'), {
      intraOpNumThreads: Math.max(1, Math.min(4, require('node:os').cpus().length - 1)),
      graphOptimizationLevel: 'all',
    });
  }
  return sessionPromise;
}

function l2normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

/** 批量推理：同一批内按最长序列 padding，取 CLS + L2 归一化 */
async function embed(texts, opts = {}) {
  const list = Array.isArray(texts) ? texts : [texts];
  if (!list.length) return [];

  const session = await getSession(opts.dir);
  const batchSize = Math.max(1, Math.min(opts.batchSize || 8, list.length));
  const out = [];

  for (let i = 0; i < list.length; i += batchSize) {
    const batch = list.slice(i, i + batchSize);
    const encoded = batch.map((t) => tokenizer.encode(t, MAX_TOKENS));
    const maxLen = Math.max(...encoded.map((e) => e.ids.length));
    const n = batch.length;

    const ids = new BigInt64Array(n * maxLen);
    const mask = new BigInt64Array(n * maxLen);
    const types = new BigInt64Array(n * maxLen);
    encoded.forEach((e, row) => {
      for (let c = 0; c < maxLen; c++) {
        const idx = row * maxLen + c;
        if (c < e.ids.length) {
          ids[idx] = BigInt(e.ids[c]);
          mask[idx] = 1n;
        } else {
          ids[idx] = BigInt(tokenizer.padId);
          mask[idx] = 0n;
        }
        types[idx] = 0n;
      }
    });

    const feeds = {
      input_ids: new ort.Tensor('int64', ids, [n, maxLen]),
      attention_mask: new ort.Tensor('int64', mask, [n, maxLen]),
      token_type_ids: new ort.Tensor('int64', types, [n, maxLen]),
    };

    const result = await session.run(feeds);
    const hidden = result.last_hidden_state || result[Object.keys(result)[0]];
    const [, seq, dim] = hidden.dims;

    for (let row = 0; row < n; row++) {
      // CLS pooling：取第 0 个 token
      const vec = new Float32Array(dim);
      for (let d = 0; d < dim; d++) vec[d] = hidden.data[row * seq * dim + d];
      out.push(l2normalize(vec));
    }
  }

  return out;
}

function info() {
  return {
    id: MODEL_ID,
    dim: 512,
    pooling: 'cls',
    maxTokens: MAX_TOKENS,
    dir: modelDirResolved || DEFAULT_DIR,
    loaded: Boolean(sessionPromise),
  };
}

module.exports = { embed, info, MODEL_ID, DEFAULT_DIR, resolveDir };
