# CF Workers 部署（纯 BS 一体化）

架构见 [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)；部署步骤与两种形态差异见 [`docs/DEPLOY.md`](../docs/DEPLOY.md)。服务器持有 LLM Key，朋友零配置打开即玩。

## 首次部署

```bash
# 1. 构建（顺序重要：先 build 再起 dev/deploy，assets 清单按启动时目录生成）
npm run build
node scripts/make-seed.mjs        # 人物库种子 → workers/seed.ts

# 2. 登录
npx wrangler login

# 3. 建 D1
cd workers
npx wrangler d1 create hq         # 记下 database_id，填进 wrangler.toml
npx wrangler d1 execute hq --remote --file=schema.sql

# 4. 生成本地部署配置（wrangler.toml 不入库）
cp wrangler.example.toml wrangler.toml
#    编辑 wrangler.toml：name / database_id / routes / AI_BASE_URL / AI_MODEL / ADMIN_USER
#    （对战房间的 DO 绑定与 migrations 段模板里已带，无需手加）

# 5. 注入密钥（不会写进任何文件）
npx wrangler secret put AI_API_KEY
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put SESSION_SECRET

# 6. 发布
npx wrangler deploy
```

`wrangler.toml` 含账号资源 ID、域名与实际使用的模型服务，已被 `.gitignore` 忽略；
仓库里只保留占位模板 `wrangler.example.toml`。

首次请求会自动把 184 位人物种子导入 D1（`d1.seeded` 日志）。

## 本地开发

```bash
npm run build && node scripts/make-seed.mjs
cd workers
npx wrangler d1 execute hq --local --file=schema.sql
npx wrangler dev --port 8787 --local     # 读 .dev.vars 里的本地模型配置
```

已知 Windows 坑：wrangler dev 的 assets 监视器可能报 EPERM，
**改前端后必须重启 dev**（先 `npm run build` 再启动），否则新 hash 文件名不在清单里，JS 会被 SPA 回退成 HTML。

## 更新人物库

人物数据以 D1 为准。改了 `data/characters.json` 后重新导入：

```bash
node scripts/make-seed.mjs
# seed 只在空库时生效；更新需先清空或写迁移
npx wrangler d1 execute hq --remote --command "DELETE FROM character_aliases; DELETE FROM characters;"
npx wrangler deploy   # 首个请求会重新播种
```

## 密钥边界

- `AI_API_KEY` 只存 wrangler secret，只在 Worker→LLM 一段使用
- `ADMIN_TOKEN` / `SESSION_SECRET` 同样走 secret，不写入配置文件
- 不出现在日志、响应、前端（与验收 9 一致）
- 管理后台（admin）未迁移到 Workers；人物编辑继续用本地 Node 模式

## 对局账本（对局历史）

`sessions` 只是 24h 工作状态；历史存在 `games` + `game_turns`（schema.sql 的 v6 段），
由 `d1-history.ts` 在开局 / 每问 / 状态变化时写入，与会话过期无关。

- 玩家：`GET /api/history/mine`、`GET /api/history/mine/:id`
- 管理员：`GET /api/admin/history?user=&result=&q=`、`GET /api/admin/history/:id`
- 已上线的库升级：再跑一次 `npx wrangler d1 execute hq --remote --file=schema.sql`
  （新增段都是 `CREATE TABLE IF NOT EXISTS`；v5 的 `ALTER TABLE sessions ADD COLUMN` 只需执行一次）

## 对战房间（Durable Object）

规则见 [`docs/MULTIPLAYER.md`](../docs/MULTIPLAYER.md)。每房一个 DO 实例，房间状态机是
`src/core/room/reducer.ts` 的纯函数，`room-do.ts` 只做 IO（WS、storage、模型调用、alarm、账本）。

绑定与迁移已写进 `wrangler.example.toml`，按模板复制即含这两段：

```toml
[[durable_objects.bindings]]
name = "ROOMS"
class_name = "RoomDo"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RoomDo"]     # SQLite 版 DO，免费档可用
```

如果是从**旧模板**升级来的 `wrangler.toml`（没有这两段），手动补上后再 `deploy`；
`migrations.tag = "v1"` 保持不变——这是 DO 类的首次登记，不是版本号。

数据表在首次部署时随 `schema.sql` 一起建好；**已上线的旧库**补一次表结构
（`ALTER` 不可重复执行，所以单独放一个文件）：

```bash
cd workers
npx wrangler d1 execute hq --remote --file=migrations/v8-rooms.sql
npx wrangler deploy
```

部署成功的标志：`wrangler deploy` 输出的绑定清单里出现 `env.ROOMS (RoomDo)`。

接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/rooms` | 大厅列表（D1 `rooms` 目录，只列 lobby/playing 且 `listed=1`） |
| POST | `/api/rooms` | 建房，返回快照（含 `code`） |
| POST | `/api/room/:code/join` | 加入：lobby 阶段是参赛者，playing/finished 阶段是观战者 |
| GET | `/api/room/:code` | 快照（首屏 / 重连 / 轮询降级） |
| POST | `/api/room/:code/cmd` | 与 WS 上行同一 dispatch（降级通道） |
| WS | `/api/room/:code/ws` | 主通道（Hibernation API） |

身份只从会话 cookie 解析，再以 `x-hq-user-id` 注入 DO；DO 不信任客户端自称的身份。

数据分工：实时状态在 DO storage；`rooms` 只做大厅目录；结算时每位参赛者写一条
`games` 行（带 `room_id` / `finish_rank`），逐条问答进 `game_turns`——所以对战局在
"我的历史"和管理后台里与单人局同样可查，观战者不落账。
