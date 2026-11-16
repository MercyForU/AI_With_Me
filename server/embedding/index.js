/**
 * 嵌入入口：按设置分发到「内置本地模型」或「自定义 API 供应商」。
 * 记忆模块只依赖这里，不直接碰具体实现。
 */
const { getSetting } = require('../db');

function sourceId() {
  const v = getSetting('embed_source', 'builtin');
  return v || 'builtin';
}

function info() {
  const src = sourceId();
  if (src === 'builtin') {
    const local = require('./onnx');
    return { source: 'builtin', id: local.MODEL_ID, dim: 512, pooling: 'cls', label: '内置 bge-small-zh-v1.5 (INT8)' };
  }
  const providers = require('../providers');
  const p = providers.list('embedding').find((x) => String(x.id) === String(src));
  const model = p ? p.preferredModel || p.models[0] || '' : '';
  return {
    source: 'provider',
    providerId: Number(src),
    // 用 id 而不是 label：改个名字不应该让全部历史向量「失效」
    id: `provider:${src}:${model}`,
    model,
    dim: null,
    label: p ? `${p.label}（自定义）` : '自定义嵌入供应商',
  };
}

async function embed(texts) {
  const src = sourceId();
  if (src === 'builtin') {
    return require('./onnx').embed(texts);
  }
  const providers = require('../providers');
  const config = providers.configById(Number(src));
  if (!config) throw new Error('嵌入供应商不存在，请重新选择');
  const pub = providers.getPublic(Number(src));
  const model = pub?.preferredModel || pub?.models?.[0] || '';
  if (!model) throw new Error('这个嵌入供应商还没有选择模型');
  const { embedRemote } = require('./remote');
  return embedRemote({ ...config, model }, texts);
}

/** 记忆里存模型标识用 */
function currentModelId() {
  return info().id;
}

module.exports = { embed, info, currentModelId, sourceId };
