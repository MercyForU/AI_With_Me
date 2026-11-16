/**
 * BERT WordPiece 分词器（读 HuggingFace tokenizer.json，不依赖第三方库）。
 * 只实现 bge 系列需要的部分：BertNormalizer + BertPreTokenizer + WordPiece + [CLS]/[SEP]。
 */
const fs = require('node:fs');
const path = require('node:path');

function isCJK(cp) {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  );
}

function isPunctuation(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 128) {
    return (
      (cp >= 33 && cp <= 47) ||
      (cp >= 58 && cp <= 64) ||
      (cp >= 91 && cp <= 96) ||
      (cp >= 123 && cp <= 126)
    );
  }
  // 常用中日韩标点与全角符号
  return (
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x2000 && cp <= 0x206f)
  );
}

function isWhitespace(ch) {
  return /\s/.test(ch);
}

/** BertNormalizer：清洗控制符 → 中文两侧加空格 → 去重音 → 小写 */
function normalize(text, opts) {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === 0 || cp === 0xfffd) continue;
    if (cp < 32) {
      if (ch === '\t' || ch === '\n' || ch === '\r') out += ' ';
      continue;
    }
    if (isWhitespace(ch)) {
      out += ' ';
      continue;
    }
    if (opts.handleChinese && isCJK(cp)) {
      out += ` ${ch} `;
      continue;
    }
    out += ch;
  }
  if (opts.stripAccents) out = out.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (opts.lowercase) out = out.toLowerCase();
  return out;
}

/** BertPreTokenizer：按空白切分，标点单独成词 */
function preTokenize(text) {
  const words = [];
  let cur = '';
  const flush = () => {
    if (cur) words.push(cur);
    cur = '';
  };
  for (const ch of text) {
    if (isWhitespace(ch)) {
      flush();
    } else if (isPunctuation(ch)) {
      flush();
      words.push(ch);
    } else {
      cur += ch;
    }
  }
  flush();
  return words;
}

/** WordPiece 贪心最长匹配 */
function wordPiece(word, vocab, prefix, unk, maxChars) {
  if (word.length > maxChars) return [unk];
  const pieces = [];
  let start = 0;
  while (start < word.length) {
    let end = word.length;
    let found = null;
    while (start < end) {
      let sub = word.slice(start, end);
      if (start > 0) sub = prefix + sub;
      if (Object.prototype.hasOwnProperty.call(vocab, sub)) {
        found = sub;
        break;
      }
      end -= 1;
    }
    if (found === null) return [unk];
    pieces.push(found);
    start = end;
  }
  return pieces;
}

function loadTokenizer(modelDir) {
  const file = path.join(modelDir, 'tokenizer.json');
  const tj = JSON.parse(fs.readFileSync(file, 'utf8'));
  const model = tj.model || {};
  const vocab = model.vocab || {};
  const prefix = model.continuing_subword_prefix || '##';
  const unk = model.unk_token || '[UNK]';
  const maxChars = model.max_input_chars_per_word || 100;

  const n = tj.normalizer || {};
  const opts = {
    lowercase: n.lowercase !== false,
    stripAccents: n.strip_accents !== undefined ? Boolean(n.strip_accents) : n.lowercase !== false,
    handleChinese: n.handle_chinese_chars !== false,
  };

  const idOf = (t) => (vocab[t] !== undefined ? vocab[t] : vocab[unk]);
  const clsId = idOf('[CLS]');
  const sepId = idOf('[SEP]');
  const padId = idOf('[PAD]');
  const unkId = vocab[unk];

  /** 返回 { ids, attentionMask }（已含 [CLS]/[SEP]，超长截断） */
  function encode(text, maxLength = 512) {
    const clean = normalize(String(text || ''), opts);
    const words = preTokenize(clean);
    const ids = [clsId];
    for (const w of words) {
      const pieces = wordPiece(w, vocab, prefix, unk, maxChars);
      for (const p of pieces) {
        ids.push(vocab[p] !== undefined ? vocab[p] : unkId);
        if (ids.length >= maxLength - 1) break;
      }
      if (ids.length >= maxLength - 1) break;
    }
    ids.push(sepId);
    return { ids, attentionMask: new Array(ids.length).fill(1) };
  }

  return { encode, clsId, sepId, padId, unkId, vocabSize: Object.keys(vocab).length };
}

module.exports = { loadTokenizer };
