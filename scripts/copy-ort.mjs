/**
 * 把 onnxruntime-web 的 wasm 运行时拷到 public/ort/。
 *
 * 这两个文件是 15MB 的二进制，不进仓库（见 .gitignore），但浏览器里跑嵌入模型必须有，
 * 所以 build 之前自动从 node_modules 里拷一次；已经一致就跳过，不浪费时间。
 *
 *   node scripts/copy-ort.mjs
 */
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const SRC_DIR = path.join(root, 'node_modules', 'onnxruntime-web', 'dist');
const DST_DIR = path.join(root, 'public', 'ort');

// 只拷 SIMD + 多线程这一份：lib/local/embed.ts 里 wasmPaths 指的就是它
const FILES = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];

if (!existsSync(SRC_DIR)) {
  console.warn('[copy-ort] 没有 node_modules/onnxruntime-web，先 npm install');
  process.exit(0);
}

await mkdir(DST_DIR, { recursive: true });

for (const name of FILES) {
  const src = path.join(SRC_DIR, name);
  const dst = path.join(DST_DIR, name);
  if (!existsSync(src)) {
    console.warn(`[copy-ort] 源文件缺失，跳过：${name}`);
    continue;
  }
  if (existsSync(dst) && (await stat(dst)).size === (await stat(src)).size) continue;
  await copyFile(src, dst);
  console.log(`[copy-ort] 已拷贝 ${name}`);
}

console.log('[copy-ort] public/ort 就绪');
