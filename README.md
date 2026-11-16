# 暧 · AI 陪伴

一个跑在自己电脑上的 AI 陪伴应用。角色有独立人格与长期记忆，数据全部留在本机，不经过任何云端。

三种形态共用同一套代码与同一套后端逻辑：

| 形态 | 技术 | 数据存在哪 | 是否需要电脑 |
| --- | --- | --- | --- |
| 网页版 | Next.js 静态导出，由自带 Node 服务托管 | 电脑 `data/app.db` | 需要（电脑就是服务器） |
| 安卓 APK | Capacitor 8 壳 + 完整前端 + 本地 SQLite | 手机沙盒内 | **不需要**，完全独立 |
| Windows 桌面版 | Electron 壳，主进程内跑同一个 Node 服务 | `%APPDATA%\暧\data` | 不需要 |

## 功能

- **角色**：人格、场景、开场白、头像（图片或表情）、主色，可导出/导入角色卡（.json）
- **对话**：流式逐字输出、模型热切换、语音输入与朗读、约一局石头剪刀布
- **记忆**：常驻开启。滑出上下文窗口的对话自动压成块，向量 + 关键词双路召回，设置里可逐条查看与改写
- **圈子**：让角色根据近期对话写动态
- **门禁**：首次进入设称呼 + 4 位以上密码，之后只输密码
- **主题**：浅色 / 深色 / 跟随系统
- **供应商**：任意 OpenAI 兼容接口或 Ollama，分 chat / embedding / image / tts 四类，API Key 加密存本机

## 技术栈

- Next.js 15 + React 19 + TypeScript + Tailwind CSS（`app/`、`components/`、`lib/`）
- 后端零框架：`node:http` 手写路由（`server/`），SQLite 用 Node 内置的 `node:sqlite`
- 嵌入模型：`bge-small-zh-v1.5` INT8 ONNX（512 维），电脑端 `onnxruntime-node`、手机端 `onnxruntime-web`
- 手机端本地实现：`lib/local/*`，用 `@capacitor-community/sqlite`，与电脑端表结构一致

## 快速开始

```bash
npm install
npm run setup:assets   # 首次：拷 ort wasm + 下载嵌入模型（约 24MB，走 hf-mirror）
npm run build          # next build，产物同步到 site/
npm start              # http://localhost:7788
```

Windows 上更省事：双击 `start.bat`，它会检查 Node、装依赖、构建、放行防火墙、启动并打开浏览器。

> 环境要求：**Node.js 22.5 或更高**（`node:sqlite` 是内置模块，低版本没有）。
> 想让手机连电脑版，第一次会弹 UAC 请求放行防火墙（`open-firewall.bat`）。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `7788` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址，只想本机访问就设 `127.0.0.1` |
| `DB_PATH` | `data/app.db` | 数据库路径 |

## 打包

产物不要提交，构建完拷到仓库外的 `../releases/`（见根目录 `00-目录说明.md`）。

**安卓 APK**（需要 Android SDK，`android/local.properties` 里配 `sdk.dir`）

```bash
npm run apk
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

**Windows 安装包**

```bash
npm run dist
# 产物：dist/暧 Setup 0.1.0.exe（另有 dist/win-unpacked 免安装版）
```

**只跑桌面壳不打包**：`npm run exe`

## 目录结构

```
app/                 Next 入口（单页）+ 全局样式 + favicon
components/          UI：Shell/聊天/角色/圈子/设置/门禁
lib/
  api.ts             统一 API 客户端：网页走 fetch，APK 直接调 lib/local
  store.tsx          全局状态与业务动作
  local/             手机端本地实现（SQLite、嵌入、LLM、记忆、服务端路由）
  memory/            分块与索引的公共类型
server/
  api.js             全部 HTTP 路由
  db.js              建表 + 幂等迁移
  auth.js            密码与 Cookie 会话
  llm.js             流式对话（SSE → 兜底非流式）
  prompt.js          系统提示词与上下文窗口
  memory/            分块、入库、召回、重建
  embedding/         本地 ONNX 嵌入（node）
electron/            桌面壳（主进程内启动后端）
android/             Capacitor 安卓工程
scripts/             构建辅助：拷 ort、拉模型、导出 site
docs/                设计文档（架构、记忆系统）
assets/              预设角色头像等静态素材
```

`data/`、`models/`、`public/ort/`、`out/`、`site/` 都是本地生成或不含源码，已被 `.gitignore` 忽略。

## 数据与隐私

- 全部数据在 `data/app.db`；`data/.secret` 是 API Key 的加密密钥；头像在 `data/uploads/`
- 备份 = 拷走 `data/` 整个目录；删掉它 = 重置一切
- 对话内容只发给你自己配置的模型供应商，不经过本项目任何服务器
- 角色卡导出（含人格、场景、记忆、聊天记录）由你手动触发，不会自动上传

## 记忆系统

滑出最近 16 条窗口的对话，每攒够 6 条压成一个块（最多 5 条消息 / 300 token，相邻块重叠 1 条）。
每块算一份 512 维向量写入库，同时进 FTS。召回时向量路与关键词路各取候选，用 RRF(k=60) 融合，
再按「绝对相似度 ≥ 0.38 且不低于头名 0.12」过滤，避免沾边就注入。

详见 [`docs/记忆系统设计计划.md`](docs/记忆系统设计计划.md) 与 [`docs/架构.md`](docs/架构.md)。

## 常见问题

**手机连不上电脑版**：Windows 防火墙没放行。右键以管理员运行 `open-firewall.bat`，或确认手机与电脑在同一 Wi-Fi。

**语音输入用不了**：浏览器只在 `localhost` 或 HTTPS 下允许录音。用局域网 IP 访问时请改用打字。

**模型下载卡住**：`npm run fetch:model` 默认走 `hf-mirror.com`，失败会回落到 `huggingface.co`。

**Gradle 卡在下载依赖**：国内直连 Google Maven 很慢，用镜像初始化脚本
`cd android && gradlew.bat assembleDebug -I mirror.init.gradle`。

**打包 Electron 时下载 Electron 二进制失败**：需要代理，设置 `HTTPS_PROXY` 后重试。

**Windows 安装包为什么一打开就弹 UAC**：安装方式是「为所有用户安装」（`nsis.perMachine: true`），
需要管理员权限才能写 `Program Files` 和注册表，所以启动即提权——这是有意的，
否则装到 `D:\Program Files` 这类目录会写不进去、也结束不掉正在运行的旧实例。
不想提权就直接用免安装版：`dist/win-unpacked/暧.exe`。
