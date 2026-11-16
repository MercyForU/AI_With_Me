/**
 * 下载 bge-small-zh-v1.5 的 ONNX INT8 权重与分词配置。
 *
 *   node scripts/fetch-model.mjs            # 下载并校验
 *   node scripts/fetch-model.mjs --verify   # 只校验已存在的文件
 *
 * 只从 Xenova/bge-small-zh-v1.5 取，EXE / APK 共用同一份文件。
 * 国内直连 huggingface.co 常 502，默认走 hf-mirror.com。
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'models', 'bge-small-zh');
const REPO = 'Xenova/bge-small-zh-v1.5';
const MIRRORS = ['https://hf-mirror.com', 'https://huggingface.co'];

const FILES = [
  { path: 'onnx/model_int8.onnx', name: 'model_int8.onnx', size: 23903394 },
  { path: 'tokenizer.json', name: 'tokenizer.json' },
  { path: 'config.json', name: 'config.json' },
  { path: 'tokenizer_config.json', name: 'tokenizer_config.json' },
  { path: 'special_tokens_map.json', name: 'special_tokens_map.json' },
];

// 校验值：改动模型文件必须同步更新这里，否则两端可能出现不一致权重
const SHA256 = {
  'model_int8.onnx': 'b9837c19ce154ff0726d398ee77abbc03a7faf0476c6f93016c84e531be7ebb5',
};

const verifyOnly = process.argv.includes('--verify');

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function fetchOne(file) {
  const dest = join(OUT_DIR, file.name);
  const url = `${MIRRORS[0]}/${REPO}/resolve/main/${file.path}`;

  if (existsSync(dest) && statSync(dest).size > 0) {
    console.log(`  跳过（已存在） ${file.name}`);
    return;
  }
  if (verifyOnly) throw new Error(`缺少 ${file.name}`);

  console.log(`  下载 ${file.name} …`);
  let lastErr;
  for (const base of MIRRORS) {
    try {
      await download(`${base}/${REPO}/resolve/main/${file.path}`, dest);
      console.log(`  完成 ${file.name}  ${(statSync(dest).size / 1048576).toFixed(1)} MB  (${base})`);
      return;
    } catch (e) {
      lastErr = e;
      console.log(`  ${base} 失败：${e.message}，换下一个源`);
    }
  }
  throw new Error(`${file.name} 下载失败：${lastErr?.message}`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`\n模型目录：${OUT_DIR}\n`);

  for (const f of FILES) await fetchOne(f);

  console.log('\n校验 SHA256 …');
  let bad = 0;
  for (const [name, want] of Object.entries(SHA256)) {
    const file = join(OUT_DIR, name);
    if (!existsSync(file)) {
      console.log(`  ✖ ${name} 不存在`);
      bad++;
      continue;
    }
    const got = sha256(file);
    if (got === want) {
      console.log(`  ✔ ${name}\n    ${got}`);
    } else {
      console.log(`  ✖ ${name}\n    期望 ${want}\n    实际 ${got}`);
      bad++;
    }
  }

  const onnx = join(OUT_DIR, 'model_int8.onnx');
  if (existsSync(onnx)) {
    const size = statSync(onnx).size;
    console.log(`\n体积：${size} 字节（期望 23903394）${size === 23903394 ? ' ✔' : ' ✖'}`);
  }

  if (bad) {
    console.error('\n校验未通过，请删除 models/bge-small-zh 后重试。\n');
    process.exit(1);
  }
  console.log('\n全部就绪。EXE 与 APK 请共用这一份文件。\n');
}

main().catch((e) => {
  console.error('\n失败：', e.message, '\n');
  process.exit(1);
});
