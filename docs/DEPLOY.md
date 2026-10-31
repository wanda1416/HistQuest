# 部署手册

> 两种运行形态：**本地 Node**（开发 / 自托管，全功能含管理后台）与
> **CF Workers**（线上形态 `cailishi.wyxj.net`，含对战）。
> 架构差异一览见 [`ARCHITECTURE.md`](ARCHITECTURE.md) §6。

---

## 0. 两种形态能力差异

先看这张表再决定部署哪种：

| 能力 | 本地 Node | CF Workers |
|---|---|---|
| 单人游戏 | ✅ | ✅ |
| 对战（2–8 人） | ❌（房间路由在 Workers 侧） | ✅ |
| 管理后台（人物增删改 / 健康检查 / 备份 / 用户管理） | ✅ 全功能 | ❌ 未迁移 |
| 账号系统 | ✅（空库第一个注册者自动成为管理员） | ✅（预置管理员 + 邀请码） |
| 设置云端同步（vault） | ✅ | ✅ |
| 存储位置 | 本机 `data/hq.db`（SQLite） | Cloudflare D1 |
| 费用 | 仅有 LLM token | 免费档够朋友规模 + LLM token |

混合做法：日常在 CF 玩（对战 + 零配置）；需要改人物库时在本地起 Node 模式
改完再 `npm run deploy` 同步上去（人物库以 D1 为准，见 §2.5）。

---

## 1. 本地 Node 模式

需要 Node.js ≥ 23.4（原生类型擦除 + 内置 `node:sqlite`，零编译）。

```bash
npm install
npm run dev          # 服务端 :3000 + 前端 :5173（HMR）；或直接双击 dev.cmd / ./dev.sh
```

打开 http://127.0.0.1:3000 。首次进入会要求填模型地址与密钥（BYOK，
存浏览器 localStorage），点"测试连接"通过后即可开局。

生产模式（单进程同时供 API 与静态资源）：

```bash
npm run build && npm start
```

### 1.1 配置（`.env`，复制 `.env.example`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `3000` / `127.0.0.1` | 手机局域网访问时 HOST 改 `0.0.0.0` |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | 空 | 服务端凭据；填了则登录用户可用站方 Key（受配额约束），不填则只能 BYOK |
| `AI_TEMPERATURE` / `AI_TIMEOUT_MS` | `0.1` / `6000` | 超时的那次提问不计次数 |
| `SOLO_TURNS` | `50` | 单人提问次数上限（每局 10–此值自选） |
| `SESSION_SECRET` | 空 | 留空自动生成存库，重启不掉登录 |
| `ADMIN_USER` / `ADMIN_PASSWORD` | 空 | 预置管理员；留空时空库第一个注册者自动成为管理员 |
| `ADMIN_TOKEN` | 空 | 远程访问管理接口的令牌；留空只允许本机 |
| `ADMIN_BACKUP_KEEP` | `20` | 后台保存前备份保留份数 |
| `DAILY_QUOTA` | `500` | 站方 Key 每日提问上限（后台可按账号覆盖） |
| `HQ_DB` | `data/hq.db` | SQLite 路径 |
| `HQ_STORE` | `sqlite` | `json` 回滚到无账号模式 |

模型地址填域名即可，结尾带不带 `/v1` 都认。

### 1.2 管理后台

`http://127.0.0.1:3000/admin.html`（生产模式 `/admin` 会重定向过去）。
人物库编辑、数据健康、对局历史（全部玩家）、用户与邀请码、导出。
访问控制：默认只允许本机；远程需 `ADMIN_TOKEN`（`Authorization: Bearer`），
且所有管理请求必须带 `X-HQ-Admin: 1` 头。写入流程：校验 → 备份 → 原子写 → 热替换索引。

---

## 2. CF Workers 模式（线上形态）

需要 `wrangler login`（一次性）。

### 2.1 首次部署清单

```bash
# 1. 构建（顺序重要：assets 清单按启动时目录生成，先 build 再 deploy）
npm run build
node scripts/make-seed.mjs        # 人物库 → workers/seed.ts

# 2. 建 D1
cd workers
npx wrangler d1 create hq                       # 记下 database_id
npx wrangler d1 execute hq --remote --file=schema.sql

# 3. 配置（wrangler.toml 不入库，从模板复制）
cp wrangler.example.toml wrangler.toml
#    填：name / database_id /（可选）routes 域名 / AI_BASE_URL / AI_MODEL / ADMIN_USER
#    对战的 DO 绑定与 migrations 段模板里已带，无需手加

# 4. 密钥（绝不写进任何文件）
npx wrangler secret put AI_API_KEY       # 站方 LLM Key
npx wrangler secret put SESSION_SECRET   # 会话签名（必填，否则账号系统禁用）
npx wrangler secret put ADMIN_PASSWORD   # 预置管理员口令
#    ADMIN_TOKEN（可选，远程管理接口用）

# 5. 发布
npx wrangler deploy
#    成功标志：绑定清单里出现 env.ROOMS (RoomDo)
```

首次请求会自动把 184 位人物种子导入 D1（日志 `d1.seeded`）。

### 2.2 升级已上线的环境

```bash
npm run deploy        # 一键：build → 种子 → 迁移检查 → deploy → 冒烟
```

手工等价流程：

```bash
npm run build
node scripts/make-seed.mjs
cd workers
npx wrangler deploy
```

### 2.3 D1 迁移对照表

`schema.sql` 是**全量建库**（含全部版本段），只用于全新 D1。
已上线的库用 `workers/migrations/` 下的**增量**文件——`ALTER TABLE` 不可重复执行。

| 你的库状态 | 执行 |
|---|---|
| 全新 D1 | `schema.sql`（一次） |
| 上线于「对战上线之前」（无 `rooms` 表） | `migrations/v8-rooms.sql`（一次） |
| 不确定 | `npx wrangler d1 execute hq --remote --command "SELECT name FROM sqlite_master WHERE type='table'"` —— 没有 `rooms` 表就跑 v8 |

`npm run deploy` 会自动检查 `rooms` 表是否存在并提示，不需要记这张表。

### 2.4 密钥边界

`AI_API_KEY` / `SESSION_SECRET` / `ADMIN_PASSWORD` / `ADMIN_TOKEN` 只存
wrangler secret，只在 Worker→LLM（或会话签名）时使用，不进配置文件、日志、响应、前端。
后台「LLM 服务商设置」改的配置落 D1 `app_settings` 并**优先于** env secret
（用于不改密钥就换模型端点）。

### 2.5 人物库更新

人物数据以 D1 为准。改了 `data/characters.json` 后：

```bash
node scripts/make-seed.mjs
# seed 只在空库时生效；更新需先清空再播种：
npx wrangler d1 execute hq --remote --command "DELETE FROM character_aliases; DELETE FROM characters;"
npx wrangler deploy   # 首个请求重新播种
```

大规模改库建议在本地 Node 模式的管理后台里做（有校验与备份），再走上面的清空重播种。

### 2.6 已知坑

- **改前端后必须重新 `npm run build`** 再 deploy：assets 清单按启动时目录生成，
  新 hash 文件名不在清单里会被 SPA 回退成 HTML（表现为"部署了但页面没变"）
- Windows 下 `wrangler dev` 的 assets 监视器可能报 EPERM；`wrangler dev` 本地调试
  需要先 `npx wrangler d1 execute hq --local --file=schema.sql`（本地 D1 是独立的一份）
- workers.dev 域名在大陆访问不稳定，建议绑定自定义域（`routes` 段）
- `wrangler dev` / `deploy` 需要能起子进程；在某些沙箱环境会被拦（本机终端没有此问题）

---

## 3. 验证部署

```bash
# 结构冒烟（不耗模型额度）
node -e "fetch('https://你的域名/api/meta').then(r=>r.json()).then(j=>console.log(j.characterCount, j.serverModelReady))"
# 期望：184 true

# 对战全链路（会建房、注册测试账号、真调模型；对线上跑）
node scripts/verify-race-api.mjs     # HTTP 通道 28 项
node scripts/verify-race-ws.mjs      # WebSocket 通道 18 项
node scripts/verify-race-ui.mjs      # 真实浏览器四屏 23 项（headless Edge ×2 玩家）

# 单人全流程（需要 HQ_BASE/HQ_KEY/HQ_MODEL 指向一个真模型）
node scripts/verify-ui.ts
```

---

## 4. 语音识别（ASR，可选）

服务端配了 ASR 模型后，单人局与对战局的提问框会出现 🎤「按住说话」按钮；
识别出的文字填进输入框，由玩家确认后提交（语音只是输入法，不直接进 ask）。

走 **OpenAI 兼容 `/v1/audio/transcriptions`**（Whisper 系事实标准），
下列服务商任选其一，模型名填进配置即可：

| 服务商 | 模型名示例 | 大陆可达 | 说明 |
|---|---|---|---|
| 硅基流动 | `SenseVoiceSmall`（免费档）/ `FunAudioLLM/SenseVoiceSmall` | ✅ | 注册即送额度，中文效果好，推荐首选 |
| 阿里云百炼 | `paraformer-v2` | ✅ | 有新人免费额度 |
| Groq | `whisper-large-v3-turbo` | ❌ 需代理 | 免费额度 + 极快 |
| 自建 | faster-whisper / SenseVoice | ✅ | 一次部署零边际成本 |

### Workers 配置

```bash
# 最简：聊天与识别用同一家（同一个 baseURL/apiKey）
#   wrangler.toml [vars] 加：
AI_ASR_MODEL = "SenseVoiceSmall"

# 聊天与识别分开（比如聊天用 DeepSeek、识别用硅基流动）：
AI_ASR_MODEL = "SenseVoiceSmall"
#   另注入 secret（优先于 LLM 的 key/baseURL）：
npx wrangler secret put AI_ASR_BASE_URL   # https://api.siliconflow.cn/v1
npx wrangler secret put AI_ASR_API_KEY    # 硅基流动的 key
```

### 本地 Node 配置（`.env`）

```bash
AI_ASR_MODEL=SenseVoiceSmall
AI_ASR_BASE_URL=https://api.siliconflow.cn/v1   # 可选，默认复用 AI_BASE_URL
AI_ASR_API_KEY=sk-xxx                            # 可选，默认复用 AI_API_KEY
```

配置生效后 `/api/meta` 的 `asrReady` 变 `true`，前端按钮自动出现；
不配置则一切如旧（按钮隐藏，无任何多余请求）。

**行为约定**：一次识别扣一次当日配额（与提问同额度）；音频即弃不存；
识别文字进输入框可改可删，复盘账本记最终提交的文本。浏览器侧优先用
Web Speech API（Chromium 原生流式，大陆不稳定，失败自动落到上面的服务端方案）。

---

## 5. 环境变量对照（Node `.env` ↔ Workers）

| 作用 | Node（.env） | Workers（wrangler.toml `[vars]` / secret） |
|---|---|---|
| LLM 地址 / 模型 | `AI_BASE_URL` / `AI_MODEL` | `[vars]` 同名 |
| LLM Key | `AI_API_KEY` | secret `AI_API_KEY` |
| 会话密钥 | `SESSION_SECRET`（可留空自动生成） | secret `SESSION_SECRET`（必填） |
| 预置管理员 | `ADMIN_USER` / `ADMIN_PASSWORD` | `[vars] ADMIN_USER` + secret `ADMIN_PASSWORD` |
| 远程管理令牌 | `ADMIN_TOKEN` | secret `ADMIN_TOKEN` |
| 单人轮次上限 | `SOLO_TURNS` | `[vars] SOLO_TURNS` |
| 每日配额 | `DAILY_QUOTA` | `workers/quota.ts` `DEFAULT_DAILY`（改代码） |
| 本地 dev 模型 | 同 `.env` | `workers/.dev.vars`（wrangler dev 专用，不入库） |
