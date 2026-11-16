/**
 * 暧 · 本机服务器入口
 * 一个端口同时提供：静态前端（site/） + 本地 API（/api/*）
 *
 *   node server.js            # 默认 http://0.0.0.0:3000
 *   PORT=8080 node server.js
 */
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`\n✖ 需要 Node.js 22.5 以上（当前 ${process.versions.node}）。`);
  console.error('  node:sqlite 是内置模块，低版本没有。请升级 Node 后重试。\n');
  process.exit(1);
}

const api = require('./server/api');
const DATA_DIR = path.resolve(path.dirname(require('./server/db').DB_PATH));
require('./server/providers').migrateLegacy();

// 上次嵌入模型切换没重建完就退出了？接着跑（后台，不阻塞启动）
try {
  const r = require('./server/memory/rebuild').resume();
  if (r.resumed && r.total > 0) console.log(`  继续重建历史记忆：剩余 ${r.total} 块`);
} catch (e) {
  console.warn('  重建任务续跑失败：', e.message);
}

const PORT = Number(process.env.PORT || 7788);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.join(__dirname, 'site');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function sendText(res, code, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(text);
}

function serveFile(res, file, immutable) {
  fs.readFile(file, (err, buf) => {
    if (err) return sendText(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=60',
    });
    res.end(buf);
  });
}

function handleRequest(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    return sendText(res, 400, 'Bad request');
  }

  if (pathname.startsWith('/api/')) {
    api
      .handle(req, res, new URL(req.url, `http://${req.headers.host || 'localhost'}`))
      .catch((e) => {
        console.error('[api]', e);
        if (!res.headersSent) {
          sendText(res, 500, JSON.stringify({ error: '服务器内部错误' }), 'application/json');
        } else {
          res.end();
        }
      });
    return;
  }

  if (pathname.startsWith('/uploads/')) {
    const file = path.normalize(path.join(DATA_DIR, pathname));
    if (!file.startsWith(DATA_DIR)) return sendText(res, 403, 'Forbidden');
    return serveFile(res, file, true);
  }

  if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
    return sendText(res, 503, '前端还没构建。请先运行：npm install && npm run build');
  }

  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.normalize(path.join(ROOT, pathname));
  if (!file.startsWith(ROOT)) return sendText(res, 403, 'Forbidden');

  const immutable = pathname.startsWith('/_next/static/');

  fs.stat(file, (err, stat) => {
    if (!err && stat.isFile()) return serveFile(res, file, immutable);

    const asIndex = path.join(file, 'index.html');
    fs.stat(asIndex, (e2, s2) => {
      if (!e2 && s2.isFile()) return serveFile(res, asIndex, false);
      if (!path.extname(pathname)) return serveFile(res, path.join(ROOT, 'index.html'), false);
      return sendText(res, 404, 'Not found');
    });
  });
}

function start(port, attempt = 0) {
  const server = http.createServer(handleRequest);

  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 10) {
      console.log(`  端口 ${port} 被占用，改用 ${port + 1}`);
      start(port + 1, attempt + 1);
      return;
    }
    console.error(`\n✖ 启动失败：${err.message}\n`);
    process.exit(1);
  });

  server.listen(port, HOST, () => {
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => i.address);

    // Electron 壳需要知道真实端口（端口可能被占用而顺延）
    if (process.env.NUAN_PORT_FILE) {
      try {
        fs.writeFileSync(process.env.NUAN_PORT_FILE, String(port));
      } catch {
        /* 写不了就算了，壳会走默认端口 */
      }
    }

    const url = `http://localhost:${port}`;
    console.log('\n  暧 · AI 陪伴 已启动');
    console.log('  ────────────────────────────────────────────');
    console.log(`  请在浏览器打开   ${url}`);
    for (const ip of lan) console.log(`  手机（同一局域网） http://${ip}:${port}`);
    console.log('  ────────────────────────────────────────────');
    console.log('  数据文件   data/app.db');
    console.log('  停止服务   Ctrl + C\n');
    if (process.platform === 'win32' && lan.length) {
      console.log('  手机连不上？多半是 Windows 防火墙拦了入站。');
      console.log(`  右键以管理员身份运行 open-firewall.bat，放行端口 ${port}。\n`);
    }

    if (process.env.OPEN_BROWSER === '1') openBrowser(url);
  });
}

function openBrowser(url) {
  try {
    const cmd =
      process.platform === 'win32'
        ? ['cmd.exe', ['/c', 'start', '', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]];
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* 打不开浏览器不影响服务 */
  }
}

start(PORT);
