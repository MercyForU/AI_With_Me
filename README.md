# 暧 · AI 陪伴

一个跑在自己电脑上的 AI 陪伴应用。角色有独立人格与长期记忆，数据全部留在本机，不经过任何云端。

三种形态共用同一套代码与同一套后端逻辑：

| 形态 | 技术 | 数据存在哪 | 是否需要电脑 |
| --- | --- | --- | --- |
| 网页版 | Next.js 静态导出，由自带 Node 服务托管 | 电脑 `data/app.db` | 需要（电脑就是服务器） |
| 安卓 APK | Capacitor 8 壳 + 完整前端 + 本地 SQLite | 手机沙盒内 | **不需要**，完全独立 |
| Windows 桌面版 | Electron 壳，主进程内跑同一个 Node 服务 | `%APPDATA%\暧\data` | 不需要 |

当前版本 **0.4.3**，改动记录见 [CHANGELOG.md](CHANGELOG.md)。

## 功能

**角色**

- 人设、场景、开场白、头像（图片或表情）、主色
- 每个角色可以有自己的模型，聊天窗口里切换只影响当前角色；没指定就跟随默认模型
- 角色卡导入导出（人设 + 记忆），支持多角色并存

**对话**

- 流式逐字输出、语音输入与朗读
- 连发合并：一条话拆成几段发时，先逐条上屏，等你停 2 秒再合成一轮回复
- 一键清空上下文：之后只带人设 + 召回记忆 + 新消息重新开始，历史记录不删
- 场景备注、「手记」速记，随时补一句她该记住的事

**记忆**（常驻开启，无需手动干预）

- 滑出上下文窗口的对话自动归档，归档前先由当前聊天模型总结成陈述句
- 向量 + 关键词双路召回，取最相关的 5–10 条注入，带入发生日期
- 角色可以主动调用 `memory_search` / `memory_write` / `memory_update`
- 独立记忆面板：看原文、做召回测试、逐条改写或删除、手动补写，没有条数上限

**生图**

- 角色会主动画（聊到具体画面时），被要求时一定画
- 图片先占位、后台排队生成，**不阻塞对话**；画好自动落进占位里并提示
- 点图片可全屏查看：滚轮 / 双指缩放、拖动平移、双击放大，Esc 关闭，可另存

**小游戏**

- 石头剪刀布、9×9 五子棋
- 每一手由角色按自己的性格决定，规则兜底（能赢必赢、对方要赢必堵），不会下出瞎棋
- 一局结束在聊天里留结果提示，并写一句总结归档进记忆

**圈子 / 数据 / 其他**

- 圈子：让角色根据近期对话写动态，动态也会进记忆
- 导出：角色卡（`.character.json`，人设 + 记忆）、聊天记录（`.chat.json`，可合并到任意角色）、
  完整备份（整库）。手机端写的是真文件并唤起系统分享，不是复制剪贴板
- 门禁：首次进入设称呼 + 4 位以上密码，之后只输密码
- 主题：浅色 / 深色 / 跟随系统
- 供应商：任意 OpenAI 兼容接口或 Ollama，分 chat / embedding / image / tts 四类，API Key 加密存本机

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
# 产物：dist/暧 Setup <版本号>.exe（另有 dist/win-unpacked 免安装版）
```

**只跑桌面壳不打包**：`npm run exe`

> 打包 Electron 时如果卡在「downloaded electron」，多半是下载 Electron 二进制没走通，
> 先设 `HTTPS_PROXY` 再重试。

## 目录结构

```
app/                 Next 入口（单页）+ 全局样式 + favicon
components/          UI
  App.tsx              外壳：PC 侧栏 / 移动端底部导航 / 三个 Tab
  ChatView.tsx         会话列表 + 对话、模型切换、生图占位、看图
  CharactersView.tsx   角色卡与详情
  CircleView.tsx       圈子动态
  GameHub.tsx          小游戏中心（石头剪刀布 / 五子棋）
  MemoryPanel.tsx      记忆管理面板
  ImageViewer.tsx      全屏看图
  Settings.tsx         设置（供应商 / 记忆 / 数据 / 导出导入）
  AuthGate.tsx         门禁
lib/
  api.ts             统一 API 客户端：网页走 fetch，APK 直接调 lib/local
  store.tsx          全局状态与业务动作（发送防抖、生图轮询、导出导入）
  types.ts           共享类型；characterFile.ts 角色卡 / 聊天记录文件；speech.ts 语音
  local/             手机端本地实现（与 server/ 一一对应）
    server.ts       路由
    sqlite.ts / schema.ts / data.ts   SQLite 封装、建表迁移、数据读写
    llm.ts          流式对话
    prompt.ts       系统提示词（与 server/prompt.js 同文）
    memory.ts       归档、召回、记忆工具
    games.ts        小游戏决策
    image.ts        生图与压缩
    imageQueue.ts   生图队列
    embed.ts / tokenizer.ts  本地 ONNX 嵌入
server/
  api.js             全部 HTTP 路由
  db.js              建表 + 幂等迁移
  auth.js            密码与 Cookie 会话
  llm.js             流式对话（SSE → 兜底非流式）
  providers.js       供应商解析（含角色级模型绑定）
  prompt.js          系统提示词与上下文窗口
  games.js           小游戏决策与结束总结
  image.js           调生图接口、落盘
  imageQueue.js      生图队列（占位 → 排队 → 填图）
  memory/            分块、入库、总结、召回、工具、重建
  embedding/         本地 ONNX 嵌入（node）
electron/            桌面壳（主进程内启动后端）
android/             Capacitor 安卓工程
scripts/             构建辅助：拷 ort、拉模型、导出 site
docs/                设计文档（产品计划、记忆系统）
assets/              预设角色头像等静态素材
```

`data/`、`models/`、`public/ort/`、`out/`、`site/` 都是本地生成或不含源码，已被 `.gitignore` 忽略。

## 数据与隐私

- 全部数据在 `data/app.db`；`data/.secret` 是 API Key 的加密密钥；头像在 `data/uploads/`，
  生成的聊天图在 `data/uploads/chat/`
- 备份 = 拷走 `data/` 整个目录；删掉它 = 重置一切
- 对话内容只发给你自己配置的模型供应商，不经过本项目任何服务器
- 角色卡（人设 + 记忆）与聊天记录是两个独立文件，都由你手动导出，不会自动上传

## 记忆系统

**归档**：滑出最近 16 条窗口的对话，每攒够 6 条切一次块（最多 5 条消息 / 300 token，相邻块重叠 1 条）。
切好后先让当前聊天模型把原文压成 1–3 句陈述（只留事实，去掉语气词），摘要当记忆入库，
原文留在 `raw_content` 供查看。模型不可用时自动回退原文，不会丢内容。

**召回**：每次对话都按当前这句检索一次；向量路 + 关键词路各取候选，RRF(k=60) 融合，
过滤掉「沾边但不相关」的（相似度 ≥ 0.38 且不低于头名 0.12），最终取最相关的 **5–10 条**、
约 900 token 注入 system prompt（带发生日期，让它知道「上周」是哪天）。
用户说「以前 / 上次 / 前几天 / 还记得」这类话时放宽阈值，并补上最近的记忆。

**模型主动调用**：供应商勾选「支持工具调用」后，角色会拿到三个工具 ——
`memory_search`（翻记忆）、`memory_write`（记下来）、`memory_update`（改正）。
想不起细节、对方提到旧事、或拿不准时，模型会先查再答；说了值得长期记住的事，会自己记一条。
最多连续两轮工具调用，避免绕不出来。

**管理**：角色页「记忆管理 → 打开面板」，可以看原文、做召回测试、逐条改写或删除、手动补写，没有条数上限。

详见 [`docs/记忆系统设计计划.md`](docs/记忆系统设计计划.md) 与 [`docs/架构.md`](docs/架构.md)。

## 生图流程

模型决定画图后，流程和「等图出来再说话」完全不同：

```
模型调用 generate_image / 写出 [[img: ...]]
  → 立刻插入一条占位消息（attachments[0].status = pending）
  → 对话当场结束，你可以继续发消息
  → 后台按角色排队出图（一次一张，多张依次）
  → 画好把真图写进同一条消息（status = done），前端轮询到后替换占位并提示
```

失败或应用重启时占位会显示「这张没画出来」并附原因，不会留一个永远转圈的占位。

## 更新日志

完整记录见 [CHANGELOG.md](CHANGELOG.md)，最近几个版本：

- **0.4.3** 支持「只画不说」的画图输出；恢复图片说明文字
- **0.4.3** 支持「只画不说」的画图输出；恢复图片说明文字
- **0.4.2** 修复生图提示词被当成聊天消息；兼容各种标记写法
- **0.4.3** 支持「只画不说」的画图输出；恢复图片说明文字
- **0.4.3** 支持「只画不说」的画图输出；恢复图片说明文字
- **0.4.2** 修复生图提示词被当成聊天消息；兼容各种标记写法
- **0.4.1** 看图支持缩放与拖动
- **0.4.0** 生图改成后台队列（不阻塞对话）、主动画图、看图模式
- **0.3.3** 移动端进对话收起底部 Tab、输入时滚到最新、回到底部浮标
- **0.3.2** 每个角色独立模型；小游戏结果显示在聊天里
- **0.3.1** 角色卡与聊天记录分离导出；手机端导出真文件；动态进记忆
- **0.3.0** 用户名、连发防抖、清空上下文时归档、小游戏模块化
- **0.2.0** 记忆模块重做：归档前总结、精准召回、模型可调用、独立面板

## 常见问题

**手机连不上电脑版**：Windows 防火墙没放行。右键以管理员运行 `open-firewall.bat`，或确认手机与电脑在同一 Wi-Fi。

**语音输入用不了**：浏览器只在 `localhost` 或 HTTPS 下允许录音。用局域网 IP 访问时请改用打字。

**模型下载卡住**：`npm run fetch:model` 默认走 `hf-mirror.com`，失败会回落到 `huggingface.co`。

**Gradle 卡在下载依赖**：国内直连 Google Maven 很慢，用镜像初始化脚本
`cd android && gradlew.bat assembleDebug -I mirror.init.gradle`。

**打包 Electron 时下载 Electron 二进制失败**：需要代理，设置 `HTTPS_PROXY` 后重试。

**角色说「我不会画画」/ 生图没反应**：按这三条查——
1. 聊天供应商勾了「支持工具调用」吗？没勾就只能走 `[[img: ...]]` 标记协议；
2. 有生图类（kind=image）的供应商，且 API Key 填了；
3. 生图**只用列表里第一个**生图供应商，多配了以最上面那条为准。

**Windows 安装包为什么一打开就弹 UAC**：安装方式是「为所有用户安装」（`nsis.perMachine: true`），
需要管理员权限才能写 `Program Files` 和注册表，所以启动即提权——这是有意的，
否则装到 `D:\Program Files` 这类目录会写不进去、也结束不掉正在运行的旧实例。
不想提权就直接用免安装版：`dist/win-unpacked/暧.exe`。
