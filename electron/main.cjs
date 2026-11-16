/**
 * Electron 桌面壳。
 *
 * 思路：不重写任何东西，直接把现有的 Node 后端跑在主进程里，
 * 窗口加载 http://127.0.0.1:<port>。等于把 start.bat 装进一个没有黑框的窗口。
 *
 * 两个必须处理的点：
 * 1. 数据目录不能放在安装目录（Program Files 不可写），改到 %APPDATA%\暧\data。
 * 2. 端口可能被占用，服务会顺延，所以让它把真实端口写到文件里，这里等文件出现。
 */
const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// 单实例：重复点图标时聚焦已有窗口，而不是起第二个服务
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const userData = app.getPath('userData');
const dataDir = path.join(userData, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const portFile = path.join(userData, 'port.txt');
try {
  fs.unlinkSync(portFile);
} catch {
  /* 上次没清掉，无所谓 */
}

process.env.DB_PATH = path.join(dataDir, 'app.db');
process.env.NUAN_PORT_FILE = portFile;
process.env.PORT = process.env.PORT || '17880';
process.env.HOST = '127.0.0.1'; // 桌面版不对外，别把端口暴露到局域网

let mainWindow = null;

function waitForPort(timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      try {
        const txt = fs.readFileSync(portFile, 'utf8').trim();
        if (txt) return resolve(Number(txt));
      } catch {
        /* 还没写出来 */
      }
      if (Date.now() - started > timeoutMs) return reject(new Error('服务启动超时'));
      setTimeout(tick, 120);
    };
    tick();
  });
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    title: '暧',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(url);

  // 外链走系统浏览器，不要在应用窗口里打开
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });

  // 自测模式：加载完截图再退出，用于无人值守验证
  if (process.env.NUAN_SMOKE) {
    mainWindow.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 2500));
      try {
        const img = await mainWindow.webContents.capturePage();
        const out = process.env.NUAN_SMOKE;
        fs.writeFileSync(out, img.toPNG());
        console.log('smoke screenshot:', out);
      } catch (e) {
        console.error('smoke capture failed', e);
      }
      app.quit();
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  try {
    // 把后端跑起来（server.js 内部会 listen 并写端口文件）
    require(path.join(__dirname, '..', 'server.js'));
    const port = await waitForPort();
    createWindow(`http://127.0.0.1:${port}`);
  } catch (e) {
    dialog.showErrorBox('启动失败', String(e && e.message ? e.message : e));
    app.quit();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

// 退出流程要「确定地」走完：
// 后端是跑在主进程里的 http 服务，如果进程没退干净，升级安装时会被判定为
// 「应用仍在运行」而卡住安装（实测踩过）。所以这里补两道保险。
app.on('before-quit', () => {
  // destroy 而不是 close：跳过页面里的 beforeunload，不给退出流程留悬念
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
});

app.on('will-quit', () => {
  // 兜底：200ms 后无论如何结束进程；正常路径早就退了，这里不会真跑到
  setTimeout(() => process.exit(0), 200);
});
