/**
 * 手机版的内置嵌入模型：bge-small-zh-v1.5 INT8，用 onnxruntime-web 在 WebView 里跑 WASM。
 *
 * 与电脑端（onnxruntime-node）加载的是**同一个** model_int8.onnx，CLS 池化 + L2 归一化，
 * 所以两边算出来的向量可以直接比较，将来同步记忆时不用重算。
 *
 * 三个必须注意的点：
 * 1. wasmPaths 指向包内 /ort/，否则 ORT 会去 CDN 拉（离线就废了）。
 * 2. numThreads = 1：多线程需要 COOP/COEP 响应头，Capacitor 的本地服务给不了。
 * 3. 用动态 import：这段代码只在真正要用时加载，避免首屏被 15MB wasm 拖慢。
 */

const MODEL_URL = '/models/bge-small-zh/model_int8.onnx';
const MAX_TOKENS = 512;
export const MODEL_ID = 'bge-small-zh-v1.5-int8';
export const MODEL_DIM = 512;

// 用 wasm-only 构建：避免把 webgpu/jsep 那一套 30MB 也拖进来
import type * as OrtWasm from 'onnxruntime-web/wasm';

type Ort = typeof OrtWasm;

let ortPromise: Promise<Ort> | null = null;
let sessionPromise: Promise<OrtWasm.InferenceSession> | null = null;
let tokenizerPromise: Promise<import('./tokenizer').Tokenizer> | null = null;
let failed: string | null = null;
let loaded = false;

async function getOrt(): Promise<Ort> {
  if (!ortPromise) {
    ortPromise = import('onnxruntime-web/wasm').then((mod) => {
      const ort = (mod as unknown as { default?: Ort }).default ?? mod;
      ort.env.wasm.wasmPaths = '/ort/';
      ort.env.wasm.numThreads = 1;
      ort.env.logLevel = 'error';
      return ort;
    });
  }
  return ortPromise;
}

async function getSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort = await getOrt();
      return ort.InferenceSession.create(MODEL_URL, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
    })();
  }
  return sessionPromise;
}

async function getTokenizer() {
  if (!tokenizerPromise) tokenizerPromise = import('./tokenizer').then((m) => m.loadTokenizer());
  return tokenizerPromise;
}

function l2normalize(vec: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

/** 预热：首屏之后调用，避免第一次聊天时才卡一下 */
export async function warmup(): Promise<boolean> {
  try {
    await embed(['预热']);
    return true;
  } catch {
    return false;
  }
}

export function status() {
  return { ready: loaded, failed, model: MODEL_ID, dim: MODEL_DIM };
}

/**
 * 批量嵌入。失败会抛错，调用方（memory）负责降级为关键词检索。
 */
export async function embed(texts: string[]): Promise<Float32Array[]> {
  const list = Array.isArray(texts) ? texts : [texts];
  if (!list.length) return [];

  const [ort, session, tokenizer] = await Promise.all([getOrt(), getSession(), getTokenizer()]);

  const encoded = list.map((t) => tokenizer.encode(t, MAX_TOKENS));
  const maxLen = Math.max(...encoded.map((e) => e.ids.length));
  const n = list.length;

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
  const hidden = (result.last_hidden_state ?? result[Object.keys(result)[0]]) as OrtWasm.Tensor;
  const dims = hidden.dims as number[];
  const seq = dims[1];
  const dim = dims[2];
  const data = hidden.data as Float32Array;

  const out: Float32Array[] = [];
  for (let row = 0; row < n; row++) {
    // CLS pooling：取第 0 个 token
    const vec = new Float32Array(dim);
    for (let d = 0; d < dim; d++) vec[d] = data[row * seq * dim + d];
    out.push(l2normalize(vec));
  }

  loaded = true;
  failed = null;
  return out;
}
