# 架构总览

> 描述**当前**的代码结构与运行形态。历史决策与取舍见 [`DECISIONS.md`](DECISIONS.md)，
> 部署步骤见 [`DEPLOY.md`](DEPLOY.md)，对战规则与协议见 [`MULTIPLAYER.md`](MULTIPLAYER.md)。

---

## 1. 分层

```
┌────────────────────────────────────────────────────────────┐
│ client/  Vite + TS + 原生 DOM（无框架）                      │
│   单人：views.ts / main.ts / store.ts                       │
│   对战：room-views.ts / room-app.ts / live.ts               │
│   共用：route.ts（hash 路由）/ net.ts / format.ts / vault.ts │
└─────────────┬──────────────────────────────────────────────┘
              │ fetch + WebSocket（类型全部来自 shared/）
┌─────────────▼──────────────────────────────────────────────┐
│ server/ + workers/  两种运行形态，同一套 core                │
│   Node:    express 路由 + SQLite（管理后台全功能）           │
│   Workers: bundle.ts 路由 + D1 + Durable Object（线上形态）  │
└─────────────┬──────────────────────────────────────────────┘
┌─────────────▼──────────────────────────────────────────────┐
│ core/  ★ 纯逻辑、零 IO —— 不 import fs/http/ws              │
│   单人判定：precheck → answerer（模型）→ judge（索引裁定朝代）│
│            → phraser → engine（runAsk 编排）                 │
│   对战状态机：room/reducer（纯函数）+ room/project（三视角投影）│
│            + room/review（破甲标记）                         │
│   人物索引：index（抽样/资料卡/朝代归一）+ dynasty            │
└─────────────┬──────────────────────────────────────────────┘
┌─────────────▼──────────────────────────────────────────────┐
│ ai/  OpenAI 兼容 /chat/completions（超时/重试/JSON 打捞）     │
│ shared/  前后端共享类型：domain.ts / protocol.ts / room.ts    │
└────────────────────────────────────────────────────────────┘
```

**分层规则**

| 层 | 允许依赖 | 禁止 |
|---|---|---|
| `shared/` | 无 | 任何运行时 |
| `core/` | `shared/`、`ai/` 的类型 | `fs` / `http` / `ws` / DOM |
| `ai/` | `shared/` | DOM、Node 专属 API（fetch/AbortController 两端都有） |
| `server/` | 以上全部 + `node:*` | DOM |
| `workers/` | 以上全部 + Workers API | `node:*`（`nodejs_compat` 只兜底小范围） |
| `client/` | `shared/` 类型 | `node:*`、服务端模块 |

两端共用的 `server/` 文件（`history.ts` / `dto.ts` / `sessions.ts` 的类型与投影）
**禁止 import `node:*`**——workers 的 tsconfig 按文件挑 include，Node 专属模块
（`solo.ts` / `auth.ts` / `db.ts`…）不在其中。

---

## 2. 判定链路（单人）

**知识优先**：模型用自己的历史知识回答，人物资料卡只作校对锚点。

```
runAsk(question, target)
 ├─ precheck          空 / 超长 / 控制字符 → 提示改法，不扣次数
 ├─ detectNonBinary   选择句 / 开放句 → 给改法，0 调用
 ├─ SUBJECTIVE_RE     伟大 / 厉害… → 固定话术，0 调用
 └─ modelAnswer       一次调用 = 理解 + 作答（返回受控 JSON）
      ├─ guessMatches 复核：玩家在提问中点名 → 直接结算（won）
      └─ extractDynasty + judgeByIndex
                      唯一强制覆盖：朝代按严格史学分期由索引裁定
                      （用「问句里的朝代」比对，不是模型返回的值）
 ├─ scrub             输出去名：回答/口径里出现姓名或别称 → 替换
 └─ phraser           guided 模式补判定口径（确定性生成，不加调用）
```

| 问句 | 模型调用 |
|---|---|
| 常规问题 | 1 |
| 主观 / 问法不对 / 空或超长 | 0 |
| 非法 JSON | 2（重试一次，失败不计次数） |

**回答模式**（开局选定，整局不可变）：`strict` 只给是/否/无法判断；
`guided` 另补一句判定口径——口径不得透露未被问到的信息，含目标名即丢弃。

**朝代按史学分期，不按民间印象**：曹操卒于 220 年，三国始于同年曹丕称帝，
所以问"他是三国人物吗"答**否**。数据（`polity`/`polityAlt`）、判定、解说口径三处对齐。

**每问上下文不带历史**：每问独立单条调用（资料卡 + 当前问题）。判定独立性、
泄题面最小、成本恒定；重复问法由答案缓存短路（对战房间内跨玩家共享同一份缓存）。

---

## 3. 对战状态机

规则全文见 [`MULTIPLAYER.md`](MULTIPLAYER.md)。实现分三层：

```
shared/room.ts        协议：Room / RoomEvent / RoomCommand / RoomSnapshot + 常量
core/room/reducer.ts  applyEvent(room, event, now) → { room, effects }   ★纯函数
core/room/project.ts  projectRoom(room, viewerId, now, {target}) → 白名单快照
core/room/review.ts   flagHistory / sessionNotes（破甲可疑标记，纯正则）
workers/room-do.ts    Durable Object：只做 IO（WS 收发、storage、模型调用、
                      alarm 清理、D1 目录与账本）；规则全部委托 reducer
```

**为什么 reducer 是纯函数**：抢答并发、投票动态分母、掉线、晚到结果……这些竞态
用真实 DO 极难复现；纯函数 + 假时钟让每一种竞态都是一条可重复的测试
（`test/room.test.ts` 34 条 + `test/room-worker.test.ts` DO 进程内集成 4 条）。

**effects 是显式清单**，DO 只执行不决策：
`broadcast`（给每个连接发个性化快照）/ `call-ask`（出房间调模型）/
`archive`（结算写 D1）/ `close`。

**投影是唯一泄题面关口**：对手视角与观战者视角的快照里**物理上不存在**
`question` / `verdict` / `text` 字段——白名单生成，不是"删敏感字段"。
`test/room.test.ts` 有专门的泄题断言：任意对手/观战者视角的 JSON 序列化后
搜不到他人问题原文，也搜不到 `targetId` 与人物名。

---

## 4. 数据模型

四张核心表，按"工作状态 vs 永久账本"分工：

| 表 | 角色 | 生命周期 |
|---|---|---|
| `characters` + `character_aliases` | 人物库（184 位，含软删除 `retired`） | 永久；后台编辑热替换索引 |
| `sessions` | 单人「接着打」的工作状态 | 24h 过期，可整行覆盖重写 |
| `games` + `game_turns` | **对局账本**：一局一行、一问一行 | 只追加；会话清了历史还在 |
| `rooms` | 对战**目录**（大厅列表 + 复盘索引） | 房间实时状态不在这（在 DO storage） |
| `users` / `invites` | 账号：PBKDF2 口令、邀请码、每日配额 | 永久 |
| `app_settings` | 会话密钥（Node）、后台改的 LLM 覆盖配置 | kv |

**写入口只有一个**：`SoloStore` 在开局/每问/状态变化时调 `GameRecorder`
（`server/history.ts` 定义接口），Node 是 `SqliteHistoryStore`，Workers 是
`D1HistoryStore`——共用同一份 SQL 常量（`UPSERT_GAME_SQL` / `INSERT_TURN_SQL`）
与行投影（`rowToSummary` / `rowToTurn`），保证两端历史逐字段一致。

对战落账复用同一张 `games` 表：**每位参赛者一条 `games` 行**，带
`room_id` / `finish_rank`，逐条问答照常进 `game_turns`——于是"我的历史"、
管理后台、导出全部零改动可用。观战者不落账。

**结局判定是推导值不落冗余**：`result = won | lost | abandoned | playing`。
对战局额外带 `finishRank`，前端据此显示「对战 · 第 N 名」而不是让人困惑的"放弃"。

**泄题面约束（两端一致）**：
- 进行中的局，任何下行（对局接口、历史、后台）都不带 `targetId` / 目标名
- 对局中的问答记录不含 `basis` / `calls` / `query`（揭晓后才有，供复盘）
- `server/dto.ts` 的 `findForbiddenKeys` 是测试辅助：扫描响应体里禁止出现的键

---

## 5. 账号与配额

- 口令 PBKDF2-SHA256；会话是 HMAC 签名的 HttpOnly cookie（`core/session-token.ts`），
  无状态验证，天然支持 Workers 多 isolate
- 邀请码注册；Node 空库的第一个注册者直接成为管理员（本地自托管免邀请码）
- **站方 Key 边界**：只有 `allow_server_key=1` 且当日配额未用尽的登录账号能用；
  BYOK 不受限也不计次；游客只能 BYOK。配额原子扣减（`UPDATE … RETURNING`，跨日清零）
- 对战走同一条配额：房间里每问一次照样扣站方 Key 的当日额度

---

## 6. 两种运行形态

| | 本地 Node（`npm start`） | CF Workers（线上形态） |
|---|---|---|
| 入口 | `src/server/index.ts`（express） | `workers/bundle.ts`（手写路由） |
| 存储 | `node:sqlite`（`data/hq.db`） | D1 + Durable Object（SQLite storage） |
| 静态资源 | `express.static(dist)` | Workers Assets 绑定 |
| 人物库读写 | fs JSON ↔ SQLite，后台全功能（增删改/健康检查/备份） | D1，只读为主（后台未迁移） |
| 对战 | **不可用**（无 DO；房间路由在 Workers 侧） | DO `RoomDo`，每房一实例 |
| 会话密钥 | 留空自动生成存 `app_settings` | 必须配 `SESSION_SECRET` secret |
| 首个账号 | 空库第一个注册者 = 管理员 | 预置 `ADMIN_USER/PASSWORD` |

配置项清单见 [`DEPLOY.md`](DEPLOY.md)。

---

## 7. 前端结构

Hash 路由（`route.ts`），地址栏即事实——刷新、粘贴链接、换设备都从地址栏还原：

```
#/            单人首页（开局表单）      #/rooms            对战大厅
#/game/<id>   单人对局                 #/room/<code>      对战房间（集合）
#/reveal/<id> 单人揭晓                 #/race/<code>      对战进行中
#/history     我的对局历史              #/review/<code>    对战复盘
#/setup       模型配置 / 设置同步       #/auth             登录/注册
```

状态管理是极简订阅式：`store.ts` 一个全局 `State` + `setState(patch)` 触发全量
重渲染（`render()` 按 view 选 `renderApp`（单人）或 `renderRoomApp`（对战））。
量级不到需要框架的程度；Vite 在位，将来要增量引入 React 也不必推翻。

对战实时通道（`live.ts`）：WS 主通道 + 10s 心跳 + 指数退避重连；连续两次失败
**自动降级为 1.5s 轮询**（上行改 `POST /cmd`，与服务端 WS 共用同一份 dispatch），
轮询期间仍定期重试 WS，连上自动切回。UI 右上角实时显示当前通道（实时/轮询）。

---

## 8. 测试

247 项，全部离线可跑（`npm test`，模型是 `test/fixtures/mock-llm.ts` 假服务器）：

| 文件 | 覆盖 |
|---|---|
| `judge.test` / `world.test` | 朝代裁定、别名录、世界人物（表驱动） |
| `engine.test` | runAsk 全链路（mock LLM，含超时/坏 JSON/点名猜中） |
| `solo.test` / `route.test` / `acceptance.test` | 单人状态机、hash 路由、无模型不可开局 |
| `dto.test` / `history-view.test` | 泄题面扫描、历史界面渲染 |
| `history.test` / `store.test` / `settings.test` / `vault.test` | 账本读写、本地/SQLite 存储、设置加密同步 |
| `auth.test` / `admin.test` | 账号、邀请码、管理接口 |
| `room.test` | **对战状态机 34 条**：竞态/投票/观战/泄题断言 |
| `room-worker.test` | **DO 进程内集成 4 条**：真跑建/开/问/投/落账 + 驱逐恢复 |
| `workers-api.test` | Workers 路由离线集成（`node:sqlite` 冒充 D1） |
| `live.test` | 真模型集成（默认跳过，`HQ_LIVE=1` 开启） |

浏览器冒烟（真实浏览器，headless Edge）：
`scripts/verify-ui.ts`（单人全流程）、`verify-router.ts`（地址栏还原）、
`verify-race-ui.mjs`（对战四屏，对线上跑）。API/WS 线上冒烟：
`verify-race-api.mjs` / `verify-race-ws.mjs`。

---

## 9. 已知边界（读代码前先知道）

- `workers/tsconfig.json` 按**文件**挑 include：给 `server/` 新增两端共用模块时
  必须同步登记，漏了会编译报错——这是刻意为之的防呆（禁 Node API），不是疏漏
- 管理后台只在本地 Node 形态可用（`admin.html` + `/api/admin/*` 全在 express 侧；
  Workers 只保留了只读的人物库与健康检查所必需的部分）
- 答案缓存（单人 `SoloStore`、对战 `RoomDo` 各一份）按
  `targetId::归一化问句` 键共享；后台改人物资料会调 `reloadIndex` 清缓存
- 抛错类模型失败（AUTH / NETWORK / UNSUPPORTED）不入账本——那一问在客户端直接报错；
  只有 TIMEOUT / BAD_JSON / EMPTY 会以 transient 留痕。要统计"模型挂了几次"需另建失败事件表
