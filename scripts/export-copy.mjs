/**
 * 把 next build 的静态导出（out/）同步到 site/，供 server.js 托管。
 * 放在非构建目录名下，避免发布时被当作构建产物忽略。
 */
import { cp, rm, access, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const from = path.join(root, 'out');
const to = path.join(root, 'site');

await access(from).catch(() => {
  console.error('[export-copy] 未找到 out/，请先运行 next build');
  process.exit(1);
});

// Next 会把 onnxruntime 的 wasm 当静态资源再发一份（约 15MB）。
// 我们运行时把 wasmPaths 指到了 /ort/，这份重复的用不到，删掉省体积。
const mediaDir = path.join(from, '_next', 'static', 'media');
try {
  const files = await readdir(mediaDir);
  for (const f of files) {
    if (/^ort-wasm.*\.wasm$/.test(f)) {
      await unlink(path.join(mediaDir, f));
      console.log(`[export-copy] 移除重复的 ${f}`);
    }
  }
} catch {
  /* 没有这个目录说明这次构建没产出 wasm，忽略 */
}

await rm(to, { recursive: true, force: true });
await cp(from, to, { recursive: true });
console.log('[export-copy] out/ -> site/ 完成');
