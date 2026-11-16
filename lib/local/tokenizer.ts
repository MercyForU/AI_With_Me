/**
 * BERT WordPiece 分词器（手机版）。
 * 与 server/embedding/tokenizer.js 是同一套逻辑，只是改成从静态资源加载 tokenizer.json。
 * 两边必须一致，否则同一句话在手机和电脑上会算出不同向量。
 */
type Vocab = Record<string, number>;

export type Tokenizer = {
  encode: (text: string, maxLength?: number) => { ids: number[]; attentionMask: number[] };
  padId: number;
  vocabSize: number;
};

function isCJK(cp: number): boolean {
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

function isPunctuation(ch: string): boolean {
  const cp = ch.codePointAt(0) || 0;
  if (cp < 128) {
    return (
      (cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)
    );
  }
  return (cp >= 0x3000 && cp <= 0x303f) || (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x2000 && cp <= 0x206f);
}

const isSpace = (ch: string) => /\s/.test(ch);

function normalize(text: string, opts: { lowercase: boolean; stripAccents: boolean; handleChinese: boolean }): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) || 0;
    if (cp === 0 || cp === 0xfffd) continue;
    if (cp < 32) {
      if (ch === '\t' || ch === '\n' || ch === '\r') out += ' ';
      continue;
    }
    if (isSpace(ch)) {
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

function preTokenize(text: string): string[] {
  const words: string[] = [];
  let cur = '';
  const flush = () => {
    if (cur) words.push(cur);
    cur = '';
  };
  for (const ch of text) {
    if (isSpace(ch)) flush();
    else if (isPunctuation(ch)) {
      flush();
      words.push(ch);
    } else cur += ch;
  }
  flush();
  return words;
}

function wordPiece(word: string, vocab: Vocab, prefix: string, unk: string, maxChars: number): string[] {
  if (word.length > maxChars) return [unk];
  const pieces: string[] = [];
  let start = 0;
  while (start < word.length) {
    let end = word.length;
    let found: string | null = null;
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

let cached: Tokenizer | null = null;

export async function loadTokenizer(url = '/models/bge-small-zh/tokenizer.json'): Promise<Tokenizer> {
  if (cached) return cached;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`分词器加载失败：${res.status}`);
  const tj = (await res.json()) as {
    model?: { vocab?: Vocab; continuing_subword_prefix?: string; unk_token?: string; max_input_chars_per_word?: number };
    normalizer?: { lowercase?: boolean; strip_accents?: boolean | null; handle_chinese_chars?: boolean };
  };

  const model = tj.model || {};
  const vocab = model.vocab || {};
  const prefix = model.continuing_subword_prefix || '##';
  const unk = model.unk_token || '[UNK]';
  const maxChars = model.max_input_chars_per_word || 100;

  const n = tj.normalizer || {};
  const opts = {
    lowercase: n.lowercase !== false,
    stripAccents: n.strip_accents !== undefined && n.strip_accents !== null ? Boolean(n.strip_accents) : n.lowercase !== false,
    handleChinese: n.handle_chinese_chars !== false,
  };

  const idOf = (t: string) => (vocab[t] !== undefined ? vocab[t] : vocab[unk]);
  const clsId = idOf('[CLS]');
  const sepId = idOf('[SEP]');
  const padId = idOf('[PAD]');
  const unkId = vocab[unk];

  const encode = (text: string, maxLength = 512) => {
    const clean = normalize(String(text || ''), opts);
    const words = preTokenize(clean);
    const ids = [clsId];
    for (const w of words) {
      for (const p of wordPiece(w, vocab, prefix, unk, maxChars)) {
        ids.push(vocab[p] !== undefined ? vocab[p] : unkId);
        if (ids.length >= maxLength - 1) break;
      }
      if (ids.length >= maxLength - 1) break;
    }
    ids.push(sepId);
    return { ids, attentionMask: new Array(ids.length).fill(1) };
  };

  cached = { encode, padId, vocabSize: Object.keys(vocab).length };
  return cached;
}
